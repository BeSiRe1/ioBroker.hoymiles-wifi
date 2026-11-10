// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Ertragssicherung
//
// Sichert vollständige Ertragsbestände außerhalb der Adapterinstanz.
//
// Version: 0.1.0.1 (10.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Prüfung und Datenvergleich
// [BLOCK:200] Externe Sicherung
// [BLOCK:300] Wiederherstellung
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Prüfung und Datenvergleich
// ============================================================
'use strict';
const crypto=require('node:crypto');
const {Daily,ZONE,day}=require('./daily');
const {YieldArchive}=require('./yields');
const KIND='hoymiles-yields-backup';
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)).digest('hex');
const error=code=>Object.assign(Error(code),{code});
const serialValid=x=>typeof x==='string'&&/^[A-F\d]{8,32}$/.test(x);
function formatBackupStatus(state){
  const names={disabled:'Ausgeschaltet',waitingForDevice:'Warte auf Gerätezuordnung',ready:'Bereit für die erste Sicherung',available:'Vorhandene Sicherung gefunden',saved:'Sicherung aktuell',restored:'Sicherung wiederhergestellt',restoreRequired:'Vorhandener Bestand geschützt – Wiederherstellung erforderlich',error:'Sicherung nicht möglich',unavailable:'Adapter nicht bereit'};
  const stamp=state.lastSuccess?new Date(state.lastSuccess).toLocaleString('de-DE',{timeZone:ZONE}):'noch keine';
  return (names[state.status]||state.status)+' | Letzte erfolgreiche Sicherung: '+stamp+(state.target?' | '+state.target:'')+(state.error?' | '+state.error:'');
}
function validate(payload,now){
  if(!payload||!payload.daily||!payload.yields||payload.daily.zone!==ZONE||payload.yields.zone!==ZONE)throw error('INVALID_BACKUP');
  new Daily(now,payload.daily);new YieldArchive(now,payload.yields);
  return payload;
}
function contains(next,previous){
  if(next.day<previous.day)return false;
  for(const [id,old]of Object.entries(previous.scopes)){
    const value=next.scopes[id];if(!value||value.averageCount<old.averageCount||value.averageSum<old.averageSum)return false;
    if(old.startDate&&(!value.startDate||value.startDate.slice(6)+value.startDate.slice(3,5)+value.startDate.slice(0,2)>old.startDate.slice(6)+old.startDate.slice(3,5)+old.startDate.slice(0,2)))return false;
    for(const [date,item]of Object.entries(old.days)){const n=value.days[date];if(!n||n.energy<item.energy||item.final&&!n.final||item.counted&&!n.counted)return false;}
    for(const [key,credit,size]of [['months','monthCredit',7],['years','yearCredit',4]]){
      const totals=scope=>{const sums={...scope[key]};for(const [date,item]of Object.entries(scope.days))if(!item.final){const period=date.slice(0,size);sums[period]=(sums[period]||0)+item.energy-item[credit];}return sums;};
      const current=totals(value);for(const [period,amount]of Object.entries(totals(old)))if(current[period]===undefined||current[period]<amount)return false;
      for(const [period,amount]of Object.entries(old[key]))if(value[key][period]===undefined||value[key][period]<amount)return false;
    }
  }
  return true;
}
function dominates(next,previous){
  if(!contains(next.yields,previous.yields)||next.daily.day<previous.daily.day)return false;
  if(next.daily.day===previous.daily.day)for(const [id,c]of Object.entries(previous.daily.counters))if(c.confirmed){const n=next.daily.counters[id];if(!n?.confirmed||n.value<c.value)return false;}
  return true;
}
// ============================================================

// ============================================================
// [BLOCK:200] Externe Sicherung
// ============================================================
class YieldBackup{
  constructor({adapter,config,now=Date.now}){this.adapter=adapter;this.config=config;this.now=now;this.lastSuccess=0;this.target='';this.status='disabled';this.lastDigest=undefined;this.lastSerial=undefined;this.contextSerial=undefined;this.nextProbe=0;}
  enabled(){return this.config.backupEnabled===true;}
  async folder(){
    if(!this.enabled())throw error('BACKUP_DISABLED');
    const id=String(this.config.backupFolder||'').trim();
    if(!/^0_userdata\.0(?:\.[^.*\s]+)*$/.test(id)||id.split('.').some(x=>!x))throw error('INVALID_BACKUP_FOLDER');
    const object=await this.adapter.getForeignObjectAsync(id);
    if(!object||!['folder','channel'].includes(object.type))throw error('BACKUP_FOLDER_NOT_FOUND');
    return id;
  }
  async context(serial){
    if(!serialValid(serial))throw error('DEVICE_UNKNOWN');
    if(this.contextSerial!==serial){this.lastSuccess=0;this.contextSerial=serial;}
    const folder=await this.folder(),id=folder+'.Hoymiles_'+serial+'_Ertragssicherung';this.target=id;
    const object=await this.adapter.getForeignObjectAsync(id),state=await this.adapter.getForeignStateAsync(id);
    if(object&&(object.type!=='state'||object.common?.type!=='string'||object.native?.hoymilesYieldBackup!==1||object.native?.deviceSerial!==serial)||!object&&state?.val!==undefined&&state.val!==null)throw error('BACKUP_TARGET_OCCUPIED');
    return {id,object,state};
  }
  decode(serial,state){
    try{const record=JSON.parse(state?.val);if(record?.schema!==1||record.kind!==KIND||record.deviceSerial!==serial||!Number.isFinite(record.savedAt)||record.savedAt<=0||record.checksum!==digest(record.payload))throw error('INVALID_BACKUP');validate(record.payload,this.now());return record;}catch{throw error('INVALID_BACKUP');}
  }
  async find(serial){
    if(serial)return {serial,...await this.context(serial)};
    const folder=await this.folder();
    const objects=await this.adapter.getForeignObjectsAsync(folder+'.Hoymiles_*_Ertragssicherung','state');
    const found=Object.values(objects||{}).filter(o=>o.native?.hoymilesYieldBackup===1&&serialValid(o.native.deviceSerial)&&o._id===folder+'.Hoymiles_'+o.native.deviceSerial+'_Ertragssicherung');
    if(found.length!==1)throw error(found.length?'BACKUP_DEVICE_AMBIGUOUS':'BACKUP_NOT_FOUND');
    const selected=found[0].native.deviceSerial;return {serial:selected,...await this.context(selected)};
  }
  async inspect(serial){
    if(!this.enabled()){this.status='disabled';return this.result();}
    try{const selected=await this.find(serial);if(!selected.state?.val){this.status='ready';return this.result();}const record=this.decode(selected.serial,selected.state);this.lastSuccess=record.savedAt;if(!['saved','restored','restoreRequired'].includes(this.status))this.status='available';return this.result();}
    catch(e){if(e.code==='BACKUP_NOT_FOUND'&&!serial){this.status='waitingForDevice';return this.result();}this.status='error';return this.result(e.code||'BACKUP_READ_FAILED');}
  }
  result(code=''){return {status:this.status,error:code,lastSuccess:this.lastSuccess,target:this.target};}
  async sync(serial,payload){
    if(!this.enabled()){this.status='disabled';return this.result();}
    if(!serial){this.status='waitingForDevice';return this.result();}
    try{
      validate(payload,this.now());const checksum=digest(payload);
      if(serial===this.lastSerial&&checksum===this.lastDigest&&this.now()<this.nextProbe){this.status='saved';return this.result();}
      const context=await this.context(serial);let previous;
      if(context.state?.val){previous=this.decode(serial,context.state);this.lastSuccess=previous.savedAt;if(previous.checksum===checksum){this.lastDigest=checksum;this.lastSerial=serial;this.nextProbe=this.now()+60000;this.status='saved';return this.result();}if(!dominates(payload,previous.payload)){this.status='restoreRequired';return this.result('BACKUP_CONTAINS_OTHER_DATA');}}
      if(!context.object){await this.adapter.setForeignObjectNotExistsAsync(context.id,{type:'state',common:{name:'Hoymiles '+serial+' – Ertragssicherung',type:'string',role:'json',read:true,write:false},native:{hoymilesYieldBackup:1,deviceSerial:serial}});const object=await this.adapter.getForeignObjectAsync(context.id);if(object?.native?.hoymilesYieldBackup!==1||object.native.deviceSerial!==serial)throw error('BACKUP_TARGET_OCCUPIED');}
      const latest=await this.adapter.getForeignStateAsync(context.id);if((latest?.val??null)!==(context.state?.val??null))throw error('BACKUP_CHANGED');
      const record={schema:1,kind:KIND,deviceSerial:serial,savedAt:this.now(),payload:clone(payload),checksum};const text=JSON.stringify(record);
      await this.adapter.setForeignStateAsync(context.id,{val:text,ack:true});
      const stored=await this.adapter.getForeignStateAsync(context.id);if(stored?.val!==text)throw error('BACKUP_VERIFY_FAILED');
      this.lastDigest=checksum;this.lastSerial=serial;this.nextProbe=this.now()+60000;this.lastSuccess=record.savedAt;this.status='saved';return this.result();
    }catch(e){this.status='error';return this.result(e.code||'BACKUP_WRITE_FAILED');}
  }
}
// ============================================================

// ============================================================
// [BLOCK:300] Wiederherstellung
// ============================================================
async function prepareRestore(backup,serial,local,now){
  const selected=await backup.find(serial);if(!selected.state?.val)throw error('BACKUP_NOT_FOUND');
  const record=backup.decode(selected.serial,selected.state),payload=clone(record.payload);
  const archive=new YieldArchive(now,payload.yields);
  archive.observe(payload.daily);
  if(local?.yields){
    validate(local,now);
    for(const [id,scope]of Object.entries(local.yields.scopes))for(const [date,item]of Object.entries(scope.days))if(item.observed){archive.observe({schema:1,zone:ZONE,day:date,counters:{[id+'.dailyEnergy']:{value:item.energy/1000000,confirmed:true,boundary:null}}});}
    archive.observe(local.daily);
  }
  archive.roll(now);
  const daily=new Daily(now,payload.daily);
  if(local?.daily&&local.daily.day===day(now))for(const [id,counter]of Object.entries(local.daily.counters)){
    const old=daily.state.counters[id];
    if(!old||counter.confirmed&&counter.value>=old.value)daily.state.counters[id]={...counter,boundary:old?.boundary??counter.boundary};
  }
  archive.observe(daily.state);
  const restored={yields:JSON.parse(archive.serialize()),daily:JSON.parse(daily.serialize())};
  if(!dominates(restored,payload)||local&&!dominates(restored,local))throw error('RESTORE_WOULD_LOSE_DATA');
  const latest=await backup.adapter.getForeignStateAsync(selected.id);if(latest?.val!==selected.state.val)throw error('BACKUP_CHANGED');
  return {serial:selected.serial,payload:restored,sourceSavedAt:record.savedAt};
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={YieldBackup,prepareRestore,dominates,formatBackupStatus};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.1.0.1 (10.11.2026): 
// - Sicherungsstatus einheitlich für Statusabfrage und fortlaufende Anzeige formatieren.
//
// 0.1.0.0 (10.11.2026): 
// - Vollständige externe Ertragssicherung mit Gerätebindung, Prüfung und verlustfreier Wiederherstellung ergänzen.
//
// ============================================================
