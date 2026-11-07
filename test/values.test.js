'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sanitize,serial,rawValues,liveValues,historyValues,signature}=require('../lib/values');
const {Publisher}=require('../lib/publisher');
const {Runtime}=require('../lib/runtime');
const data={device_serial_number:'4143A0000001',timestamp:100,dtu_power:'1290',dtu_daily_energy:'168',sgs_data:[{serial_number:'22070226321409',active_power:1290,voltage:2300,frequency:4998,current:56,temperature:65504,link_status:0,power_factor:990}],pv_data:[{serial_number:'22070226321409',port_number:2,power:647,energy_total:236745,energy_daily:80},{serial_number:'22070226321409',port_number:1,power:725,energy_total:242557,energy_daily:88}],tgs_data:[{unmapped_field:42}],meter_data:[]};
const map=items=>Object.fromEntries(items.map(x=>[x.id,x.val]));
function memory(){
  const objects=new Map(),states=new Map(),writes=[];
  const adapter={setObjectNotExistsAsync:async(id,obj)=>{if(!objects.has(id))objects.set(id,obj);},setStateAsync:async(id,state)=>{states.set(id,state);writes.push({id,...state});},getStateAsync:async id=>states.get(id)};
  return {objects,states,writes,publisher:new Publisher(adapter)};
}
test('normalizes units and negative temperatures, keeps panel identity by port',()=>{
  const v=map(liveValues(data));
  assert.equal(v['grid.power'],129);assert.equal(v['grid.voltage'],230);assert.equal(v['grid.current'],0.56);assert.equal(v['grid.frequency'],49.98);
  assert.equal(v['inverter.temperature'],-3.2);assert.equal(v['inverter.serialNumber'],'1412A0000001');assert.equal(v['inverter.linkStatus'],0);
  assert.equal(v['pv0.power'],72.5);assert.equal(v['pv1.power'],64.7);assert.equal(v['pv0.totalEnergy'],242.557);assert.equal(v['grid.dailyEnergy'],0.168);
});
test('zero is valid, missing values are not fabricated',()=>{
  const v=map(liveValues({dtu_power:'0',dtu_daily_energy:'0',sgs_data:[],pv_data:[{port_number:1,energy_daily:55}]}));
  assert.equal(v['grid.power'],0);assert.equal(v['grid.dailyEnergy'],0);assert.equal(v['grid.voltage'],undefined);
  assert.deepEqual(liveValues({sgs_data:[],pv_data:[]}),[]);
});
test('64-bit serials remain exact and all unnormalized fields remain accessible',()=>{
  assert.equal(serial('18446744073709551615'),'FFFFFFFFFFFFFFFF');
  const raw=rawValues('live',data);const json=JSON.parse(raw[0].val);
  assert.equal(json.tgs_data[0].unmapped_field,42);assert.equal(json.pv_data[0].serial_number,'22070226321409');
  assert.ok(raw.some(x=>x.id.includes('sn1412A0000001_port1.power')));
});
test('credentials and encryption material never enter published JSON or fields',()=>{
  const secret={wifi_password:'DO_NOT_STORE',lock_password:123,apn_password:'DO_NOT_STORE',dtu_ap_pass:'DO_NOT_STORE',dtu_info:{enc_rand:'DO_NOT_STORE',signal_strength:3},nested:[{token:'DO_NOT_STORE',value:0}]};
  const clean=sanitize(secret);assert.equal(clean.dtu_info.signal_strength,3);assert.equal(clean.nested[0].value,0);
  const text=JSON.stringify(rawValues('config',secret));assert.ok(!text.includes('DO_NOT_STORE'));assert.ok(!text.includes('enc_rand'));assert.ok(!text.includes('lock_password'));
});
test('history retains complete curve, timestamps and exact energy counters',()=>{
  const v=map(historyValues({absolute_start:1000,step_time:60,power_array:[0,123,456],daily_energy:168,total_energy:479302}));
  assert.deepEqual(JSON.parse(v['history.powerJson']),[0,12.3,45.6]);assert.equal(v['history.totalEnergy'],479.302);assert.equal(v['history.startTime'],1000000);
  assert.deepEqual(JSON.parse(v['history.pointsJson'])[2],{ts:1120000,power:45.6});
});
test('packet timestamp changes alone do not count as changed measurements',()=>{
  assert.equal(signature(data),signature({...data,timestamp:200,cp:1}));assert.notEqual(signature(data),signature({...data,dtu_power:'1000'}));
});
test('publisher writes unchanged values again and invalidates only the failed group',async()=>{
  const m=memory(),items=liveValues(data);
  await m.publisher.publish('DTU',items,'live');await m.publisher.publish('DTU',historyValues({daily_energy:1}),'history');
  const count=m.writes.length;await m.publisher.publish('DTU',items,'live');assert.ok(m.writes.length>count);
  await m.publisher.invalidate('live');assert.equal(m.states.get('DTU.grid.power').q,0x40);assert.equal(m.states.get('DTU.history.dailyEnergy').q,0);
  for(const object of m.objects.values())if(object.type==='state')assert.equal(object.common.write,false);
});
test('runtime marks failures, preserves old values, then recovers and refreshes encryption handshake',async()=>{
  const m=memory(),serial='4143A0000001';let failures=0,initializations=0,now=1000,closed=false;
  const client={serial,initialize:async()=>{initializations++;return {dtu_serial_number:serial};},live:async()=>{if(failures>0){failures--;throw Object.assign(Error(),{code:'TIMEOUT'});}return data;},close:()=>{closed=true;}};
  const log={info:()=>{},warn:()=>{},debug:()=>{}};
  const runtime=new Runtime({config:{host:'127.0.0.1',interval:1},publisher:m.publisher,client,log,now:()=>now});
  assert.equal(runtime.interval,35000);
  await runtime.readLive();assert.equal(m.states.get(serial+'.info.connected').val,true);
  failures=2;now+=40000;await runtime.readLive();await runtime.readLive();
  assert.equal(m.states.get(serial+'.info.stale').val,true);assert.equal(m.states.get(serial+'.grid.power').val,129);assert.equal(m.states.get(serial+'.grid.power').q,0x40);
  now+=40000;await runtime.readLive();assert.equal(initializations,2);assert.equal(m.states.get(serial+'.info.consecutiveErrors').val,0);assert.equal(m.states.get(serial+'.grid.power').q,0);
  await runtime.stop();assert.equal(closed,true);assert.equal(m.states.get('info.connection').val,false);assert.equal(m.states.get(serial+'.info.connected').val,false);
});
test('auxiliary failures do not turn successful live measurements offline',async()=>{
  const m=memory(),serial='4143A0000001';
  const client={serial,initialize:async()=>({dtu_serial_number:serial}),live:async()=>data,history:async()=>{throw Object.assign(Error(),{code:'TIMEOUT'});},close:()=>{}};
  const runtime=new Runtime({config:{host:'127.0.0.1'},publisher:m.publisher,client,log:{info:()=>{},warn:()=>{},debug:()=>{}}});
  await runtime.readLive();await runtime.readBackground();assert.equal(m.states.get(serial+'.info.connected').val,true);assert.equal(runtime.capabilities.history.status,'unavailable');await runtime.stop();
});
test('stopping during startup cannot create orphan timers or later DTU requests',async()=>{
  let unblock,reads=0;
  const ready=new Promise(resolve=>{unblock=resolve;});
  const m=memory();
  const runtime=new Runtime({config:{host:'127.0.0.1'},publisher:m.publisher,client:{close:()=>{},initialize:async()=>{reads++;}},log:{info:()=>{},warn:()=>{},debug:()=>{}}});
  const original=runtime.availability.bind(runtime);runtime.availability=async connected=>{await ready;return original(connected);};
  const starting=runtime.start();await runtime.stop();unblock();await starting;
  assert.equal(runtime.ageTimer,undefined);assert.equal(runtime.timer,undefined);assert.equal(reads,0);
});
test('protobuf-default night values reset actual inverter and PV measurements to zero',()=>{
  const v=map(liveValues({sgs_data:[{serial_number:'1'}],pv_data:[{serial_number:'1',port_number:1}]}));
  assert.equal(v['grid.power'],0);assert.equal(v['grid.dailyEnergy'],0);assert.equal(v['pv0.power'],0);assert.equal(v['inverter.warnCount'],0);
  const h=map(historyValues({serial_number:'1',power_array:[]}));assert.equal(h['history.dailyEnergy'],0);assert.equal(h['history.pointsJson'],'[]');assert.equal(h['history.timestampsAvailable'],false);
});
test('fields absent from a new complete reply cannot retain old apparently valid data',async()=>{
  const m=memory();await m.publisher.publish('DTU',rawValues('live',{extra:12}),'live');await m.publisher.publish('DTU',rawValues('live',{different:0}),'live');
  assert.equal(m.states.get('DTU.raw.live.fields.extra').val,null);assert.equal(m.states.get('DTU.raw.live.fields.extra').q,0x40);assert.equal(m.states.get('DTU.raw.live.fields.different').val,0);
});
