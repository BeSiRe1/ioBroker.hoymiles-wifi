'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Daily,day,nextMidnight}=require('../lib/daily');
const {Runtime}=require('../lib/runtime');
const {Publisher}=require('../lib/publisher');
const stamp=text=>Date.parse(text);
const noon=stamp('2026-11-07T12:00:00+01:00');
const observation=(time,pvSum)=>({startedAt:time,receivedAt:time,pvSum});
const proof=(time,energy)=>({start:time-1000,receivedAt:time,energy});
test('Berlin dates and midnight schedules handle normal days and both DST transitions',()=>{
  assert.equal(day(stamp('2026-11-06T23:00:00Z')),'2026-11-07');
  const cases=[['2026-11-07T00:00:00+01:00','2026-11-08T00:00:00+01:00',24],['2026-03-29T00:00:00+01:00','2026-03-30T00:00:00+02:00',23],['2026-10-25T00:00:00+02:00','2026-10-26T00:00:00+01:00',25]];
  for(const [start,end,hours]of cases){assert.equal(nextMidnight(stamp(start)),stamp(end));assert.equal((stamp(end)-stamp(start))/3600000,hours);}
});
test('first positive total and PV values require current-day history confirmation',()=>{
  const daily=new Daily(noon);const values={'grid.dailyEnergy':1,'pv0.dailyEnergy':0.6,'pv1.dailyEnergy':0.4};
  daily.receive(values,noon,observation(noon,1));assert.equal(daily.values()['grid.dailyEnergy'],0);assert.equal(daily.confirmed(),false);
  daily.receive(values,noon,observation(noon,1),proof(noon,1));assert.equal(daily.values()['grid.dailyEnergy'],1);assert.equal(daily.confirmed(),true);
});
test('midnight resets total and all PV counters offline, replayed previous-day values stay blocked',()=>{
  const daily=new Daily(noon),values={'grid.dailyEnergy':1,'pv0.dailyEnergy':0.6,'pv1.dailyEnergy':0.4};
  daily.receive(values,noon,observation(noon,1),proof(noon,1));
  const tomorrow=stamp('2026-11-08T00:00:00+01:00');daily.roll(tomorrow);
  assert.deepEqual(daily.values(),{'grid.dailyEnergy':0,'pv0.dailyEnergy':0,'pv1.dailyEnergy':0});assert.equal(daily.confirmed(),false);
  daily.receive(values,tomorrow,observation(tomorrow,1));assert.equal(daily.values()['grid.dailyEnergy'],0);
  daily.receive({'grid.dailyEnergy':0.2,'pv0.dailyEnergy':0.1,'pv1.dailyEnergy':0.1},tomorrow,observation(tomorrow,0.2));
  assert.equal(daily.values()['grid.dailyEnergy'],0.2);assert.equal(daily.confirmed(),true);
  daily.receive(values,tomorrow,observation(tomorrow,1));assert.equal(daily.values()['grid.dailyEnergy'],0.2);
});
test('restart preserves confirmed counters, missed midnight is caught up and in-day regressions are ignored',()=>{
  const daily=new Daily(noon);daily.receive({'grid.dailyEnergy':1},noon,observation(noon),proof(noon,1));
  const restored=new Daily(noon+1000,JSON.parse(daily.serialize()));assert.equal(restored.values()['grid.dailyEnergy'],1);
  restored.receive({'grid.dailyEnergy':0},noon+1000,observation(noon+1000));assert.equal(restored.values()['grid.dailyEnergy'],1);
  const next=new Daily(stamp('2026-11-08T09:00:00+01:00'),JSON.parse(restored.serialize()));assert.equal(next.values()['grid.dailyEnergy'],0);assert.equal(next.state.counters['grid.dailyEnergy'].boundary,1);
});
test('a request started before midnight cannot overwrite the new day',()=>{
  const daily=new Daily(noon);daily.receive({'grid.dailyEnergy':1},noon,observation(noon),proof(noon,1));
  const after=stamp('2026-11-08T00:00:01+01:00');
  daily.receive({'grid.dailyEnergy':0.3},after,{startedAt:after-2000,receivedAt:after});assert.equal(daily.values()['grid.dailyEnergy'],0);
});
test('old or future history cannot confirm a positive day value, valid zero is safe',()=>{
  for(const history of [proof(noon-400000,1),{...proof(noon,1),start:noon+1},{...proof(noon,1),start:stamp('2026-11-06T12:00:00+01:00')}]){
    const daily=new Daily(noon);daily.receive({'grid.dailyEnergy':1},noon,observation(noon),history);assert.equal(daily.confirmed(),false);
  }
  const daily=new Daily(noon);daily.receive({'grid.dailyEnergy':0},noon,observation(noon));assert.equal(daily.confirmed(),true);
});
test('unchanged values do not churn storage; malformed or future storage is rejected',()=>{
  const daily=new Daily(noon);daily.receive({'grid.dailyEnergy':1},noon,observation(noon),proof(noon,1));const stored=daily.serialize();
  daily.receive({'grid.dailyEnergy':1},noon+1000,observation(noon+1000));assert.equal(daily.serialize(),stored);
  assert.throws(()=>new Daily(noon-86400000,JSON.parse(stored)),/CLOCK_MOVED_BACKWARDS/);
  const bad=JSON.parse(stored);bad.counters['unrelated.state']={value:9,confirmed:true,boundary:0};assert.throws(()=>new Daily(noon,bad),/INVALID_DAILY_STORAGE/);
});
test('known DTU counters reset during offline startup and no device request is needed',async()=>{
  const serial='4143A0000001',now=stamp('2026-11-08T00:05:00+01:00');
  const old=new Daily(noon);old.receive({'grid.dailyEnergy':1},noon,observation(noon),proof(noon,1));
  const states=new Map([['info.deviceIdentity',{val:JSON.stringify({host:'127.0.0.1',port:10081,serial})}],[serial+'.internal.dailyEnergy',{val:old.serialize()}]]);
  let requests=0;
  const publisher=new Publisher({setObjectNotExistsAsync:async()=>{},setStateAsync:async(id,state)=>states.set(id,state),getStateAsync:async id=>states.get(id)});
  const runtime=new Runtime({config:{host:'127.0.0.1'},publisher,client:{close:()=>{},initialize:async()=>{requests++;}},log:{info:()=>{},warn:()=>{},debug:()=>{}},now:()=>now});
  await runtime.restoreIdentity();assert.equal(states.get(serial+'.grid.dailyEnergy').val,0);assert.equal(states.get(serial+'.info.dailyConfirmed').val,false);assert.equal(requests,0);await runtime.stop();
});
