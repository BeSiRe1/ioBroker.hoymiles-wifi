// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Ertragsarchiv
//
// Speichert bestätigte Tagesstände und führt Monats- und Jahreserträge fort.
//
// Version: 0.1.0.0 (09.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Initialisierung und Prüfung
// [BLOCK:200] Datenübernahme
// [BLOCK:300] Ertragsarchiv
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Initialisierung und Prüfung
// ============================================================
'use strict';
const {day,ZONE}=require('./daily');
const SCALE=1000000;
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=()=>{throw Error('INVALID_YIELD_STORAGE');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const scopeId=value=>value==='grid'||/^pv\d+$/.test(value);
function energy(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail();const result=Math.round(value*SCALE);if(!integer(result))fail();return result;}
function add(a,b){const result=a+b;if(!integer(result))fail();return result;}
function isoDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail();const parsed=new Date(value+'T12:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)fail();return value;}
function dateFromText(value){if(typeof value!=='string'||!/^\d{2}\.\d{2}\.\d{4}$/.test(value))fail();return isoDate(value.slice(6)+'-'+value.slice(3,5)+'-'+value.slice(0,2));}
const dateText=value=>value.slice(8)+'.'+value.slice(5,7)+'.'+value.slice(0,4);
function period(value,size){if(typeof value!=='string'||!(size===7?/^\d{4}-(0[1-9]|1[0-2])$/:/^\d{4}$/).test(value))fail();return value;}
function monthFromText(value){if(typeof value!=='string'||!/^\d{2}\.\d{4}$/.test(value))fail();return period(value.slice(3)+'-'+value.slice(0,2),7);}
const monthText=value=>value.slice(5)+'.'+value.slice(0,4);
const formatted=value=>String(Math.round(value/10000)/100);
const textMatches=(text,amount)=>{const parsed=parsedEnergy(text);return parsed===amount||parsed===energy(Number(formatted(amount)));};
function parsedEnergy(value){if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value))fail();return energy(Number(value));}
function emptyScope(){return {days:{},months:{},years:{},closedMonths:{},closedYears:{},averageSum:0,averageCount:0,startDate:'',imported:false};}
function missingQuality(scope,today){
  const ordinal=value=>Date.parse(value+'T00:00:00Z')/86400000;
  const label=value=>new Date(value*86400000).toISOString().slice(0,10);
  const end=ordinal(today)-1,ranges=[];let count=0,cursor=scope.startDate?ordinal(dateFromText(scope.startDate)):end+1;
  const append=(from,to)=>{if(from<=to){const days=to-from+1;ranges.push({from:label(from),to:label(to),days});count+=days;}};
  for(const date of Object.keys(scope.days).sort()){
    if(!scope.days[date].final)continue;const index=ordinal(date);if(index<cursor||index>end)continue;
    append(cursor,index-1);cursor=index+1;
  }
  append(cursor,end);
  return {completeness:'notGuaranteed',missingDayCount:count,missingDayRanges:ranges};
}
function validateScope(scope,today){
  if(!object(scope)||!object(scope.days)||!object(scope.months)||!object(scope.years)||!object(scope.closedMonths)||!object(scope.closedYears)||!integer(scope.averageSum)||!integer(scope.averageCount)||typeof scope.imported!=='boolean')fail();
  if(scope.startDate){if(dateFromText(scope.startDate)>today)fail();}else if(scope.startDate!=='')fail();
  if(scope.averageCount===0&&scope.averageSum!==0)fail();
  for(const [date,item]of Object.entries(scope.days)){
    isoDate(date);if(date>today||!object(item)||!integer(item.energy)||!integer(item.monthCredit)||!integer(item.yearCredit)||!integer(item.averageCredit)||typeof item.final!=='boolean'||typeof item.counted!=='boolean'||typeof item.imported!=='boolean'||typeof item.observed!=='boolean'||typeof item.text!=='string')fail();
    if(item.text&&!textMatches(item.text,item.energy))fail();
    if(item.final&&!item.text)fail();
    if(item.monthCredit>item.energy||item.yearCredit>item.energy||item.averageCredit>item.energy)fail();
  }
  for(const [key,value]of Object.entries(scope.months)){period(key,7);if(key>today.slice(0,7)||!integer(value))fail();}
  for(const [key,value]of Object.entries(scope.years)){period(key,4);if(key>today.slice(0,4)||!integer(value))fail();}
  for(const [key,text]of Object.entries(scope.closedMonths)){period(key,7);if(!Object.hasOwn(scope.months,key)||!textMatches(text,scope.months[key]))fail();}
  for(const [key,text]of Object.entries(scope.closedYears)){period(key,4);if(!Object.hasOwn(scope.years,key)||!textMatches(text,scope.years[key]))fail();}
}
// ============================================================

// ============================================================
// [BLOCK:200] Datenübernahme
// ============================================================
function seedArchive(now,inputs){
  const today=day(now),state={schema:1,zone:ZONE,day:today,scopes:{}};
  if(!object(inputs))fail();
  for(const [id,input]of Object.entries(inputs)){
    if(!scopeId(id)||!object(input))fail();
    const scope=state.scopes[id]=emptyScope();scope.imported=true;
    for(const [kind,rows]of [['days',input.days||[]],['months',input.months||[]],['years',input.years||[]]]){
      if(!Array.isArray(rows))fail();
      for(const row of rows){
        if(!object(row))fail();
        const key=kind==='days'?dateFromText(row.Datum):kind==='months'?monthFromText(row.Datum):period(row.Jahr,4),amount=parsedEnergy(row.Ertrag);
        if(key>today.slice(0,key.length)||Object.hasOwn(scope[kind],key))fail();
        if(kind==='days')scope.days[key]={energy:amount,monthCredit:amount,yearCredit:amount,averageCredit:amount,final:true,counted:true,text:row.Ertrag,imported:true,observed:false};
        else{scope[kind][key]=amount;scope[kind==='months'?'closedMonths':'closedYears'][key]=row.Ertrag;}
      }
    }
    for(const [kind,inputKey,size]of [['months','month',7],['years','year',4]])if(input[inputKey]!==undefined){
      const anchor=input[inputKey];if(!object(anchor))fail();const key=period(anchor.period,size);if(key!==today.slice(0,size))fail();
      scope[kind][key]=energy(anchor.value);
      delete scope[kind==='months'?'closedMonths':'closedYears'][key];
    }
    if(input.average!==undefined){if(!object(input.average)||!integer(input.average.count))fail();scope.averageCount=input.average.count;scope.averageSum=energy(input.average.sum);}
    else{scope.averageCount=Object.keys(scope.days).length;scope.averageSum=Object.values(scope.days).reduce((sum,item)=>add(sum,item.energy),0);}
    if(input.startDate!==undefined){dateFromText(input.startDate);scope.startDate=input.startDate;}
    else{const dates=Object.keys(scope.days).sort();if(dates.length)scope.startDate=dateText(dates[0]);}
    const supplied=input.todayCredited;
    if(supplied!==undefined||input.month?.creditedToday!==undefined||input.year?.creditedToday!==undefined){
      const credit=typeof supplied==='number'?{month:supplied,year:supplied,average:supplied}:supplied||{};if(!object(credit))fail();
      const existing=scope.days[today];
      const monthCredit=energy(input.month?.creditedToday??credit.month??(existing?existing.energy/SCALE:0));
      const yearCredit=energy(input.year?.creditedToday??credit.year??(existing?existing.energy/SCALE:0));
      const averageCredit=energy(credit.average??(existing?existing.energy/SCALE:0));
      const value=Math.max(existing?.energy||0,monthCredit,yearCredit,averageCredit);
      scope.days[today]={energy:value,monthCredit,yearCredit,averageCredit,final:existing?.final||false,counted:credit.counted??existing?.counted??false,text:existing?.text||'',imported:true,observed:false};
      if(existing&&value!==existing.energy)scope.days[today].text=formatted(value);
    }
    validateScope(scope,today);
  }
  return state;
}
// ============================================================

// ============================================================
// [BLOCK:300] Ertragsarchiv
// ============================================================
class YieldArchive{
  constructor(now,saved){
    const today=day(now);this.limitDay=today;
    if(saved!==undefined){
      if(!object(saved)||saved.schema!==1||saved.zone!==ZONE||!object(saved.scopes))fail();isoDate(saved.day);if(saved.day>today)throw Error('CLOCK_MOVED_BACKWARDS');
      for(const [id,scope]of Object.entries(saved.scopes)){if(!scopeId(id))fail();validateScope(scope,today);}
      this.state=clone(saved);
    }else this.state={schema:1,zone:ZONE,day:today,scopes:{}};
  }
  commit(scope,date,item){
    const month=date.slice(0,7),year=date.slice(0,4);
    scope.months[month]=add(scope.months[month]||0,item.energy-item.monthCredit);item.monthCredit=item.energy;
    scope.years[year]=add(scope.years[year]||0,item.energy-item.yearCredit);item.yearCredit=item.energy;
    scope.averageSum=add(scope.averageSum,item.energy-item.averageCredit);item.averageCredit=item.energy;
    if(!item.counted){scope.averageCount=add(scope.averageCount,1);item.counted=true;}
    item.final=true;item.text=formatted(item.energy);
    if(Object.hasOwn(scope.closedMonths,month))scope.closedMonths[month]=formatted(scope.months[month]);
    if(Object.hasOwn(scope.closedYears,year))scope.closedYears[year]=formatted(scope.years[year]);
  }
  closePeriods(scope,today){
    for(const [key,value]of Object.entries(scope.months))if(key<today.slice(0,7)&&!Object.hasOwn(scope.closedMonths,key))scope.closedMonths[key]=formatted(value);
    for(const [key,value]of Object.entries(scope.years))if(key<today.slice(0,4)&&!Object.hasOwn(scope.closedYears,key))scope.closedYears[key]=formatted(value);
  }
  observe(dailyState){
    if(!object(dailyState)||dailyState.schema!==1||dailyState.zone!==ZONE||!object(dailyState.counters))fail();const date=isoDate(dailyState.day);if(date>this.limitDay)fail();
    for(const [id,counter]of Object.entries(dailyState.counters)){
      if(!/^(grid|pv\d+)\.dailyEnergy$/.test(id)||!counter||counter.confirmed!==true)continue;
      const amount=energy(counter.value),scopeId=id.split('.')[0],scope=this.state.scopes[scopeId]||(this.state.scopes[scopeId]=emptyScope());
      if(!scope.startDate||date<dateFromText(scope.startDate))scope.startDate=dateText(date);
      const item=scope.days[date]||(scope.days[date]={energy:0,monthCredit:0,yearCredit:0,averageCredit:0,final:false,counted:false,text:'',imported:false,observed:false});
      if(amount<item.energy)continue;
      const changed=amount!==item.energy;item.energy=amount;item.observed=true;
      if(date<this.state.day||item.final){if(changed||!item.final)this.commit(scope,date,item);}
      this.closePeriods(scope,this.state.day);
    }
  }
  roll(now){
    const today=day(now);if(today<this.state.day)throw Error('CLOCK_MOVED_BACKWARDS');this.limitDay=today;
    for(const scope of Object.values(this.state.scopes)){
      for(const [date,item]of Object.entries(scope.days))if(date<today&&!item.final)this.commit(scope,date,item);
      this.closePeriods(scope,today);
    }
    this.state.day=today;
  }
  serialize(){return JSON.stringify(this.state);}
  outputs(){
    const result={};
    for(const [id,scope]of Object.entries(this.state.scopes)){
      const sorted=value=>Object.keys(value).sort().reverse(),month=this.state.day.slice(0,7),year=this.state.day.slice(0,4);
      let monthAmount=scope.months[month]||0,yearAmount=scope.years[year]||0;
      for(const [date,item]of Object.entries(scope.days))if(!item.final){if(date.slice(0,7)===month)monthAmount=add(monthAmount,item.energy-item.monthCredit);if(date.slice(0,4)===year)yearAmount=add(yearAmount,item.energy-item.yearCredit);}
      const days=sorted(scope.days).filter(date=>scope.days[date].final);
      result[id]={daysJson:JSON.stringify(days.map(date=>({Datum:dateText(date),Ertrag:scope.days[date].text}))),monthsJson:JSON.stringify(sorted(scope.closedMonths).map(key=>({Datum:monthText(key),Ertrag:scope.closedMonths[key]}))),yearsJson:JSON.stringify(sorted(scope.closedYears).map(key=>({Jahr:key,Ertrag:scope.closedYears[key]}))),month:Number(formatted(monthAmount)),year:Number(formatted(yearAmount)),average:scope.averageCount?Number(formatted(scope.averageSum/scope.averageCount)):0,daysRecorded:scope.averageCount,startDate:scope.startDate,qualityJson:JSON.stringify({basis:'confirmedDailyCounters',imported:scope.imported,missingDaysFilled:false,coverage:'lastConfirmedValue',...missingQuality(scope,this.state.day),days:sorted(scope.days).map(date=>({date,status:scope.days[date].imported?'imported':'observed',final:scope.days[date].final,confirmed:scope.days[date].observed}))})};
    }
    return result;
  }
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={YieldArchive,seedArchive};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.1.0.0 (09.11.2026): 
// - Bestätigte Erträge mit getrennten Übernahmebasen und unveränderten historischen JSON-Strukturen speichern.
//
// ============================================================
