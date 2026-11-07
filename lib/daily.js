// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Tageserträge
//
// Setzt Tageserträge um Mitternacht zurück und sperrt alte Vortagesstände.
//
// Version: 0.2.0.0 (07.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Initialisierung
// [BLOCK:200] Datum und Mitternacht
// [BLOCK:300] Tagesertrag und Vortagsschutz
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Initialisierung
// ============================================================
'use strict';
const ZONE='Europe/Berlin';
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const validNumber=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const validId=id=>id==='grid.dailyEnergy'||/^pv\d+\.dailyEnergy$/.test(id);
// ============================================================

// ============================================================
// [BLOCK:200] Datum und Mitternacht
// ============================================================
function day(time){const parts=formatter.formatToParts(new Date(time));const read=type=>parts.find(x=>x.type===type).value;return `${read('year')}-${read('month')}-${read('day')}`;}
function nextMidnight(now){
  const today=day(now);let low=Math.floor(now),high=low+30*3600000;
  while(high-low>1){const middle=Math.floor((low+high)/2);if(day(middle)===today)low=middle;else high=middle;}
  return high;
}
// ============================================================

// ============================================================
// [BLOCK:300] Tagesertrag und Vortagsschutz
// ============================================================
class Daily{
  constructor(now,saved){
    if(saved){
      if(saved.schema!==1||saved.zone!==ZONE||!/^\d{4}-\d{2}-\d{2}$/.test(saved.day)||!saved.counters||typeof saved.counters!=='object'||Array.isArray(saved.counters))throw Error('INVALID_DAILY_STORAGE');
      for(const [id,counter]of Object.entries(saved.counters))if(!validId(id)||!counter||!validNumber(counter.value)||typeof counter.confirmed!=='boolean'||!(counter.boundary===null||validNumber(counter.boundary)))throw Error('INVALID_DAILY_STORAGE');
      this.state=JSON.parse(JSON.stringify(saved));
    }else this.state={schema:1,zone:ZONE,day:day(now),counters:{}};
    this.roll(now);
  }
  roll(now){
    const today=day(now);if(this.state.day===today)return false;
    if(this.state.day>today)throw Error('CLOCK_MOVED_BACKWARDS');
    for(const counter of Object.values(this.state.counters)){if(counter.confirmed)counter.boundary=counter.value;counter.value=0;counter.confirmed=false;}
    this.state.day=today;return true;
  }
  receive(values,now,observation,history){
    this.roll(now);
    const fresh=observation&&day(observation.startedAt)===this.state.day&&observation.receivedAt<=now&&now-observation.receivedAt<=300000;
    const historyFresh=history&&history.receivedAt<=now&&now-history.receivedAt<=300000&&history.start<=now&&day(history.start)===this.state.day&&validNumber(history.energy);
    const proof=(candidate,total)=>historyFresh&&validNumber(total)&&Math.abs(total-history.energy)<=0.01&&validNumber(candidate);
    for(const [id,candidate]of Object.entries(values)){
      if(!validId(id)||!validNumber(candidate))continue;
      const counter=this.state.counters[id]||(this.state.counters[id]={value:0,confirmed:false,boundary:null});
      if(!fresh)continue;
      const matched=proof(candidate,id==='grid.dailyEnergy'?candidate:observation.pvSum);
      if(!counter.confirmed){if(!(candidate===0||(counter.boundary!==null&&candidate<counter.boundary)||matched))continue;counter.confirmed=true;}
      if(candidate<counter.value)continue;
      if(counter.boundary!==null&&candidate===counter.boundary&&counter.value<counter.boundary&&!matched)continue;
      counter.value=candidate;
    }
  }
  values(){return Object.fromEntries(Object.entries(this.state.counters).map(([id,counter])=>[id,counter.value]));}
  confirmed(){const counters=Object.values(this.state.counters);return counters.length>0&&counters.every(x=>x.confirmed);}
  serialize(){return JSON.stringify(this.state);}
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={Daily,day,nextMidnight,ZONE};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.2.0.0 (07.11.2026): 
// - Tageszähler auf Gesamtwert und direkte PV-Kanäle begrenzen; Neustartschutz erhalten.
//
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
