// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Abfragesteuerung
//
// Steuert Livewerte, Hintergrundabfragen, Datenalter und Wiederanlauf.
//
// Version: 0.2.1.1 (07.11.2026)
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
    try{this.daily=new Daily(this.now(),parsed);}catch(error){if(error.message==='CLOCK_MOVED_BACKWARDS')throw error;this.log.warn('Gespeicherter Tagesertrag ist ungültig; starte mit unbestätigtem Tagesstand.');this.daily=new Daily(this.now());}
    this.dailySerial=this.serial;this.dailyPersisted=saved?.val;this.dailyOutput=undefined;this.lastObservation=undefined;this.historyProof=undefined;
    await this.saveDaily();
  }
  async saveDaily(){
    if(this.closed||!this.daily)return;
    const stored=this.daily.serialize();
    if(stored!==this.dailyPersisted){await this.publisher.publish(this.serial,[value('internal.dailyEnergy',stored,'Gespeicherter Tagesertrag und Vortagsschutz',undefined,'json')]);this.dailyPersisted=stored;}
    const output=JSON.stringify({day:this.daily.state.day,values:this.daily.values(),confirmed:this.daily.confirmed()});
    if(output!==this.dailyOutput){await this.publisher.publish(this.serial,[...Object.entries(this.daily.values()).map(([id,val])=>value(id,val,'Tagesertrag mit Mitternachtsreset','kWh','value.energy')),value('info.dailyDay',this.daily.state.day,'Kalendertag des Tagesertrags'),value('info.dailyConfirmed',this.daily.confirmed(),'Heutiger Tagesertrag bestätigt')],'daily');this.dailyOutput=output;}
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
        const normalized=task.name==='history'?historyValues(data):task.name==='information'?infoValues(data):task.name==='alarms'?alarmValues(data):[];
        await this.publisher.publish(this.serial,normalized,task.name);
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
        if(task.name==='alarms')await this.publisher.publish(this.serial,alarmValues(undefined),'alarms');
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
    this.started=true;await this.restoreIdentity();if(this.closed)return;
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
