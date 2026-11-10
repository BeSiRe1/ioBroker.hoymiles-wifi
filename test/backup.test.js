'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {YieldBackup,prepareRestore}=require('../lib/backup');
const {YieldArchive}=require('../lib/yields');
const {Daily}=require('../lib/daily');
const {Runtime}=require('../lib/runtime');
const {Publisher}=require('../lib/publisher');
const serial='4143A0000001',folder='0_userdata.0.Energie.Test',target=folder+'.Hoymiles_'+serial+'_Ertragssicherung',now=Date.parse('2026-11-10T12:00:00+01:00');
function payload(time,amount){const daily=new Daily(time);daily.state.counters={'grid.dailyEnergy':{value:amount,confirmed:true,boundary:null},'pv0.dailyEnergy':{value:amount/2,confirmed:true,boundary:null}};const archive=new YieldArchive(time);archive.observe(daily.state);return {daily:JSON.parse(daily.serialize()),yields:JSON.parse(archive.serialize())};}
function memory(){
  const objects=new Map([[folder,{_id:folder,type:'folder',common:{name:'Test'}}]]),states=new Map(),writes=[],calls=[];const faults=new Set();const clock={now};
  const adapter={namespace:'hoymiles-wifi.0',getForeignObjectAsync:async id=>{calls.push(id);return objects.get(id);},getForeignStateAsync:async id=>{calls.push(id);if(faults.has('read'))throw Error('fixture');return states.get(id);},getForeignObjectsAsync:async pattern=>Object.fromEntries([...objects].filter(([id,o])=>o.type==='state'&&id.startsWith(folder+'.Hoymiles_'))),setForeignObjectNotExistsAsync:async(id,obj)=>{if(!objects.has(id))objects.set(id,{_id:id,...obj});},setForeignStateAsync:async(id,state)=>{if(faults.has('write'))throw Error('fixture');states.set(id,{...state});writes.push({id,...state});},getStateAsync:async id=>states.get(id),setStateAsync:async(id,s)=>{if(faults.has(id))throw Error('fixture');states.set(id,s);},getObjectAsync:async id=>objects.get(id),setObjectNotExistsAsync:async(id,obj)=>{if(!objects.has(id))objects.set(id,{_id:id,...obj});},extendObjectAsync:async(id,obj)=>{const old=objects.get(id)||{};objects.set(id,{...old,...obj,common:{...old.common,...obj.common}});}};
  const config={host:'127.0.0.1',backupEnabled:true,backupFolder:folder},backup=()=>new YieldBackup({adapter,config,now:()=>clock.now});return {adapter,config,backup,objects,states,writes,calls,faults,clock};
}
test('disabled backup performs no foreign reads or writes',async()=>{const m=memory();m.config.backupEnabled=false;const b=m.backup();assert.equal((await b.sync(serial,payload(now,1))).status,'disabled');assert.equal((await b.inspect()).status,'disabled');assert.equal(m.calls.length,0);assert.equal(m.writes.length,0);});
test('backup stores the complete validated state, reads it back and skips unchanged data',async()=>{const m=memory(),b=m.backup(),p=payload(now,1.2);assert.equal((await b.sync(serial,p)).status,'saved');const record=JSON.parse(m.states.get(target).val);assert.deepEqual(record.payload,p);assert.equal(record.deviceSerial,serial);assert.equal(m.objects.get(target).common.write,false);assert.equal(record.payload.daily.counters['grid.dailyEnergy'].value,1.2);await b.sync(serial,p);m.clock.now+=61000;await b.sync(serial,p);assert.equal(m.writes.length,1);assert.equal(b.lastSuccess,now);assert.equal(JSON.stringify(record).includes('host'),false);});
test('a new instance cannot overwrite an existing richer backup with empty or smaller data',async()=>{const m=memory();await m.backup().sync(serial,payload(now,2));const original=m.states.get(target).val;const b=m.backup();assert.equal((await b.sync(serial,payload(now,0))).status,'restoreRequired');assert.equal(m.states.get(target).val,original);assert.equal(m.writes.length,1);assert.equal((await b.sync(serial,payload(now,2.5))).status,'saved');assert.equal(m.writes.length,2);});
test('tampered data, occupied targets and invalid folders are protected',async()=>{
 const m=memory();await m.backup().sync(serial,payload(now,1));const r=JSON.parse(m.states.get(target).val);r.payload.daily.counters['grid.dailyEnergy'].value=999;m.states.get(target).val=JSON.stringify(r);const original=m.states.get(target).val;assert.equal((await m.backup().sync(serial,payload(now,2))).error,'INVALID_BACKUP');assert.equal(m.states.get(target).val,original);
 m.objects.set(target,{type:'state',common:{type:'string'},native:{}});assert.equal((await m.backup().sync(serial,payload(now,2))).error,'BACKUP_TARGET_OCCUPIED');
 for(const id of ['hoymiles-wifi.0','0_userdata.0..x','0_userdata.0.x*']){m.config.backupFolder=id;assert.equal((await m.backup().sync(serial,payload(now,1))).error,'INVALID_BACKUP_FOLDER');}
});
test('write failures are visible and a later retry succeeds without duplicate writes',async()=>{const m=memory(),b=m.backup();m.faults.add('write');assert.equal((await b.sync(serial,payload(now,1))).error,'BACKUP_WRITE_FAILED');m.faults.clear();assert.equal((await b.sync(serial,payload(now,1))).status,'saved');assert.equal(m.writes.length,1);});
test('backup remains after deletion of own adapter states and restores offline without double counting',async()=>{
 const m=memory(),old=payload(now,1.2);await m.backup().sync(serial,old);m.states.set(serial+'.internal.yields',{val:'own-state'});for(const key of [...m.states.keys()])if(key.startsWith(serial+'.'))m.states.delete(key);
 const restored=await prepareRestore(m.backup(),undefined,undefined,now);assert.equal(restored.serial,serial);assert.deepEqual(restored.payload,old);assert.ok(m.states.has(target));
 const a=new YieldArchive(now,restored.payload.yields);a.observe(restored.payload.daily);a.observe(restored.payload.daily);assert.equal(a.outputs().grid.month,1.2);
});
test('restore retains newer live data and handles month/year rollover and restart',async()=>{
 const m=memory(),oldTime=Date.parse('2026-12-31T12:00:00+01:00'),newTime=Date.parse('2027-01-01T12:00:00+01:00');m.clock.now=oldTime;await m.backup().sync(serial,payload(oldTime,1.2));m.clock.now=newTime;
 const local=payload(newTime,0.3),r=await prepareRestore(m.backup(),serial,local,newTime),a=new YieldArchive(newTime,r.payload.yields);a.observe(r.payload.daily);assert.equal(a.outputs().grid.month,0.3);assert.equal(a.outputs().grid.year,0.3);assert.deepEqual(JSON.parse(a.outputs().grid.daysJson),[{Datum:'31.12.2026',Ertrag:'1.2'}]);assert.equal(a.outputs().grid.daysRecorded,1);
 assert.equal(r.payload.daily.counters['grid.dailyEnergy'].confirmed,true);assert.equal(r.payload.daily.counters['grid.dailyEnergy'].boundary,1.2);
});
test('restore rejects incompatible independent period anchors rather than losing newer data',async()=>{const m=memory();await m.backup().sync(serial,payload(now,1));const local=payload(now,2);local.yields.scopes.grid.months['2026-11']=100000000;await assert.rejects(prepareRestore(m.backup(),serial,local,now),/RESTORE_WOULD_LOSE_DATA/);assert.equal(m.writes.length,1);});
test('multiple offline device backups require an unambiguous device identity',async()=>{const m=memory(),b=m.backup();await b.sync(serial,payload(now,1));await b.sync('4143A0000002',payload(now,1));await assert.rejects(prepareRestore(m.backup(),undefined,undefined,now),/BACKUP_DEVICE_AMBIGUOUS/);});
test('runtime serializes backup restoration, persists both stores and keeps public values consistent',async()=>{
 const m=memory();await m.backup().sync(serial,payload(now,1.2));const log={warn:()=>{},info:()=>{},debug:()=>{}};const runtime=new Runtime({config:m.config,publisher:new Publisher(m.adapter),client:{close:()=>{}},log,now:()=>now});
 assert.deepEqual(await runtime.restoreBackup(),{result:'restored'});assert.equal(runtime.serial,serial);assert.equal(JSON.parse(m.states.get(serial+'.internal.yields').val).schema,1);assert.equal(JSON.parse(m.states.get(serial+'.internal.dailyEnergy').val).day,'2026-11-10');assert.equal(m.states.get(serial+'.grid.yields.month').val,1.2);assert.equal(JSON.parse(m.states.get('info.deviceIdentity').val).serial,serial);await runtime.stop();
});
test('admin configuration selects userdata folders and routes backup commands through messagebox',async()=>{
 const schema=require('../admin/jsonConfig.json'),pkg=require('../io-package.json');assert.equal(pkg.native.backupEnabled,false);assert.equal(pkg.native.backupFolder,'');assert.equal(pkg.common.messagebox,true);assert.equal(schema.items.backupFolder.root,'0_userdata.0');assert.equal(schema.items.backupFolder.types,'folder');assert.equal(schema.items._backupRestore.command,'yieldBackupRestore');
 const {EventEmitter}=require('node:events'),core=require.resolve('@iobroker/adapter-core'),original=require.cache[core];class Fake extends EventEmitter{constructor(){super();this.answers=[];}sendTo(...args){this.answers.push(args);}}
 require.cache[core]={id:core,filename:core,loaded:true,exports:{Adapter:Fake}};delete require.cache[require.resolve('../main')];let instance;try{instance=require('../main')();}finally{if(original)require.cache[core]=original;else delete require.cache[core];delete require.cache[require.resolve('../main')];}
 let restores=0;instance.runtime={restoreBackup:async()=>{restores++;return {result:'restored'};},backupStatus:async()=>({status:'saved',lastSuccess:now,target,error:''})};
 await instance.onMessage({command:'yieldBackupRestore',from:'system.adapter.admin.0',message:{backupFolder:'forbidden'},callback:{id:1}});assert.equal(restores,1);assert.deepEqual(instance.answers[0][2],{result:'restored'});
 await instance.onMessage({command:'yieldBackupStatus',from:'system.adapter.admin.0',callback:{id:2}});assert.match(instance.answers[1][2].text,/Sicherung aktuell/);await instance.onMessage({command:'unknown',callback:{id:3}});assert.equal(instance.answers.length,2);
});
test('a partial internal restore retries without losing the backup or counting yields twice',async()=>{
 const m=memory();await m.backup().sync(serial,payload(now,1.2));const original=m.states.get(target).val;
 const runtime=new Runtime({config:m.config,publisher:new Publisher(m.adapter),client:{close:()=>{}},log:{warn:()=>{},info:()=>{},debug:()=>{}},now:()=>now});
 m.faults.add(serial+'.internal.dailyEnergy');assert.deepEqual(await runtime.restoreBackup(),{error:'RESTORE_PERSISTENCE_PENDING'});assert.equal(m.states.get(target).val,original);
 m.faults.clear();await runtime.saveDaily();await runtime.saveDaily();assert.equal(m.states.get(serial+'.grid.yields.month').val,1.2);assert.equal(m.states.get(serial+'.grid.yields.daysRecorded').val,0);assert.equal(m.writes.length,1);await runtime.stop();
});
test('restore refuses unknown local data and waits until startup identity loading finishes',async()=>{
 const m=memory();await m.backup().sync(serial,payload(now,1.2));const original=m.states.get(target).val;
 const runtime=new Runtime({config:m.config,publisher:new Publisher(m.adapter),client:{close:()=>{}},log:{warn:()=>{},info:()=>{},debug:()=>{}},now:()=>now});
 runtime.identityLoading=true;assert.deepEqual(await runtime.restoreBackup(),{error:'ADAPTER_NOT_READY'});runtime.identityLoading=false;
 runtime.serial=serial;runtime.daily=new Daily(now);runtime.yieldsError='YIELD_STORAGE_UNAVAILABLE';assert.deepEqual(await runtime.restoreBackup(),{error:'RESTORE_LOCAL_INVALID'});assert.equal(m.states.get(target).val,original);assert.ok(!m.states.has(serial+'.internal.yields'));await runtime.stop();
});
test('different credited shares cannot reduce effective month or year yields',async()=>{
 const m=memory(),credited=payload(now,2),scope=credited.yields.scopes.grid;scope.months['2026-11']=10000000;scope.years['2026']=10000000;scope.days['2026-11-10'].monthCredit=2000000;scope.days['2026-11-10'].yearCredit=2000000;
 await m.backup().sync(serial,credited);const local=structuredClone(credited);local.yields.scopes.grid.days['2026-11-10'].monthCredit=0;local.yields.scopes.grid.days['2026-11-10'].yearCredit=0;
 await assert.rejects(prepareRestore(m.backup(),serial,local,now),/RESTORE_WOULD_LOSE_DATA/);await m.backup().sync(serial,local);const original=m.states.get(target).val;assert.equal((await m.backup().sync(serial,credited)).status,'restoreRequired');assert.equal(m.states.get(target).val,original);
});
