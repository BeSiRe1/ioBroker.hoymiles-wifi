'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sanitize,serial,liveValues,historyValues,infoValues,alarmValues,signature,value}=require('../lib/values');
const {Publisher}=require('../lib/publisher');
const {Runtime}=require('../lib/runtime');
const data={device_serial_number:'4143A0000001',timestamp:100,dtu_power:'1290',dtu_daily_energy:'168',sgs_data:[{serial_number:'22070226321409',active_power:1290,voltage:2300,frequency:4998,current:56,temperature:65504,link_status:0,power_factor:990}],pv_data:[{serial_number:'22070226321409',port_number:2,power:647,energy_total:236745,energy_daily:80},{serial_number:'22070226321409',port_number:1,power:725,energy_total:242557,energy_daily:88}],tgs_data:[{unmapped_field:42}],meter_data:[]};
const map=items=>Object.fromEntries(items.map(x=>[x.id,x.val]));
test('alarm labels cover the combined list without rejecting unknown numeric codes',()=>{
  const states=require('../lib/alarm-codes.json');
  assert.equal(Object.keys(states).length,227);
  for(const [code,label] of Object.entries(states)){assert.match(code,/^\d+$/);assert.ok(label.startsWith(code+' – '));assert.ok(!/undefined|null/.test(label));}
  assert.match(states[141],/Netzüberspannung/);assert.match(states[221],/modellabhängig/);assert.match(states[0],/Kein aktiver Alarm/);
  const entry=alarmValues({messages:[{data:{warns:[{code:999999,s_time:1,e_time:0}]}}]})[0];
  assert.equal(entry.val,999999);assert.equal(entry.type,'number');assert.equal(entry.states[999999],undefined);
});
test('reported units retain their numeric scaling and existing metadata receives units and labels',async()=>{
  const info=infoValues({dtu_info:{signal_strength:76,communication_time:1794048861}});
  assert.equal(info.find(x=>x.id==='dtu.signalStrength').unit,'%');assert.equal(info.find(x=>x.id==='dtu.communicationTime').unit,'s');
  assert.equal(map(info)['dtu.communicationTime'],1794048861);
  const m=memory(),id='DTU.inverter.errorCode';
  m.objects.set(id,{type:'state',common:{name:'Eigener Name',type:'number',custom:{history:{enabled:true}}},native:{keep:true},acl:{owner:'keep'}});
  await m.publisher.publish('DTU',alarmValues({messages:[{data:{warns:[{code:141,s_time:1}]}}]}),'alarms');
  await m.publisher.publish('DTU',info,'appInfo');
  assert.match(m.objects.get(id).common.states[141],/Netzüberspannung/);assert.equal(m.states.get(id).val,141);
  assert.equal(m.objects.get(id).common.name,'Eigener Name');assert.equal(m.objects.get(id).common.custom.history.enabled,true);
  assert.equal(m.objects.get(id).native.keep,true);assert.equal(m.objects.get(id).acl.owner,'keep');
  assert.equal(m.objects.get('DTU.dtu.signalStrength').common.unit,'%');
});
function memory(){
  const objects=new Map(),states=new Map(),writes=[];
  const adapter={setObjectNotExistsAsync:async(id,obj)=>{if(!objects.has(id))objects.set(id,obj);},getObjectAsync:async id=>objects.get(id),extendObjectAsync:async(id,obj)=>{const old=objects.get(id)||{};objects.set(id,{...old,...obj,common:{...old.common,...obj.common}});},delObjectAsync:async(id,options)=>{assert.equal(options.recursive,true);for(const key of [...objects.keys()])if(key===id||key.startsWith(id+'.'))objects.delete(key);for(const key of [...states.keys()])if(key===id||key.startsWith(id+'.'))states.delete(key);},setStateAsync:async(id,state)=>{states.set(id,state);writes.push({id,...state});},getStateAsync:async id=>states.get(id)};
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
test('64-bit serials remain exact and PV data is only published directly below the DTU',()=>{
  assert.equal(serial('18446744073709551615'),'FFFFFFFFFFFFFFFF');
  const values=liveValues(data);assert.ok(values.some(x=>x.id==='pv0.power'));assert.ok(values.some(x=>x.id==='pv1.power'));assert.ok(values.some(x=>x.id==='inverter.temperature'));
  assert.ok(values.every(x=>!x.id.startsWith('inverters.')&&!x.id.startsWith('raw.')));assert.equal(require('../lib/values').rawValues,undefined);
});
test('credentials and encryption material never enter published JSON or fields',()=>{
  const secret={wifi_password:'DO_NOT_STORE',lock_password:123,apn_password:'DO_NOT_STORE',dtu_ap_pass:'DO_NOT_STORE',dtu_info:{enc_rand:'DO_NOT_STORE',signal_strength:3},nested:[{token:'DO_NOT_STORE',value:0}]};
  const clean=sanitize(secret);assert.equal(clean.dtu_info.signal_strength,3);assert.equal(clean.nested[0].value,0);
  const text=JSON.stringify(clean);assert.ok(!text.includes('DO_NOT_STORE'));assert.ok(!text.includes('enc_rand'));assert.ok(!text.includes('lock_password'));
});
test('history retains complete curve, timestamps and exact energy counters',()=>{
  const v=map(historyValues({absolute_start:1000,step_time:60,power_array:[0,123,456],daily_energy:168,total_energy:479302}));
  assert.deepEqual(JSON.parse(v['history.powerJson']),[0,12.3,45.6]);assert.equal(v['history.totalEnergy'],479.302);assert.equal(v['history.startTime'],1000000);
  assert.deepEqual(JSON.parse(v['history.pointsJson'])[2],{ts:1120000,power:45.6});
});
test('alarm error code uses the newest active entry and distinguishes empty or unknown lists',()=>{
  const result=messages=>({messages:messages.map(warns=>({data:{warns}}))});
  const active=alarmValues(result([[{code:17,s_time:100,e_time:0},{code:23,s_time:200,e_time:0},{code:9,s_time:300,e_time:301}]]));
  assert.equal(map(active)['inverter.errorCode'],23);
  assert.equal(map(alarmValues(result([[{code:29,s_time:220}]])))['inverter.errorCode'],29);
  assert.equal(map(alarmValues(result([[]])))['inverter.errorCode'],0);
  assert.equal(map(alarmValues({messages:[]}))['inverter.errorCode'],null);
  assert.equal(map(alarmValues({messages:[{ack:{action:50}}]}))['inverter.errorCode'],null);
  assert.equal(map(alarmValues(result([[{code:'23',s_time:200,e_time:0}]])))['inverter.errorCode'],null);
  assert.equal(map(alarmValues(result([[{code:23,s_time:200,e_time:'0'}]])))['inverter.errorCode'],null);
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
test('background alarm query publishes confirmed codes and clears stale codes when data is unconfirmed',async()=>{
  const m=memory();let reply={messages:[{data:{warns:[{code:41,s_time:10,e_time:0}]}}]};
  const runtime=new Runtime({config:{host:'127.0.0.1'},publisher:m.publisher,client:{close:()=>{},alarms:async()=>reply},log:{info:()=>{},warn:()=>{},debug:()=>{}}});
  runtime.serial='4143A0000001';runtime.initialized=true;runtime.tasks=[{name:'alarms',every:300000,next:0,read:()=>runtime.client.alarms()}];
  await runtime.readBackground();
  assert.equal(m.states.get('4143A0000001.inverter.errorCode').val,41);
  assert.equal(m.objects.get('4143A0000001.inverter.errorCode').common.write,false);
  reply={messages:[{ack:{action:50}}]};runtime.tasks[0].next=0;await runtime.readBackground();
  assert.equal(m.states.get('4143A0000001.inverter.errorCode').val,null);
  await runtime.stop();
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
  const m=memory();await m.publisher.publish('DTU',[value('dtu.signalStrength',12)],'appInfo');await m.publisher.publish('DTU',[value('dtu.errorCode',0)],'appInfo');
  assert.equal(m.states.get('DTU.dtu.signalStrength').val,null);assert.equal(m.states.get('DTU.dtu.signalStrength').q,0x40);assert.equal(m.states.get('DTU.dtu.errorCode').val,0);
});
test('device online binding preserves existing objects and metadata without deleting folders',async()=>{
  const m=memory(),sn='4143A0000001';
  for(const id of [sn,sn+'.raw',sn+'.raw.old',sn+'.inverters',sn+'.inverters.ABC.pv0',sn+'.inverter',sn+'.pv0',sn+'.pv1',sn+'.internal.dailyEnergy','4143B0000001.raw'])m.objects.set(id,{type:id===sn?'device':'channel',common:{name:'Keep this name'},native:{custom:true}});
  m.states.set(sn+'.raw.old',{val:12});m.states.set(sn+'.internal.dailyEnergy',{val:'keep'});
  await m.publisher.device(sn,'Default name');
  assert.equal(m.objects.get(sn).common.name,'Keep this name');assert.deepEqual(m.objects.get(sn).common.statusStates,{onlineId:'info.connected'});assert.equal(m.objects.get(sn).native.custom,true);
  for(const id of [sn+'.raw',sn+'.raw.old',sn+'.inverters',sn+'.inverters.ABC.pv0',sn+'.inverter',sn+'.pv0',sn+'.pv1',sn+'.internal.dailyEnergy','4143B0000001.raw'])assert.equal(m.objects.has(id),true);
  assert.equal(m.states.get(sn+'.internal.dailyEnergy').val,'keep');await assert.rejects(m.publisher.device('../other','No'),/INVALID_DEVICE_ID/);
});
