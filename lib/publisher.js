// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Datenpunktausgabe
//
// Erstellt lesbare Datenpunkte und kennzeichnet fehlgeschlagene Abfragen.
//
// Version: 0.2.1.0 (07.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Initialisierung
// [BLOCK:200] Datenpunktausgabe
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Initialisierung
// ============================================================
'use strict';
// ============================================================

// ============================================================
// [BLOCK:200] Datenpunktausgabe
// ============================================================
class Publisher{
  constructor(adapter){this.adapter=adapter;this.known=new Set();this.groups=new Map();this.devices=new Set();this.closed=false;}
  read(prefix,id){return this.adapter.getStateAsync(prefix?`${prefix}.${id}`:id);}
  async folder(id,name=id,type='channel'){
    if(this.known.has(id)||this.closed)return;
    const parent=id.split('.').slice(0,-1).join('.');if(parent)await this.folder(parent);
    await this.adapter.setObjectNotExistsAsync(id,{type,common:{name},native:{}});this.known.add(id);
  }
  async device(id,name){
    if(!/^[A-F\d]{8,32}$/.test(id))throw Error('INVALID_DEVICE_ID');
    if(this.closed||this.devices.has(id))return;
    await this.folder(id,name,'device');
    if(this.closed)return;
    await this.adapter.extendObjectAsync(id,{common:{statusStates:{onlineId:'info.connected'}}});
    this.devices.add(id);
  }
  async publish(prefix,values,group){
    if(this.closed)return;
    const seen=new Set();
    for(const entry of values){
      if(!entry||this.closed)continue;
      const id=prefix?`${prefix}.${entry.id}`:entry.id;
      if(!this.known.has(id)){
        const parent=id.split('.').slice(0,-1).join('.');if(parent)await this.folder(parent);
        const common={name:entry.name,type:entry.type,role:entry.role,read:true,write:false};if(entry.unit)common.unit=entry.unit;
        if(entry.states)common.states=entry.states;
        await this.adapter.setObjectNotExistsAsync(id,{type:'state',common,native:{source:'local-dtu'}});
        const metadata={};if(entry.unit)metadata.unit=entry.unit;if(entry.states)metadata.states=entry.states;
        if(Object.keys(metadata).length)await this.adapter.extendObjectAsync(id,{common:metadata});
        this.known.add(id);
      }
      if(this.closed)return;
      await this.adapter.setStateAsync(id,{val:entry.val,ack:true,q:0});
      if(group)seen.add(id);
    }
    if(group&&!this.closed){for(const id of this.groups.get(group)||[]){if(!seen.has(id))await this.adapter.setStateAsync(id,{val:null,ack:true,q:0x40});}this.groups.set(group,seen);}
  }
  async invalidate(group){
    if(this.closed)return;
    for(const id of this.groups.get(group)||[]){
      if(this.closed)return;
      const previous=await this.adapter.getStateAsync(id);if(previous)await this.adapter.setStateAsync(id,{val:previous.val,ack:true,q:0x40});
    }
  }
  close(){this.closed=true;}
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={Publisher};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.2.1.0 (07.11.2026): 
// - Einheiten und Alarm-Wertelisten auch an bestehenden Datenpunktobjekten ergänzen.
//
// 0.2.0.0 (07.11.2026): 
// - Die Online-/Offline-Markierung am Geräteobjekt anbinden.
//
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
