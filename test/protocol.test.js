'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const {once}=require('node:events');
const {Transport,Dtu,frame,unframe,encode,decode,crc16,mergePages}=require('../lib/protocol');
const references=require('./reference-frames.json');

test('CRC16 matches standard Modbus vector',()=>assert.equal(crc16(Buffer.from('123456789')),0x4b37));
for(const fixture of references)test(`request frame matches original Python 0.5.5, encrypted=${fixture.encrypted}`,()=>{
  const options={encrypted:fixture.encrypted,random:Buffer.from(Array.from({length:16},(_,i)=>i))};
  const bytes=encode('RealDataNewResDTO',{time_ymd_hms:fixture.text,offset:28800,time:fixture.time,cp:0});
  const expected=Buffer.from(fixture.frame,'hex');
  assert.equal(frame(0xa311,1,bytes,options).toString('hex'),fixture.frame);
  assert.deepEqual(unframe(expected,{...options,tag:0xa311,sequence:1}).payload,bytes);
});
test('App info dates are UTF-8 bytes, legacy info dates strings',()=>{
  const value={time_ymd_hms:'2026-11-07 12:00:00'};
  assert.equal(Buffer.from(decode('APPInfoDataResDTO',encode('APPInfoDataResDTO',value)).time_ymd_hms,'base64').toString(),value.time_ymd_hms);
  assert.equal(decode('InfoDataResDTO',encode('InfoDataResDTO',value)).time_ymd_hms,value.time_ymd_hms);
});
test('rejects corrupted CRC, wrong command, wrong sequence and extra bytes',()=>{
  const good=frame(0xa211,4,encode('RealDataNewReqDTO',{dtu_power:'100'}));
  const corrupted=Buffer.from(good);corrupted[10]^=1;
  assert.throws(()=>unframe(corrupted),/CRC_MISMATCH/);
  assert.throws(()=>unframe(good,{tag:0xa315}),/COMMAND_MISMATCH/);
  assert.throws(()=>unframe(good,{sequence:5}),/SEQUENCE_MISMATCH/);
  assert.throws(()=>unframe(Buffer.concat([good,Buffer.from([0])])),/INCOMPLETE_FRAME/);
});
test('rejects unauthenticated encrypted frame even with valid transport CRC',()=>{
  const options={encrypted:true,random:Buffer.alloc(16,9)};
  const bytes=frame(0xa211,3,encode('RealDataNewReqDTO',{dtu_power:'100'}),options);
  bytes[bytes.length-1]^=1;
  assert.throws(()=>unframe(bytes,options),/AUTHENTICATION_FAILED/);
});

async function serverFor(t,handler){
  const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));handler(socket);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return server.address().port;
}
test('assembles TCP fragments and historical replies larger than 1024 bytes',async t=>{
  const powers=Array.from({length:1500},(_,i)=>i);
  const port=await serverFor(t,socket=>socket.once('data',request=>{
    const response=frame(0xa215,request.readUInt16BE(4),encode('AppGetHistPowerReqDTO',{ap:1,cp:0,power_array:powers}));
    socket.write(response.subarray(0,3));
    setTimeout(()=>{socket.write(response.subarray(3,18));setTimeout(()=>socket.end(response.subarray(18)),2);},2);
  }));
  const client=new Transport({host:'127.0.0.1',port,gapMs:0});t.after(()=>client.close());
  const data=await client.request(0xa315,'AppGetHistPowerResDTO','AppGetHistPowerReqDTO',{cp:0});
  assert.deepEqual(data.power_array,powers);
});
test('global queue serializes concurrent requests and waits after closing',async t=>{
  const starts=[];
  const port=await serverFor(t,socket=>{starts.push(performance.now());socket.once('data',request=>socket.end(frame(0xa211,request.readUInt16BE(4),encode('RealDataNewReqDTO',{dtu_power:'100'}))));});
  const client=new Transport({host:'127.0.0.1',port,gapMs:120});t.after(()=>client.close());
  const query=()=>client.request(0xa311,'RealDataNewResDTO','RealDataNewReqDTO',{});
  await Promise.all([query(),query(),query()]);
  assert.equal(starts.length,3);
  assert.ok(starts[1]-starts[0]>=115);
  assert.ok(starts[2]-starts[1]>=115);
});
test('recovers with a new connection after timeout',async t=>{
  let connections=0;
  const port=await serverFor(t,socket=>{connections++;if(connections>1)socket.once('data',request=>socket.end(frame(0xa211,request.readUInt16BE(4),encode('RealDataNewReqDTO',{dtu_power:'200'}))));});
  const client=new Transport({host:'127.0.0.1',port,gapMs:0,timeoutMs:30});t.after(()=>client.close());
  await assert.rejects(client.request(0xa311,'RealDataNewResDTO','RealDataNewReqDTO',{}),/TIMEOUT/);
  const next=await client.request(0xa311,'RealDataNewResDTO','RealDataNewReqDTO',{});
  assert.equal(next.dtu_power,'200');
});
test('stop aborts active and queued requests without leaving timers',async t=>{
  const port=await serverFor(t,()=>{});
  const client=new Transport({host:'127.0.0.1',port,gapMs:2000});
  const first=client.request(0xa311,'RealDataNewResDTO','RealDataNewReqDTO',{});
  const second=client.request(0xa311,'RealDataNewResDTO','RealDataNewReqDTO',{});
  const assertions=Promise.all([assert.rejects(first,/CLOSED/),assert.rejects(second,/CLOSED/)]);
  setTimeout(()=>client.close(),10);
  await assertions;
});
test('pagination merges every page and preserves first history absolute start',async()=>{
  const transport=new Transport({host:'127.0.0.1'});
  const pages=[{ap:2,cp:0,absolute_start:123,serial_number:'7',power_array:[1,2]},{ap:2,cp:1,absolute_start:999,serial_number:'7',power_array:[3,4]}];
  transport.request=async(_tag,_req,_res,request)=>pages[request.cp];
  const dtu=new Dtu(transport);
  const result=await dtu.history();
  assert.deepEqual(result.power_array,[1,2,3,4]);assert.equal(result.absolute_start,123);
});
test('incomplete, mismatched or excessive pagination is rejected',async()=>{
  for(const bad of [{ap:65,cp:0},{ap:2,cp:0,serial_number:'7'},{ap:2,cp:1,serial_number:'8'}]){
    const transport=new Transport({host:'127.0.0.1'});
    transport.request=async(_tag,_req,_res,request)=>request.cp===0?(bad.ap===65?bad:{ap:2,cp:0,serial_number:'7'}):bad;
    await assert.rejects(new Dtu(transport).history(),/PAGE|SERIAL/);
  }
});
test('unknown request inputs cannot issue writes or invalid history days',()=>{
  const dtu=new Dtu({host:'127.0.0.1'});
  assert.throws(()=>dtu.history(-1),/INVALID_HISTORY_DAY/);
  assert.equal(dtu.setPowerLimit,undefined);assert.equal(dtu.reboot,undefined);
});
test('collects coalesced command confirmation and warning details',async t=>{
  const port=await serverFor(t,socket=>socket.once('data',request=>{
    const ack=frame(0xa205,request.readUInt16BE(4),encode('CommandReqDTO',{action:50,err_code:0}));
    const detail=frame(0xa204,90,encode('WarnReqDTO',{package_nub:1,package_now:0,warns:[{pv_sn:'22070226321409',code:123,s_time:100}]}));
    socket.end(Buffer.concat([ack,detail]));
  }));
  const dtu=new Dtu({host:'127.0.0.1',port,gapMs:0});t.after(()=>dtu.close());
  const result=await dtu.alarms();assert.equal(result.ack.action,50);assert.equal(result.messages[0].data.warns[0].code,123);
});
test('command confirmation alone is not fabricated into an empty warning list',async t=>{
  const port=await serverFor(t,socket=>socket.once('data',request=>socket.end(frame(0xa205,request.readUInt16BE(4),encode('CommandReqDTO',{action:50,err_code:0})))));
  const dtu=new Dtu({host:'127.0.0.1',port,gapMs:0});t.after(()=>dtu.close());
  const result=await dtu.alarms();assert.deepEqual(result.messages,[]);assert.equal(result.ack.action,50);
  assert.throws(()=>dtu.readAction(1),/ACTION_NOT_ALLOWED/);
});
test('all warning pages are collected and 64-bit request integers remain exact',async()=>{
  const transport=new Transport({host:'127.0.0.1'});const requests=[];
  transport.request=async(_tag,_request,_response,request)=>{requests.push(request.package_now);return {package_nub:2,package_now:request.package_now,warns:[{code:request.package_now+1}]};};
  const result=await new Dtu(transport).warnings();assert.deepEqual(requests,[0,1]);assert.deepEqual(result.warns.map(x=>x.code),[1,2]);
  const bytes=encode('CommandResDTO',{tid:'9223372036854775807'});assert.equal(decode('CommandResDTO',bytes).tid,'9223372036854775807');
  assert.throws(()=>encode('CommandResDTO',{tid:'9223372036854775808'}),/INTEGER_OUT_OF_RANGE/);
});
test('firmware may use a different sequence while command and CRC remain validated',async t=>{
  const port=await serverFor(t,socket=>socket.once('data',()=>socket.end(frame(0xa209,50,encode('GetConfigReqDTO',{wifi_rssi:-60})))));
  const client=new Transport({host:'127.0.0.1',port,gapMs:0});t.after(()=>client.close());
  const result=await client.request(0xa309,'GetConfigResDTO','GetConfigReqDTO',{});
  assert.equal(result.wifi_rssi,-60);assert.equal(client.sequenceMismatchCount,1);assert.equal(client.lastResponseMeta.sequenceMatches,false);
});
test('detects both legacy alarm format and paginated warning format without losing records',()=>{
  const {decodeWarning}=require('../lib/protocol');
  const legacy=decodeWarning(encode('WInfoReqDTO',{dtu_sn:'4143A0000001',mWInfo:[{pv_sn:'123',WCode:17,WNum:2,WTime1:100,WTime2:0}]}));
  assert.equal(legacy.mWInfo.length,1);assert.equal(legacy.warns[0].code,17);assert.equal(legacy.warns[0].e_time,0);
  const modern=decodeWarning(encode('WarnReqDTO',{package_nub:2,package_now:1,warns:[{pv_sn:'123',code:18}]}));
  assert.equal(modern.package_nub,2);assert.equal(modern.warns[0].code,18);
});
