'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Daily}=require('../lib/daily');
const {Runtime}=require('../lib/runtime');
const {Publisher}=require('../lib/publisher');

const serial='4143A0000001';
const stamp=text=>Date.parse(text);
const day8=stamp('2026-11-08T12:00:00+01:00');
const day9=stamp('2026-11-09T00:01:00+01:00');
const counter=(value,confirmed=true)=>({value,confirmed,boundary:null});
function snapshot(now,counters){const daily=new Daily(now);daily.state.counters=counters;return daily.serialize();}
function memory(daily,archive){
  const objects=new Map(),states=new Map(),writes=[],attempts=[],messages=[];
  const failures=new Set(),readFailures=new Set();
  states.set('info.deviceIdentity',{val:JSON.stringify({host:'127.0.0.1',port:10081,serial}),ack:true,q:0});
  if(daily!==undefined)states.set(serial+'.internal.dailyEnergy',{val:daily,ack:true,q:0});
  if(archive!==undefined)states.set(serial+'.internal.yields',{val:archive,ack:true,q:0});
  const adapter={
    setObjectNotExistsAsync:async(id,obj)=>{if(!objects.has(id))objects.set(id,obj);},
    getObjectAsync:async id=>objects.get(id),
    extendObjectAsync:async(id,obj)=>{const old=objects.get(id)||{};objects.set(id,{...old,...obj,common:{...old.common,...obj.common}});},
    getStateAsync:async id=>{if(readFailures.has(id))throw Object.assign(Error('Fixture storage read failure'),{code:'FIXTURE_STORAGE_READ_FAILURE'});return states.get(id);},
    setStateAsync:async(id,state)=>{attempts.push({id,...state});if(failures.has(id))throw Object.assign(Error('Fixture storage failure'),{code:'FIXTURE_STORAGE_FAILURE'});states.set(id,state);writes.push({id,...state});},
  };
  const clock={now:day8};
  const log=Object.fromEntries(['info','warn','debug','error'].map(level=>[level,message=>messages.push({level,message})]));
  const runtime=()=>new Runtime({config:{host:'127.0.0.1'},publisher:new Publisher(adapter),client:{close:()=>{},initialize:async()=>{throw Error('DTU access is not part of this test');}},log,now:()=>clock.now});
  const value=id=>states.get(serial+'.'+id)?.val;
  return {objects,states,writes,attempts,failures,readFailures,messages,clock,runtime,value};
}
const yieldWrites=m=>m.writes.filter(entry=>entry.id===serial+'.internal.yields'||entry.id.startsWith(serial+'.grid.yields.')||entry.id.startsWith(serial+'.pv0.yields.')||entry.id===serial+'.info.yieldsError');

test('startup archives the previous confirmed Daily snapshot before its midnight reset',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25),'pv0.dailyEnergy':counter(0.75),'pv1.dailyEnergy':counter(0.5)}));
  m.clock.now=day9;const runtime=m.runtime();
  await runtime.restoreIdentity();
  assert.equal(m.value('grid.dailyEnergy'),0);
  assert.equal(m.value('info.dailyConfirmed'),false);
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'1.25'}]);
  assert.deepEqual(JSON.parse(m.value('pv0.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'0.75'}]);
  assert.deepEqual(JSON.parse(m.value('pv1.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'0.5'}]);
  assert.equal(m.value('grid.yields.month'),1.25);
  assert.equal(m.value('grid.yields.daysRecorded'),1);
  assert.equal(m.value('info.yieldsError'),'');
  await runtime.stop();
});

test('offline midnight finalizes a day once and a subsequent offline restart does not add it again',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25)}));
  const first=m.runtime();await first.restoreIdentity();
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[]);
  assert.equal(m.value('grid.yields.month'),1.25);
  m.clock.now=day9;await first.age();
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'1.25'}]);
  await first.stop();
  const second=m.runtime();await second.restoreIdentity();await second.age();
  assert.equal(m.value('grid.dailyEnergy'),0);
  assert.equal(m.value('grid.yields.month'),1.25);
  assert.equal(m.value('grid.yields.year'),1.25);
  assert.equal(m.value('grid.yields.daysRecorded'),1);
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'1.25'}]);
  await second.stop();
});

test('confirmed grid data is recorded independently of an unconfirmed PV counter',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.2),'pv0.dailyEnergy':counter(0.6,false)}));
  const runtime=m.runtime();await runtime.restoreIdentity();
  assert.equal(m.value('info.dailyConfirmed'),false);
  assert.equal(m.value('grid.yields.month'),1.2);
  assert.equal(m.value('pv0.yields.month')??0,0);
  runtime.daily.state.counters['pv0.dailyEnergy'].confirmed=true;
  await runtime.saveDaily();
  assert.equal(m.value('grid.yields.month'),1.2);
  assert.equal(m.value('pv0.yields.month'),0.6);
  m.clock.now=day9;await runtime.age();
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'1.2'}]);
  assert.deepEqual(JSON.parse(m.value('pv0.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'0.6'}]);
  await runtime.stop();
});

test('failed archive persistence preserves normal daily output and retries without double counting',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25)}));
  m.failures.add(serial+'.internal.yields');
  const runtime=m.runtime();await runtime.restoreIdentity();
  assert.equal(m.value('grid.dailyEnergy'),1.25);
  assert.equal(m.value('info.dailyConfirmed'),true);
  assert.equal(m.value('internal.yields'),undefined);
  assert.ok(m.value('info.yieldsError'));
  m.failures.clear();await runtime.saveDaily();await runtime.saveDaily();
  assert.equal(m.value('grid.yields.month'),1.25);
  assert.equal(m.value('grid.yields.year'),1.25);
  assert.equal(m.value('info.yieldsError'),'');
  assert.equal(m.writes.filter(entry=>entry.id===serial+'.internal.yields').length,1);
  await runtime.stop();
});

test('corrupt archive storage remains untouched while daily counters continue to work',async()=>{
  const corrupt='{not a valid archive';
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25)}),corrupt);
  const runtime=m.runtime();await runtime.restoreIdentity();await runtime.saveDaily();
  assert.equal(m.value('internal.yields'),corrupt);
  assert.equal(m.writes.filter(entry=>entry.id===serial+'.internal.yields').length,0);
  assert.ok(m.value('info.yieldsError'));
  assert.equal(m.value('grid.dailyEnergy'),1.25);
  assert.equal(m.value('info.dailyConfirmed'),true);
  assert.equal(m.value('grid.yields.daysJson'),undefined);
  await runtime.stop();
});

test('unchanged counters do not churn archive storage or public yield outputs',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25),'pv0.dailyEnergy':counter(0.75)}));
  const runtime=m.runtime();await runtime.restoreIdentity();
  const count=yieldWrites(m).length;
  for(let i=0;i<20;i++){m.clock.now+=1000;await runtime.saveDaily();await runtime.age();}
  assert.equal(yieldWrites(m).length,count);
  assert.equal(m.value('grid.yields.month'),1.25);
  assert.equal(m.value('pv0.yields.month'),0.75);
  await runtime.stop();
});

test('a failed public yield write is restored from persisted archive state after restart',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25)}));
  m.failures.add(serial+'.grid.yields.month');
  const first=m.runtime();await first.restoreIdentity();
  assert.ok(m.value('internal.yields'));
  assert.equal(m.value('grid.dailyEnergy'),1.25);
  assert.ok(m.value('info.yieldsError'));
  await first.stop();m.failures.clear();
  const second=m.runtime();await second.restoreIdentity();
  assert.equal(m.value('grid.yields.month'),1.25);
  assert.equal(m.value('grid.yields.year'),1.25);
  assert.equal(m.value('info.yieldsError'),'');
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[]);
  await second.stop();
});

test('a transient archive read failure retries and replays the previous day without losing or duplicating it',async()=>{
  const m=memory(snapshot(day8,{'grid.dailyEnergy':counter(1.25)}));
  m.clock.now=day9;m.readFailures.add(serial+'.internal.yields');
  const runtime=m.runtime();await runtime.restoreIdentity();
  assert.equal(m.value('grid.dailyEnergy'),0);
  assert.equal(m.value('info.dailyConfirmed'),false);
  assert.equal(m.value('info.yieldsError'),'YIELD_STORAGE_UNAVAILABLE');
  assert.equal(m.value('internal.yields'),undefined);
  m.readFailures.clear();m.clock.now+=31000;
  await runtime.saveDaily();await runtime.saveDaily();
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'1.25'}]);
  assert.equal(m.value('grid.yields.month'),1.25);
  assert.equal(m.value('grid.yields.year'),1.25);
  assert.equal(m.value('grid.yields.daysRecorded'),1);
  assert.equal(m.value('info.yieldsError'),'');
  assert.equal(m.writes.filter(entry=>entry.id===serial+'.internal.yields').length,1);
  await runtime.stop();
});

test('an archive read outage across midnight retains the latest confirmed increase before the reset',async()=>{
  const startup=stamp('2026-11-08T23:59:45+01:00');
  const m=memory(snapshot(startup,{'grid.dailyEnergy':counter(1.25)}));
  m.clock.now=startup;m.readFailures.add(serial+'.internal.yields');
  const runtime=m.runtime();await runtime.restoreIdentity();
  assert.equal(m.value('grid.dailyEnergy'),1.25);
  assert.equal(m.value('info.yieldsError'),'YIELD_STORAGE_UNAVAILABLE');
  m.clock.now=stamp('2026-11-08T23:59:55+01:00');
  runtime.daily.state.counters['grid.dailyEnergy'].value=1.3;
  await runtime.saveDaily();
  m.clock.now=stamp('2026-11-09T00:00:01+01:00');await runtime.age();
  assert.equal(m.value('grid.dailyEnergy'),0);
  assert.equal(m.value('info.dailyConfirmed'),false);
  m.readFailures.clear();m.clock.now=stamp('2026-11-09T00:00:16+01:00');
  await runtime.age();await runtime.age();
  assert.deepEqual(JSON.parse(m.value('grid.yields.daysJson')),[{Datum:'08.11.2026',Ertrag:'1.3'}]);
  assert.equal(m.value('grid.yields.month'),1.3);
  assert.equal(m.value('grid.yields.year'),1.3);
  assert.equal(m.value('grid.yields.daysRecorded'),1);
  assert.equal(m.value('info.yieldsError'),'');
  assert.equal(m.writes.filter(entry=>entry.id===serial+'.internal.yields').length,1);
  await runtime.stop();
});
