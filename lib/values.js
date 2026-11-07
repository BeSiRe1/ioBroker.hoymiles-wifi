// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Betriebsdaten
//
// Maskiert Zugangsdaten und bereitet Betriebswerte und History auf.
//
// Version: 0.1.0.0 (07.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Initialisierung
// [BLOCK:200] Aufbereitung der Betriebsdaten
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Initialisierung
// ============================================================
'use strict';
const crypto=require('node:crypto');
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
const part=value=>String(value).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100)||'value';
const signed16=value=>{const n=Number(value)&65535;return n>=32768?n-65536:n;};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=value=>{if(typeof value==='number')return value;if(typeof value==='string'&&/^-?\d+$/.test(value)){const n=Number(value);if(Number.isSafeInteger(n))return n;}return undefined;};
function value(id,val,name,unit,role){
  if(val===undefined||val===null||typeof val==='number'&&!Number.isFinite(val))return undefined;
  return {id,val,name:name||id,type:typeof val,role:role||(typeof val==='boolean'?'indicator':typeof val==='number'?'value':'text'),...(unit?{unit}:{})};
}
function rawValues(topic,data){
  const clean=sanitize(data),values=[value(`raw.${topic}.json`,JSON.stringify(clean),`${topic}: vollständige Antwort`,undefined,'json')];
  let count=0;
  function visit(item,id,depth){
    if(depth>14||++count>5000)throw Error('RAW_DATA_LIMIT');
    if(Array.isArray(item)){
      if(item.every(x=>typeof x!=='object'||x===null)){values.push(value(id,JSON.stringify(item),id,undefined,'json'));return;}
      item.forEach((child,index)=>{
        const sn=child&&typeof child==='object'?serial(child.serial_number??child.pv_sn??child.mi_id):undefined;
        const key=sn?`sn${sn}${child.port_number!==undefined?'_port'+child.port_number:''}`:`item${index}`;
        visit(child,`${id}.${key}`,depth+1);
      });
    }else if(item&&typeof item==='object'){
      for(const [key,child]of Object.entries(item))visit(child,`${id}.${part(key)}`,depth+1);
    }else values.push(value(id,item));
  }
  for(const [key,item]of Object.entries(clean))visit(item,`raw.${topic}.fields.${part(key)}`,0);
  return values.filter(Boolean);
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
    result.push(value(`inverters.${sn}.serialNumber`,sn,'Seriennummer'));
    result.push(...scaledFields(`inverters.${sn}`,inverter,inverterFields));
    const inputs=pvs.filter(p=>p.serial_number===inverter.serial_number).sort((a,b)=>Number(a.port_number)-Number(b.port_number));
    for(const input of inputs){
      const port=number(input.port_number);if(!Number.isInteger(port)||port<1||port>64)continue;
      result.push(...scaledFields(`inverters.${sn}.pv${port-1}`,input,pvFields));
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
  for(const [field,id]of Object.entries(mapping))if(Object.hasOwn(dtu,field))result.push(value(`dtu.${id}`,dtu[field],id));
  return result.filter(Boolean);
}
function signature(data){return crypto.createHash('sha256').update(JSON.stringify(sanitize({...data,timestamp:undefined,ap:undefined,cp:undefined}))).digest('hex');}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={sanitize,serial,rawValues,liveValues,historyValues,infoValues,value,signature,sensitive};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
