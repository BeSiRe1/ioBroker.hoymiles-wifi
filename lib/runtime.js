// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Abfragesteuerung
//
// Steuert Livewerte, Hintergrundabfragen, Datenalter und Wiederanlauf.
//
// Version: 0.2.3.1 (10.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Abhängigkeiten
// [BLOCK:200] Abfragesteuerung
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Abhängigkeiten
// ============================================================
'use strict';
const {Dtu}=require('./protocol');
const {liveValues,historyValues,infoValues,alarmValues,value,signature}=require('./values');
const {Daily,day,nextMidnight}=require('./daily');
const {YieldArchive}=require('./yields');
const {YieldBackup,prepareRestore,formatBackupStatus}=require('./backup');
// ============================================================

// ============================================================
// [BLOCK:200] Abfragesteuerung
// ============================================================
class Runtime{
  constructor({config,publisher,log,client,now=Date.now}){
    this.config=config;this.publisher=publisher;this.log=log;this.now=now;
    this.interval=Math.max(35,Number(config.interval)||35)*1000;
    this.client=client||new Dtu({host:config.host.trim(),port:Number(config.port)||10081,timeoutMs:Math.max(3,Math.min(30,Number(config.timeout)||10))*1000,gapMs:2000});
    this.closed=false;this.initialized=false;this.nextLive=0;this.errors=0;this.lastResponse=0;this.lastChange=0;this.previousSignature=undefined;this.serial=undefined;this.capabilities={};this.roundRobin=0;
    this.dailyQueue=Promise.resolve();this.daily=undefined;this.dailySerial=undefined;this.dailyPersisted=undefined;this.dailyOutput=undefined;this.lastObservation=undefined;this.historyProof=undefined;
    this.errorCodeSource=undefined;
    this.yields=undefined;this.yieldsSerial=undefined;this.yieldsPersisted=undefined;this.yieldsOutput=undefined;this.yieldsError=undefined;this.yieldsReplay=new Map();this.yieldsRetryAt=0;
    this.backup=new YieldBackup({adapter:publisher.adapter,config,now});this.backupOutput=undefined;this.identityLoading=false;
    this.tasks=[{name:'history',every:Math.max(300,Number(config.historyInterval)||300)*1000,read:()=>this.client.history()}, {name:'config',every:900000,read:()=>this.client.config()}, {name:'network',every:900000,read:()=>this.client.network()}, {name:'information',every:7200000,read:()=>this.client.information()}, {name:'warnings',every:300000,read:()=>this.client.warnings()}, {name:'alarms',every:300000,read:()=>this.client.alarms()}, {name:'events',every:300000,read:()=>this.client.events()}].map(task=>({...task,next:0}));
  }
  async state(values){if(!this.closed)await this.publisher.publish(this.serial||'',values);}
  async availability(connected){await this.publisher.publish('',[value('info.connection',connected,'DTU-Verbindung')]);if(this.serial)await this.state([value('info.connected',connected,'Letzte Liveabfrage erfolgreich')]);}
  dailyOperation(operation){
    this.dailyQueue=this.dailyQueue.then(async()=>{if(!this.closed)await operation();}).catch(()=>this.log.warn('Tagesertrag konnte nicht aktualisiert werden.'));
    return this.dailyQueue;
  }
  async loadDaily(){
    if(this.closed||!this.serial||this.dailySerial===this.serial)return;
    const saved=await this.publisher.read(this.serial,'internal.dailyEnergy');if(this.closed)return;
    this.daily=undefined;this.dailySerial=undefined;this.lastObservation=undefined;this.historyProof=undefined;
    let parsed;
    if(saved?.val){try{parsed=JSON.parse(saved.val);}catch{this.log.warn('Gespeicherter Tagesertrag ist ungültig; positive Werte werden erst nach Bestätigung übernommen.');}}
    try{this.daily=new Daily(this.now(),parsed);}catch(error){if(error.message==='CLOCK_MOVED_BACKWARDS')throw error;this.log.warn('Gespeicherter Tagesertrag ist ungültig; starte mit unbestätigtem Tagesstand.');this.daily=new Daily(this.now());parsed=undefined;}
    this.dailySerial=this.serial;this.dailyPersisted=saved?.val;this.dailyOutput=undefined;this.lastObservation=undefined;this.historyProof=undefined;
    await this.loadYields(parsed);
    await this.saveDaily();
  }
  async loadYields(previousDaily){
    const previousError=this.yieldsError;let readCompleted=false;
    if(this.yieldsSerial!==this.serial)this.yieldsReplay=new Map();
    if(previousDaily)this.rememberYieldDaily(previousDaily);
    this.yields=undefined;this.yieldsSerial=this.serial;this.yieldsPersisted=undefined;this.yieldsOutput=undefined;
    try{
      const saved=await this.publisher.read(this.serial,'internal.yields');if(this.closed)return;
      readCompleted=true;
      const parsed=saved?.val?JSON.parse(saved.val):undefined;
      const archive=new YieldArchive(this.now(),parsed);
      for(const date of [...this.yieldsReplay.keys()].sort())archive.observe(this.yieldsReplay.get(date));
      archive.roll(this.now());
      this.yields=archive;this.yieldsPersisted=saved?.val;this.yieldsReplay.clear();this.yieldsRetryAt=0;
    }catch(error){
      this.yieldsError=readCompleted?'INVALID_YIELD_STORAGE':'YIELD_STORAGE_UNAVAILABLE';this.yieldsRetryAt=this.now()+30000;
      await this.state([value('info.yieldsError',this.yieldsError,'Fehler der Ertragsspeicherung')]).catch(()=>{});
      if(previousError!==this.yieldsError)this.log.warn('Ertragsarchiv konnte nicht geladen werden; der gespeicherte Bestand bleibt erhalten.');
    }
  }
  rememberYieldDaily(snapshot){
    const stored=this.yieldsReplay.get(snapshot.day)||{schema:snapshot.schema,zone:snapshot.zone,day:snapshot.day,counters:{}};
    for(const [id,counter]of Object.entries(snapshot.counters))if(counter.confirmed&&(!stored.counters[id]||counter.value>stored.counters[id].value))stored.counters[id]={...counter};
    this.yieldsReplay.set(snapshot.day,stored);
  }
  async saveYields(){
    if(this.closed||!this.daily||this.yieldsSerial!==this.serial)return;
    if(!this.yields&&this.yieldsError==='YIELD_STORAGE_UNAVAILABLE'){
      this.rememberYieldDaily(this.daily.state);
      if(this.now()>=this.yieldsRetryAt)await this.loadYields();
    }
    if(!this.yields)return;
    try{
      this.yields.roll(this.now());this.yields.observe(this.daily.state);
      const stored=this.yields.serialize();
      if(stored!==this.yieldsPersisted){await this.publisher.publish(this.serial,[value('internal.yields',stored,'Gespeicherte Tages-, Monats- und Jahreserträge',undefined,'json')]);this.yieldsPersisted=stored;}
      const output=this.yields.outputs(),signature=JSON.stringify(output);
      if(signature!==this.yieldsOutput){
        const entries=[],names={daysJson:'Tageserträge',monthsJson:'Monatserträge',yearsJson:'Jahreserträge',month:'Ertrag im laufenden Monat',year:'Ertrag im laufenden Jahr',average:'Tagesdurchschnitt aller erfassten Tage',daysRecorded:'Abgeschlossene erfasste Tage',startDate:'Beginn der Ertragserfassung',qualityJson:'Abdeckung der Ertragserfassung'};
        for(const [scope,fields]of Object.entries(output))for(const [field,val]of Object.entries(fields)){
          const json=field.endsWith('Json'),energy=['month','year','average'].includes(field);
          entries.push(value(`${scope}.yields.${field}`,val,names[field]||field,energy?'kWh':undefined,json?'json':energy?'value.energy':undefined));
        }
        await this.publisher.publish(this.serial,entries,'yields');this.yieldsOutput=signature;
      }
      if(this.yieldsError!==''){await this.state([value('info.yieldsError','','Fehler der Ertragsspeicherung')]);this.yieldsError='';}
      const result=await this.backup.sync(this.serial,{yields:JSON.parse(stored),daily:JSON.parse(this.daily.serialize())});await this.publishBackupStatus(result).catch(()=>{});
    }catch(error){
      const code='YIELD_PERSISTENCE_FAILED';
      if(this.yieldsError!==code)this.log.warn('Ertragsarchiv konnte nicht gespeichert werden; die Übertragung wird erneut versucht.');
      this.yieldsError=code;await this.state([value('info.yieldsError',code,'Fehler der Ertragsspeicherung')]).catch(()=>{});
    }
  }
  async publishBackupStatus(result){
    const signature=JSON.stringify(result);if(signature===this.backupOutput||this.closed)return;
    await this.publisher.publish('',[value('info.yieldBackupStatus',result.status,'Status der Ertragssicherung'),value('info.yieldBackupError',result.error,'Fehler der Ertragssicherung'),value('info.yieldBackupLastSuccess',result.lastSuccess,'Letzte erfolgreiche Ertragssicherung','ms','date'),value('info.yieldBackupTarget',result.target,'Ziel der Ertragssicherung'),value('info.yieldBackupText',formatBackupStatus(result),'Sicherungsstatus und letzter Erfolg')]);this.backupOutput=signature;
  }
  async backupStatus(){
    let result;await this.dailyOperation(async()=>{result=await this.backup.inspect(this.serial);await this.publishBackupStatus(result);});
    return result||{status:'unavailable',error:'ADAPTER_NOT_READY',lastSuccess:0,target:''};
  }
  async restoreBackup(){
    let result={error:'ADAPTER_NOT_READY'};
    await this.dailyOperation(async()=>{
      let accepted=false;
      try{
        if(!this.backup.enabled())throw Object.assign(Error(),{code:'BACKUP_DISABLED'});
        if(this.identityLoading)throw Object.assign(Error(),{code:'ADAPTER_NOT_READY'});
        if(this.serial&&(!this.daily||!this.yields))throw Object.assign(Error(),{code:'RESTORE_LOCAL_INVALID'});
        const now=this.now(),local=this.daily?{daily:JSON.parse(this.daily.serialize()),yields:this.yields?JSON.parse(this.yields.serialize()):{schema:1,zone:'Europe/Berlin',day:day(now),scopes:{}}}:undefined;
        const restored=await prepareRestore(this.backup,this.serial,local,now);
        accepted=true;
        this.serial=restored.serial;this.daily=new Daily(now,restored.payload.daily);this.dailySerial=this.serial;this.dailyPersisted=undefined;this.dailyOutput=undefined;
        this.yields=new YieldArchive(now,restored.payload.yields);this.yieldsSerial=this.serial;this.yieldsPersisted=undefined;this.yieldsOutput=undefined;this.yieldsError=undefined;this.yieldsReplay.clear();
        await this.publisher.device(this.serial,`Hoymiles DTU ${this.serial}`);
        await this.publisher.publish('',[value('info.deviceIdentity',JSON.stringify({host:this.config.host.trim(),port:Number(this.config.port)||10081,serial:this.serial}),'Zuordnung der bekannten DTU',undefined,'json')]);
        await this.saveDaily();
        if(this.yieldsError)throw Object.assign(Error(),{code:'RESTORE_PERSISTENCE_PENDING'});
        const persisted=await this.publisher.read(this.serial,'internal.yields'),daily=await this.publisher.read(this.serial,'internal.dailyEnergy');
        if(persisted?.val!==this.yieldsPersisted||daily?.val!==this.dailyPersisted)throw Object.assign(Error(),{code:'RESTORE_VERIFY_FAILED'});
        result={result:'restored'};
      }catch(e){result={error:accepted&&e.code!=='RESTORE_VERIFY_FAILED'?'RESTORE_PERSISTENCE_PENDING':e.code||'RESTORE_FAILED'};}
    });return result;
  }
  async saveDaily(){
    if(this.closed||!this.daily)return;
    const stored=this.daily.serialize();
    if(stored!==this.dailyPersisted){await this.publisher.publish(this.serial,[value('internal.dailyEnergy',stored,'Gespeicherter Tagesertrag und Vortagsschutz',undefined,'json')]);this.dailyPersisted=stored;}
    const output=JSON.stringify({day:this.daily.state.day,values:this.daily.values(),confirmed:this.daily.confirmed()});
    if(output!==this.dailyOutput){await this.publisher.publish(this.serial,[...Object.entries(this.daily.values()).map(([id,val])=>value(id,val,'Tagesertrag mit Mitternachtsreset','kWh','value.energy')),value('info.dailyDay',this.daily.state.day,'Kalendertag des Tagesertrags'),value('info.dailyConfirmed',this.daily.confirmed(),'Heutiger Tagesertrag bestätigt')],'daily');this.dailyOutput=output;}
    await this.saveYields();
  }
  armMidnight(){
    clearTimeout(this.midnightTimer);if(this.closed||!this.started)return;
    this.midnightTimer=setTimeout(()=>{this.dailyOperation(async()=>{if(this.daily){this.daily.roll(this.now());await this.saveDaily();}}).finally(()=>this.armMidnight());},Math.max(1,nextMidnight(this.now())-this.now()));
  }
  async restoreIdentity(){
    const stored=await this.publisher.read('','info.deviceIdentity');if(this.closed)return;
    try{const identity=JSON.parse(stored?.val||'null');if(identity&&identity.host===this.config.host.trim()&&identity.port===(Number(this.config.port)||10081)&&/^[A-F\d]{8,32}$/.test(identity.serial)){this.serial=identity.serial;await this.publisher.device(this.serial,`Hoymiles DTU ${this.serial}`);await this.dailyOperation(()=>this.loadDaily());}}
    catch{this.log.debug('Noch keine passende gespeicherte DTU-Zuordnung vorhanden.');}
  }
  async readLive(){
    if(this.closed)return;
    const startedAt=this.now();
    try{
      if(!this.initialized){
        const info=await this.client.initialize();if(this.closed)return;
        this.serial=this.client.serial;await this.publisher.device(this.serial,`Hoymiles DTU ${this.serial}`);
        await this.publisher.publish('',[value('info.deviceIdentity',JSON.stringify({host:this.config.host.trim(),port:Number(this.config.port)||10081,serial:this.serial}),'Zuordnung der bekannten DTU',undefined,'json')]);
        await this.dailyOperation(()=>this.loadDaily());
        await this.publisher.publish(this.serial,infoValues(info),'appInfo');this.initialized=true;
      }
      const data=await this.client.live();if(this.closed)return;
      const received=this.now(),hash=signature(data);
      if(hash!==this.previousSignature){this.previousSignature=hash;this.lastChange=received;}
      this.lastResponse=received;
      const projected=liveValues(data),counters=Object.fromEntries(projected.filter(x=>x.id.endsWith('.dailyEnergy')).map(x=>[x.id,x.val]));
      await this.publisher.publish(this.serial,projected.map(entry=>entry.id.endsWith('.dailyEnergy')?{...entry,id:entry.id+'Dtu',name:'Unveränderter DTU-Tageszähler'}:entry),'live');
      const observation={startedAt,receivedAt:received,values:counters,pvSum:(data.pv_data||[]).length?(data.pv_data||[]).reduce((sum,pv)=>sum+(Number(pv.energy_daily)||0),0)/1000:undefined};
      await this.dailyOperation(async()=>{if(!this.daily)return;this.lastObservation=observation;this.daily.receive(counters,this.now(),observation,this.historyProof);await this.saveDaily();});
      await this.availability(true);
      await this.state([value('info.lastResponse',received,'Letzte erfolgreiche Liveantwort','ms','date'),value('info.lastValueChange',this.lastChange,'Letzte Änderung der Messdaten','ms','date'),value('info.stale',false,'Liveantwort veraltet'),value('info.consecutiveErrors',0,'Aufeinanderfolgende Abfragefehler'),value('info.lastError','','Letzter Abfragefehler'),value('info.sequenceMismatchCount',this.client.transport?.sequenceMismatchCount,'Antworten mit abweichender Paketnummer')]);
      this.errors=0;
    }catch(error){
      if(this.closed)return;
      this.errors++;if(this.errors>=2)this.initialized=false;
      await this.availability(false);await this.publisher.invalidate('live');
      await this.state([value('info.stale',true,'Liveantwort veraltet'),value('info.consecutiveErrors',this.errors,'Aufeinanderfolgende Abfragefehler'),value('info.lastError',error.code||'READ_FAILED','Letzter Abfragefehler')]);
    }finally{this.nextLive=this.now()+this.interval;}
  }
  async readBackground(){
    if(!this.initialized||this.closed)return;
    for(let offset=0;offset<this.tasks.length;offset++){
      const index=(this.roundRobin+offset)%this.tasks.length,task=this.tasks[index];
      if(task.next>this.now())continue;
      this.roundRobin=(index+1)%this.tasks.length;
      try{
        const data=await task.read();if(this.closed)return;
        const alarmTask=task.name==='warnings'||task.name==='alarms';
        const normalized=task.name==='history'?historyValues(data):task.name==='information'?infoValues(data):alarmTask?alarmValues(data):[];
        if(alarmTask){
          const confirmed=normalized[0].val!==null;
          if(task.name==='warnings'||this.errorCodeSource!=='warnings'&&(confirmed||!this.errorCodeSource)){
            await this.publisher.publish(this.serial,normalized,'alarmStatus');
            this.errorCodeSource=confirmed?task.name:undefined;
          }
        }else await this.publisher.publish(this.serial,normalized,task.name);
        if(task.name==='history')await this.dailyOperation(async()=>{
          if(!this.daily)return;
          this.historyProof={start:Number(data.absolute_start)*1000,energy:(Number(data.daily_energy)||0)/1000,receivedAt:this.now()};
          if(this.lastObservation)this.daily.receive(this.lastObservation.values,this.now(),this.lastObservation,this.historyProof);else this.daily.roll(this.now());
          await this.state([value('history.curveDay',data.absolute_start?day(Number(data.absolute_start)*1000):'','Kalendertag der historischen Kurve')]);
          await this.saveDaily();
        });
        this.capabilities[task.name]={status:Array.isArray(data.messages)&&!data.messages.length?'acknowledged':'available',lastSuccess:this.now()};
      }catch(error){
        if(this.closed)return;
        if(task.name==='warnings'||task.name==='alarms'&&this.errorCodeSource!=='warnings'){
          await this.publisher.publish(this.serial,alarmValues(undefined),'alarmStatus');this.errorCodeSource=undefined;
        }
        else await this.publisher.invalidate(task.name);
        this.capabilities[task.name]={...this.capabilities[task.name],status:'unavailable',error:error.code||'READ_FAILED'};
      }
      task.next=this.now()+task.every;
      await this.state([value('info.capabilities',JSON.stringify(this.capabilities),'Status der einzelnen Datenabfragen',undefined,'json')]);
      break;
    }
  }
  async cycle(){
    if(this.closed)return;
    try{await this.readLive();}catch{this.log.warn('Messdaten konnten nicht verarbeitet werden. Der nächste Abfrageversuch bleibt geplant.');}
    if(this.closed)return;
    this.timer=setTimeout(()=>{
      this.inFlight=this.readBackground().catch(()=>this.log.warn('Zusatzabfrage konnte nicht verarbeitet werden.')).finally(()=>{
        if(!this.closed)this.timer=setTimeout(()=>{this.inFlight=this.cycle().catch(()=>this.log.warn('Abfrage konnte nicht verarbeitet werden.'));},Math.max(0,this.nextLive-this.now()));
      });
    },5000);
  }
  async start(){
    if(this.closed)return;
    this.started=true;this.identityLoading=true;
    try{await this.publishBackupStatus(this.backup.enabled()?{status:'waitingForDevice',error:'',lastSuccess:0,target:''}:{status:'disabled',error:'',lastSuccess:0,target:''});await this.restoreIdentity();}finally{this.identityLoading=false;}if(this.closed)return;
    this.armMidnight();
    await this.availability(false);
    if(this.closed)return;
    this.ageTimer=setInterval(()=>{this.ageInFlight=this.age().catch(()=>{});},10000);
    this.inFlight=this.cycle();await this.inFlight;
  }
  async age(){
    if(this.closed||!this.serial)return;
    await this.dailyOperation(async()=>{if(this.daily){this.daily.roll(this.now());await this.saveDaily();}});
    const seconds=this.lastResponse?Math.max(0,Math.floor((this.now()-this.lastResponse)/1000)):-1;
    await this.state([value('info.responseAge',seconds,'Alter der letzten Liveantwort','s'),value('info.valueChangeAge',this.lastChange?Math.max(0,Math.floor((this.now()-this.lastChange)/1000)):-1,'Zeit seit letzter Messwertänderung','s')]);
    if(seconds>Math.ceil(this.interval/1000)*2)await this.state([value('info.stale',true,'Liveantwort veraltet')]);
  }
  async stop(){
    this.closed=true;clearTimeout(this.timer);clearInterval(this.ageTimer);clearTimeout(this.midnightTimer);this.client.close();
    await Promise.allSettled([this.inFlight,this.ageInFlight,this.dailyQueue]);
    try{
      await this.publisher.publish('',[value('info.connection',false,'DTU-Verbindung')]);
      if(this.serial)await this.publisher.publish(this.serial,[value('info.connected',false,'Letzte Liveabfrage erfolgreich'),value('info.stale',true,'Liveantwort veraltet')]);
    }finally{this.publisher.close();}
  }
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={Runtime};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.2.3.1 (10.11.2026): 
// - Lesbaren Sicherungsstatus beim Start und bei jedem Statuswechsel für die Liveanzeige bereitstellen.
//
// 0.2.3.0 (10.11.2026): 
// - Optionale externe Ertragssicherung, Status und serialisierte Wiederherstellung ergänzen.
//
// 0.2.2.0 (09.11.2026): 
// - Persistente Ertragsarchive und Tagesdurchschnitt pro Anlage/PV ergänzen; Bestände vor Tageswechsel sichern.
//
// 0.2.1.2 (08.11.2026): 
// - Warnungslisten für den Fehlercode auswerten und bestätigte Werte vor reinen Alarmbestätigungen schützen.
//
// 0.2.1.1 (07.11.2026): 
// - Verbindungsfehler und Wiederverbindung ohne Logmeldungen behandeln; Status und Wiederanlauf beibehalten.
//
// 0.2.1.0 (07.11.2026): 
// - Den aktuellen Wechselrichter-Fehlercode aus der Alarmabfrage veröffentlichen.

// 0.2.0.0 (07.11.2026): 
// - Die vereinfachte Datenstruktur und die Online-/Offline-Markierung verwenden.
//
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
