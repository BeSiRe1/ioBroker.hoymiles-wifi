// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Adapter
//
// Startet und beendet die lokale Hoymiles-DTU-Anbindung.
//
// Version: 0.1.1.1 (10.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Initialisierung
// [BLOCK:200] Adapterklasse
// [BLOCK:900] Adapterstart und Export
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Initialisierung
// ============================================================
'use strict';
const {Adapter}=require('@iobroker/adapter-core');
const {Publisher}=require('./lib/publisher');
const {Runtime}=require('./lib/runtime');
const {formatBackupStatus}=require('./lib/backup');
// ============================================================

// ============================================================
// [BLOCK:200] Adapterklasse
// ============================================================
class HoymilesWifi extends Adapter{
  constructor(options={}){
    super({...options,name:'hoymiles-wifi'});
    this.unloading=false;
    this.on('ready',()=>this.onReady().catch(error=>this.log.error(`Adapterstart fehlgeschlagen: ${error.code||'INITIALIZATION_FAILED'}`)));
    this.on('unload',callback=>this.onUnload(callback));
    this.on('message',message=>this.onMessage(message).catch(()=>{if(message?.callback)this.sendTo(message.from,message.command,{error:'BACKUP_COMMAND_FAILED'},message.callback);}));
  }
  async onReady(){
    if(this.unloading)return;
    this.publisher=new Publisher(this);
    await this.publisher.publish('',[{id:'info.connection',val:false,name:'DTU-Verbindung',type:'boolean',role:'indicator.connected'}]);
    if(this.unloading)return;
    if(!String(this.config.host||'').trim()){this.log.warn('Bitte die IP-Adresse oder den Hostnamen der DTU in den Instanzeinstellungen eintragen.');return;}
    this.runtime=new Runtime({config:this.config,publisher:this.publisher,log:this.log});await this.runtime.start();
  }
  async onUnload(callback){
    this.unloading=true;
    try{await this.runtime?.stop();if(!this.runtime){await this.setStateAsync('info.connection',{val:false,ack:true});this.publisher?.close();}}
    catch{this.log.debug('Verbindung wurde beim Beenden geschlossen.');}
    finally{callback();}
  }
  async onMessage(message){
    if(!message?.callback||!['yieldBackupStatus','yieldBackupRestore'].includes(message.command))return;
    if(!this.runtime){this.sendTo(message.from,message.command,{error:'ADAPTER_NOT_READY'},message.callback);return;}
    if(message.command==='yieldBackupRestore'){this.sendTo(message.from,message.command,await this.runtime.restoreBackup(),message.callback);return;}
    const state=await this.runtime.backupStatus();
    const text=formatBackupStatus(state);
    this.sendTo(message.from,message.command,{text,result:text},message.callback);
  }
}
// ============================================================

// ============================================================
// [BLOCK:900] Adapterstart und Export
// ============================================================
if(require.main!==module)module.exports=options=>new HoymilesWifi(options);else new HoymilesWifi();
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.1.1.1 (10.11.2026): 
// - Statusabfrage und automatische Statusanzeige mit derselben Textformatierung versorgen.
//
// 0.1.1.0 (10.11.2026): 
// - Nachrichten für Sicherungsstatus und Wiederherstellung aus der Adapterkonfiguration anbinden.
//
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
