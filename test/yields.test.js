'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {YieldArchive,seedArchive}=require('../lib/yields');
const {ZONE}=require('../lib/daily');
const at=text=>Date.parse(text);
const today=at('2026-11-09T12:00:00+01:00');
const sample=(date,values)=>({schema:1,zone:ZONE,day:date,counters:Object.fromEntries(Object.entries(values).map(([id,item])=>[id+'.dailyEnergy',typeof item==='number'?{value:item,confirmed:true,boundary:null}:item]))});
const saved=archive=>JSON.parse(archive.serialize());
test('confirmed absolute counters are archived once per date and unconfirmed PV values are excluded',()=>{
  const archive=new YieldArchive(today);
  archive.observe(sample('2026-11-09',{grid:1,pv0:0.6,pv1:{value:0.4,confirmed:false}}));
  assert.deepEqual(Object.keys(archive.outputs()).sort(),['grid','pv0']);assert.equal(archive.outputs().grid.daysJson,'[]');
  const before=archive.serialize();archive.observe(sample('2026-11-09',{grid:1,pv0:0.6}));assert.equal(archive.serialize(),before);
  archive.observe(sample('2026-11-09',{grid:0.5}));assert.equal(archive.serialize(),before);
  archive.roll(at('2026-11-10T00:00:00+01:00'));
  assert.deepEqual(JSON.parse(archive.outputs().grid.daysJson),[{Datum:'09.11.2026',Ertrag:'1'}]);
  assert.equal(archive.outputs().grid.month,1);assert.equal(archive.outputs().grid.daysRecorded,1);assert.equal(archive.outputs().grid.average,1);
  const restored=new YieldArchive(at('2026-11-10T12:00:00+01:00'),saved(archive));restored.roll(at('2026-11-10T12:00:00+01:00'));
  assert.deepEqual(restored.outputs(),archive.outputs());assert.equal(restored.outputs().pv0.daysRecorded,1);
});
test('personal import retains independent period and average anchors and different same-day credits',()=>{
  const input={grid:{days:[{Datum:'08.11.2026',Ertrag:'0.4'}],months:[{Datum:'10.2026',Ertrag:'40'}],years:[{Jahr:'2025',Ertrag:'250'}],month:{period:'2026-11',value:10,creditedToday:0},year:{period:'2026',value:100,creditedToday:0.2},average:{count:10,sum:20},startDate:'01.01.2026',todayCredited:{average:0,counted:false}}};
  const archive=new YieldArchive(today,seedArchive(today,input));
  archive.observe(sample('2026-11-09',{grid:0.25}));
  let output=archive.outputs().grid;assert.equal(output.month,10.25);assert.equal(output.year,100.05);assert.equal(output.daysRecorded,10);assert.equal(output.average,2);assert.equal(output.startDate,'01.01.2026');
  assert.deepEqual(JSON.parse(output.monthsJson),input.grid.months);assert.deepEqual(JSON.parse(output.yearsJson),input.grid.years);assert.deepEqual(JSON.parse(output.daysJson),input.grid.days);
  const identical=archive.serialize();archive.observe(sample('2026-11-09',{grid:0.25}));assert.equal(archive.serialize(),identical);
  archive.roll(at('2026-11-10T00:00:00+01:00'));output=archive.outputs().grid;
  assert.equal(output.daysRecorded,11);assert.equal(output.average,1.84);assert.deepEqual(JSON.parse(output.daysJson)[0],{Datum:'09.11.2026',Ertrag:'0.25'});
  const restored=new YieldArchive(at('2026-11-10T12:00:00+01:00'),saved(archive));restored.observe(sample('2026-11-10',{grid:0.4}));assert.equal(restored.outputs().grid.month,10.65);assert.equal(restored.outputs().grid.year,100.45);
});
test('an already imported current day contributes only further growth and is never counted twice',()=>{
  const seed=seedArchive(today,{grid:{days:[{Datum:'09.11.2026',Ertrag:'0.25'}],month:{period:'2026-11',value:10.25,creditedToday:0.25},year:{period:'2026',value:100,creditedToday:0.25},average:{count:11,sum:20.25},todayCredited:{average:0.25,counted:true}}});
  const archive=new YieldArchive(today,seed);archive.observe(sample('2026-11-09',{grid:0.3}));archive.roll(at('2026-11-10T00:00:00+01:00'));
  assert.equal(archive.outputs().grid.daysRecorded,11);assert.equal(JSON.parse(archive.outputs().grid.daysJson).length,1);assert.equal(archive.outputs().grid.month,10.3);
  assert.equal(archive.state.scopes.grid.averageSum,20300000);
  assert.deepEqual(new YieldArchive(at('2026-11-10T12:00:00+01:00'),saved(archive)).outputs(),archive.outputs());
});
test('sub-cent changes retain their precision instead of rounding every received increment',()=>{
  const archive=new YieldArchive(today);
  for(let n=1;n<=1000;n++)archive.observe(sample('2026-11-09',{grid:n/100000}));
  assert.equal(archive.outputs().grid.month,0.01);archive.roll(at('2026-11-10T00:00:00+01:00'));
  assert.equal(archive.state.scopes.grid.averageSum,10000);assert.equal(archive.outputs().grid.average,0.01);
});
test('previous persisted Daily state survives first offline installation after midnight',()=>{
  const now=at('2027-01-01T00:05:00+01:00'),archive=new YieldArchive(now);
  archive.observe(sample('2026-12-31',{grid:0.123,pv0:0.1}));archive.roll(now);
  const output=archive.outputs().grid;
  assert.deepEqual(JSON.parse(output.daysJson),[{Datum:'31.12.2026',Ertrag:'0.12'}]);assert.deepEqual(JSON.parse(output.monthsJson),[{Datum:'12.2026',Ertrag:'0.12'}]);assert.deepEqual(JSON.parse(output.yearsJson),[{Jahr:'2026',Ertrag:'0.12'}]);
  assert.equal(output.month,0);assert.equal(output.year,0);assert.equal(output.daysRecorded,1);
  archive.roll(at('2027-01-05T12:00:00+01:00'));assert.equal(JSON.parse(archive.outputs().grid.daysJson).length,1);assert.equal(JSON.parse(archive.outputs().grid.qualityJson).missingDaysFilled,false);
});
test('Berlin DST rollovers finalize dates rather than elapsed 24-hour windows',()=>{
  for(const [start,date,end]of [['2026-03-29T00:00:00+01:00','2026-03-29','2026-03-30T00:00:00+02:00'],['2026-10-25T00:00:00+02:00','2026-10-25','2026-10-26T00:00:00+01:00']]){
    const archive=new YieldArchive(at(start));archive.observe(sample(date,{grid:1}));archive.roll(at(end));assert.equal(archive.outputs().grid.daysRecorded,1);assert.equal(JSON.parse(archive.outputs().grid.daysJson).length,1);
  }
});
test('saved old-day counters can grow before a deferred restart rollover',()=>{
  const old=new YieldArchive(today);old.observe(sample('2026-11-09',{grid:0.2}));
  const now=at('2026-11-10T00:05:00+01:00'),restored=new YieldArchive(now,saved(old));
  restored.observe(sample('2026-11-09',{grid:0.3}));restored.roll(now);assert.equal(JSON.parse(restored.outputs().grid.daysJson)[0].Ertrag,'0.3');assert.equal(restored.outputs().grid.month,0.3);
  assert.throws(()=>restored.roll(today),/CLOCK_MOVED_BACKWARDS/);assert.throws(()=>new YieldArchive(today,saved(restored)),/CLOCK_MOVED_BACKWARDS/);
});
test('invalid imports and corrupt saved ledgers fail without changing caller data',()=>{
  const duplicate={grid:{days:[{Datum:'08.11.2026',Ertrag:'1'},{Datum:'08.11.2026',Ertrag:'2'}]}};
  assert.throws(()=>seedArchive(today,duplicate),/INVALID_YIELD_STORAGE/);
  for(const row of [{Datum:'31.02.2026',Ertrag:'1'},{Datum:'08.11.2026',Ertrag:'NaN'},{Datum:'08.11.2026',Ertrag:1},{Datum:'10.11.2026',Ertrag:'1'}])assert.throws(()=>seedArchive(today,{grid:{days:[row]}}),/INVALID_YIELD_STORAGE/);
  const archive=new YieldArchive(today);archive.observe(sample('2026-11-09',{grid:1}));const corrupted=saved(archive);corrupted.scopes.grid.days['2026-11-09'].monthCredit=2000000;
  const before=JSON.stringify(corrupted);assert.throws(()=>new YieldArchive(today,corrupted),/INVALID_YIELD_STORAGE/);assert.equal(JSON.stringify(corrupted),before);
  for(const input of [{month:{period:'2026-11',value:-1}},{average:{count:-1,sum:0}},{average:{count:0,sum:1}},{startDate:'10.11.2026'},{months:[{Datum:'10.2026',Ertrag:'1'},{Datum:'10.2026',Ertrag:'2'}]},{years:[{Jahr:'2025',Ertrag:'1'},{Jahr:'2025',Ertrag:'2'}]}])assert.throws(()=>seedArchive(today,{grid:input}),/INVALID_YIELD_STORAGE/);
  assert.throws(()=>archive.observe({...sample('2026-11-09',{grid:1}),schema:2}),/INVALID_YIELD_STORAGE/);
});
test('normal midnight rolls the ledger before receiving the new Daily date',()=>{
  const archive=new YieldArchive(today);archive.observe(sample('2026-11-09',{grid:0.5}));
  archive.roll(at('2026-11-10T00:00:00+01:00'));archive.observe(sample('2026-11-10',{grid:{value:0,confirmed:false}}));
  assert.equal(archive.outputs().grid.daysRecorded,1);assert.equal(archive.outputs().grid.month,0.5);assert.equal(JSON.parse(archive.outputs().grid.daysJson).length,1);
  archive.observe(sample('2026-11-10',{grid:0.1}));assert.equal(archive.outputs().grid.month,0.6);assert.equal(archive.outputs().grid.daysRecorded,1);
});
test('missing day ranges are explicit without inserting zero days into legacy JSON',()=>{
  const now=at('2026-05-17T12:00:00+02:00');
  const rows=[{Datum:'16.05.2026',Ertrag:'0.39'}];
  const archive=new YieldArchive(now,seedArchive(now,{grid:{days:rows,startDate:'10.05.2026',average:{count:1,sum:0.39}}}));
  let output=archive.outputs().grid,quality=JSON.parse(output.qualityJson);
  assert.deepEqual(JSON.parse(output.daysJson),rows);assert.equal(quality.completeness,'notGuaranteed');assert.equal(quality.missingDayCount,6);
  assert.deepEqual(quality.missingDayRanges,[{from:'2026-05-10',to:'2026-05-15',days:6}]);
  archive.roll(at('2026-05-19T12:00:00+02:00'));output=archive.outputs().grid;quality=JSON.parse(output.qualityJson);
  assert.deepEqual(JSON.parse(output.daysJson),rows);assert.equal(quality.missingDayCount,8);assert.equal(quality.missingDayRanges[1].days,2);
});
