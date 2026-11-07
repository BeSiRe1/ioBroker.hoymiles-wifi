// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Betriebsdaten
//
// Maskiert Zugangsdaten und bereitet Betriebswerte und History auf.
//
// Version: 0.2.2.0 (07.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Initialisierung
// [BLOCK:200] Aufbereitung der Betriebsdaten
// [BLOCK:300] Alarmaufbereitung
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Initialisierung
// ============================================================
'use strict';
const crypto=require('node:crypto');
const alarmStates=require('./alarm-codes.json');
const sensitive=key=>/(password|passwd|passphrase|secret|token|enc_?rand|pass$|private_?key)/i.test(key);
// ============================================================

// ============================================================
// [BLOCK:200] Aufbereitung der Betriebsdaten
// ============================================================
function sanitize(value){
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!sensitive(key)).map(([key,item])=>[key,sanitize(item)]));
  return value;
}
function serial(value){try{const integer=BigInt(value);return integer>0?integer.toString(16).toUpperCase().padStart(12,'0'):undefined;}catch{return undefined;}}
const signed16=value=>{const n=Number(value)&65535;return n>=32768?n-65536:n;};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=value=>{if(typeof value==='number')return value;if(typeof value==='string'&&/^-?\d+$/.test(value)){const n=Number(value);if(Number.isSafeInteger(n))return n;}return undefined;};
function value(id,val,name,unit,role){
  if(val===undefined||val===null||typeof val==='number'&&!Number.isFinite(val))return undefined;
  return {id,val,name:name||id,type:typeof val,role:role||(typeof val==='boolean'?'indicator':typeof val==='number'?'value':'text'),...(unit?{unit}:{})};
}
function scaledFields(prefix,source,definitions){
  const result=[];
  for(const [field,suffix,scale,unit,name,convert]of definitions){
    const n=number(source[field]);if(n!==undefined)result.push(value(`${prefix}.${suffix}`,(convert?convert(n):n)/scale,name,unit));
  }
  return result.filter(Boolean);
}
const inverterFields=[
  ['active_power','power',10,'W','Wirkleistung'],['reactive_power','reactivePower',10,'var','Blindleistung',signed16],
  ['voltage','voltage',10,'V','Netzspannung'],['current','current',100,'A','Netzstrom'],['frequency','frequency',100,'Hz','Netzfrequenz'],
  ['power_factor','powerFactor',1000,undefined,'Leistungsfaktor'],['temperature','temperature',10,'°C','Temperatur',signed16],
  ['warning_number','warnCount',1,undefined,'Anzahl Warnungen'],['power_limit','powerLimit',10,'%','Gemeldetes Leistungslimit'],
  ['link_status','linkStatus',1,undefined,'Verbindungsstatus laut DTU'],['firmware_version','firmwareRaw',1,undefined,'Firmwarekennung'],
  ['modulation_index_signal','modulationIndex',1,undefined,'Modulationssignal'],['crc_checksum','checksum',1,undefined,'Prüfsumme'],
];
const pvFields=[['power','power',10,'W','Leistung'],['voltage','voltage',10,'V','Spannung'],['current','current',100,'A','Strom'],['energy_daily','dailyEnergy',1000,'kWh','Tagesertrag'],['energy_total','totalEnergy',1000,'kWh','Gesamtertrag'],['error_code','errorCode',1,undefined,'Fehlercode']];
function liveValues(data){
  const result=[];
  const inverters=(data.sgs_data||[]).map(x=>({active_power:0,reactive_power:0,voltage:0,current:0,frequency:0,power_factor:0,temperature:0,warning_number:0,link_status:0,...x})).sort((a,b)=>String(a.serial_number).localeCompare(String(b.serial_number)));
  const pvs=(data.pv_data||[]).map(x=>({power:0,voltage:0,current:0,energy_daily:0,energy_total:0,error_code:0,...x}));
  const measured=inverters.map(x=>number(x.active_power));
  if(inverters.length&&measured.every(x=>x!==undefined))result.push(value('grid.power',measured.reduce((a,b)=>a+b,0)/10,'Gesamtleistung','W','value.power'));
  else if(number(data.dtu_power)!==undefined)result.push(value('grid.power',number(data.dtu_power)/10,'Gesamtleistung laut DTU','W','value.power'));
  if(number(data.dtu_power)!==undefined||inverters.length)result.push(value('grid.dtuPower',(number(data.dtu_power)??0)/10,'Gesamtleistung laut DTU','W','value.power'));
  const daily=number(data.dtu_daily_energy);
  if(daily!==undefined)result.push(value('grid.dailyEnergy',daily/1000,'Tagesertrag laut DTU','kWh','value.energy'));
  else if(pvs.length&&pvs.every(x=>number(x.energy_daily)!==undefined))result.push(value('grid.dailyEnergy',pvs.reduce((sum,x)=>sum+number(x.energy_daily),0)/1000,'Summe der PV-Tageserträge','kWh','value.energy'));
  if(number(data.timestamp)!==undefined)result.push(value('info.packetTimestamp',number(data.timestamp)*1000,'Zeitstempel im DTU-Paket','ms','date'));
  for(const inverter of inverters){
    const sn=serial(inverter.serial_number);if(!sn)continue;
    const inputs=pvs.filter(p=>p.serial_number===inverter.serial_number).sort((a,b)=>Number(a.port_number)-Number(b.port_number));
    for(const input of inputs){
      const port=number(input.port_number);if(!Number.isInteger(port)||port<1||port>64)continue;
      if(inverters.length===1)result.push(...scaledFields(`pv${port-1}`,input,pvFields));
    }
  }
  if(inverters.length===1){
    const first=inverters[0];result.push(value('inverter.serialNumber',serial(first.serial_number),'Seriennummer'));
    for(const item of scaledFields('inverter',first,inverterFields))if(!['power','voltage','current','frequency','reactivePower','powerFactor'].includes(item.id.split('.').at(-1)))result.push(item);
    for(const item of scaledFields('grid',first,inverterFields))if(['voltage','current','frequency','reactivePower','powerFactor'].includes(item.id.split('.').at(-1)))result.push(item);
  }
  return result.filter(Boolean);
}
function historyValues(data){
  const result=[];
  if(Array.isArray(data.power_array))result.push(value('history.powerJson',JSON.stringify(data.power_array.map(x=>Number(x)/10)),'Leistungsverlauf','W','json'));
  for(const [field,id,scale,unit,name]of [['daily_energy','dailyEnergy',1,'Wh','Tagesertrag'],['total_energy','totalEnergy',1000,'kWh','Gesamtertrag'],['absolute_start','startTime',0.001,'ms','Beginn der Kurve'],['step_time','stepTime',1,'s','Abstand der Messpunkte'],['relative_power','relativePower',1,undefined,'Relative Leistung laut DTU'],['warning_number','warningNumber',1,undefined,'Warnungsanzahl']]){
    const n=number(data[field])??(['daily_energy','total_energy','warning_number'].includes(field)?0:undefined);if(n!==undefined)result.push(value(`history.${id}`,n/scale,name,unit,id==='startTime'?'date':undefined));
  }
  if(data.absolute_start&&data.step_time&&Array.isArray(data.power_array))result.push(value('history.pointsJson',JSON.stringify(data.power_array.map((power,index)=>({ts:(data.absolute_start+index*data.step_time)*1000,power:Number(power)/10}))),'Zeitlich zugeordnete Leistungskurve',undefined,'json'));
  else result.push(value('history.pointsJson','[]','Zeitlich zugeordnete Leistungskurve',undefined,'json'));
  result.push(value('history.timestampsAvailable',Boolean(data.absolute_start&&data.step_time),'Zeitliche Zuordnung verfügbar'));
  return result.filter(Boolean);
}
function infoValues(data){
  const result=[value('dtu.serialNumber',data.dtu_serial_number||data.dtu_sn,'DTU-Seriennummer')];
  const dtu=data.dtu_info||data.mDtuInfo||{};
  const mapping={dtu_sw_version:'softwareVersionRaw',dtu_hw_version:'hardwareVersionRaw',wifi_version:'wifiVersionRaw',dtu_rf_sw_version:'radioSoftwareVersionRaw',signal_strength:'signalStrength',dtu_error_code:'errorCode',communication_time:'communicationTime'};
  for(const [field,id]of Object.entries(mapping))if(Object.hasOwn(dtu,field))result.push(value(`dtu.${id}`,dtu[field],id,id==='signalStrength'?'%':id==='communicationTime'?'s':undefined));
  return result.filter(Boolean);
}
function signature(data){return crypto.createHash('sha256').update(JSON.stringify(sanitize({...data,timestamp:undefined,ap:undefined,cp:undefined}))).digest('hex');}
// ============================================================

// ============================================================
// [BLOCK:300] Alarmaufbereitung
// ============================================================
function alarmValues(result){
  const unknown=[{id:'inverter.errorCode',val:null,name:'Aktueller Wechselrichter-Fehlercode',type:'number',role:'value',states:alarmStates}];
  if(!result||!Array.isArray(result.messages))return unknown;
  const lists=result.messages.filter(message=>message?.data&&Array.isArray(message.data.warns)).map(message=>message.data.warns);
  if(!lists.length)return unknown;
  const records=lists.flat().map(item=>{
    if(!item||typeof item!=='object')return undefined;
    const code=item.code??0,start=item.s_time??0,end=item.e_time??0;
    if(!Number.isSafeInteger(code)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))return undefined;
    return {code,start,end};
  });
  if(records.some(item=>!item))return unknown;
  const active=records.filter(item=>item.end===0).sort((a,b)=>b.start-a.start);
  return [{...value('inverter.errorCode',active.length?active[0].code:0,'Aktueller Wechselrichter-Fehlercode'),states:alarmStates}];
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={sanitize,serial,liveValues,historyValues,infoValues,alarmValues,value,signature,sensitive};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.2.2.0 (07.11.2026): 
// - Alarmcodes mit Anzeigetexten sowie Signalqualität und Kommunikationszeit mit Einheiten ergänzen.
//
// 0.2.1.0 (07.11.2026): 
// - Aktuellen Wechselrichter-Fehlercode aus bestätigten aktiven Alarmdaten bereitstellen.

// 0.2.0.0 (07.11.2026): 
// - Rohdatenprojektion und doppelte Wechselrichter-/PV-Unterbäume entfernen.
//
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
