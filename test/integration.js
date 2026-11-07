'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');
const assert=require('node:assert/strict');
const net=require('node:net');
const {frame,encode,decode}=require('../lib/protocol');
const {Daily}=require('../lib/daily');

tests.integration(path.join(__dirname, '..'),{
  defineAdditionalTests({suite}){
    suite('Configured DTU reading and clean shutdown',getHarness=>{
      let server,harness;const sockets=new Set(),requests=[];let liveCount=0,historyStart=0;
      const sn='4143A0000001',inverter=BigInt('0x1412A0000001').toString();
      before(async()=>{
        harness=getHarness();
        server=net.createServer(socket=>{
          sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
          socket.once('data',request=>{
            const tag=request.readUInt16BE(2),sequence=request.readUInt16BE(4);requests.push({tag,at:performance.now()});
            let type,data;
            if(tag===0xa301){type='APPInfoDataReqDTO';data={dtu_serial_number:sn,package_number:1,device_number:1,pv_number:1,dtu_info:{dfs:0}};}
            else if(tag===0xa311){liveCount++;type='RealDataNewReqDTO';data={device_serial_number:sn,timestamp:Math.floor(Date.now()/1000),ap:1,sgs_data:[{serial_number:inverter,active_power:1000+liveCount,voltage:2300,current:43}],pv_data:[{serial_number:inverter,port_number:1,power:1100,energy_total:123456,energy_daily:123}],dtu_power:String(1000+liveCount),dtu_daily_energy:'123'};}
            else if(tag===0xa315){const cp=decode('AppGetHistPowerResDTO',request.subarray(10)).cp||0;if(cp===0)historyStart=Math.floor(Date.now()/1000);type='AppGetHistPowerReqDTO';data={serial_number:inverter,ap:2,cp,absolute_start:historyStart+cp*45000,step_time:60,power_array:Array(750).fill(cp?200:100),total_energy:123456,daily_energy:123};}
            else if(tag===0xa309){type='GetConfigReqDTO';data={wifi_rssi:-60,wifi_ssid:'fixture-network',wifi_password:'fixture-secret',dtu_ap_pass:'fixture-secret'};}
            else {socket.destroy();return;}
            const reply=frame(tag&0xfeff,sequence,encode(type,data));socket.write(reply.subarray(0,7));setTimeout(()=>socket.end(reply.subarray(7)),3);
          });
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        await harness.changeAdapterConfig('hoymiles-wifi',{native:{host:'127.0.0.1',port:server.address().port,interval:35,timeout:3,historyInterval:300}});
        const namespace='hoymiles-wifi.0.';
        const object=async(id,type)=>new Promise((resolve,reject)=>harness.objects.setObject(namespace+id,{_id:namespace+id,type,common:type==='state'?{name:id,type:'string',role:'text',read:true,write:false}:{name:id},native:{}},error=>error?reject(error):resolve()));
        for(const [id,type]of [[sn,'device'],[sn+'.inverter','channel'],[sn+'.pv0','channel'],['info.deviceIdentity','state'],[sn+'.internal.dailyEnergy','state']])await object(id,type);
        const stored=new Daily(Date.now());stored.state.counters={'grid.dailyEnergy':{value:0.12,confirmed:true,boundary:null},'pv0.dailyEnergy':{value:0.12,confirmed:true,boundary:null}};
        const state=async(id,val)=>new Promise((resolve,reject)=>harness.states.setState(namespace+id,{val,ack:true},error=>error?reject(error):resolve()));
        await state('info.deviceIdentity',JSON.stringify({host:'127.0.0.1',port:server.address().port,serial:sn}));await state(sn+'.internal.dailyEnergy',stored.serialize());
      });
      after(async()=>{await harness?.stopAdapter();for(const socket of sockets)socket.destroy();if(server)await new Promise(resolve=>server.close(resolve));});
      it('omits duplicate folders, retains daily counters, links online status and reads history on schedule',async function(){
        this.timeout(90000);await harness.startAdapterAndWait(true);
        const state=id=>new Promise((resolve,reject)=>harness.states.getState('hoymiles-wifi.0.'+id,(error,item)=>error?reject(error):resolve(item)));
        const object=id=>new Promise((resolve,reject)=>harness.objects.getObject('hoymiles-wifi.0.'+id,(error,item)=>error?reject(error):resolve(item)));
        const until=async(predicate,timeout=65000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Expected test state not reached');};
        const first=await until(()=>state(sn+'.info.lastResponse'));
        const curve=await until(()=>state(sn+'.history.powerJson'));
        assert.equal(JSON.parse(curve.val).length,1500);
        assert.equal((await until(()=>state(sn+'.history.startTime'))).val,historyStart*1000);
        assert.equal((await until(()=>state(sn+'.history.totalEnergy'))).val,123.456);
        await until(async()=>{const next=await state(sn+'.info.lastResponse');return next?.val>first.val;});
        await until(async()=>{const result=await state(sn+'.info.capabilities');return result&&JSON.parse(result.val).config?.status==='available';});
        assert.ok((await state(sn+'.grid.power')).val>=100.2);
        for(const id of [sn+'.raw',sn+'.raw.old',sn+'.raw.config.json',sn+'.inverters',sn+'.inverters.ABC.pv0'])assert.ok(!(await object(id)),id+' must be absent');
        for(const id of [sn+'.inverter',sn+'.pv0'])assert.ok(await object(id));
        assert.equal((await object(sn)).common.statusStates.onlineId,'info.connected');assert.equal((await state(sn+'.info.connected')).val,true);
        const persisted=JSON.parse((await state(sn+'.internal.dailyEnergy')).val);assert.ok(Object.keys(persisted.counters).every(id=>!id.startsWith('inverters.')));
        assert.equal((await state(sn+'.grid.dailyEnergyDtu')).val,0.123);
        const curveDay=await until(()=>state(sn+'.history.curveDay'));const counterDay=await state(sn+'.info.dailyDay');
        if(curveDay.val===counterDay.val){assert.equal((await until(async()=>{const item=await state(sn+'.info.dailyConfirmed');return item?.val===true?item:null;})).val,true);assert.equal((await state(sn+'.grid.dailyEnergy')).val,0.123);}
        assert.ok(liveCount>=2);assert.equal(harness.getLogs('error').length,0);
        for(let i=1;i<requests.length;i++)assert.ok(requests[i].at-requests[i-1].at>=1900);
        await harness.stopAdapter();const count=requests.length;await new Promise(resolve=>setTimeout(resolve,200));assert.equal(requests.length,count);
        assert.equal((await state('info.connection')).val,false);
      });
    });
  }
});
