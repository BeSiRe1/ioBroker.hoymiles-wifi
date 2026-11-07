'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');
const assert=require('node:assert/strict');
const net=require('node:net');
const {frame,encode,decode}=require('../lib/protocol');

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
      });
      after(async()=>{await harness?.stopAdapter();for(const socket of sockets)socket.destroy();if(server)await new Promise(resolve=>server.close(resolve));});
      it('publishes complete history, updates on schedule, masks secrets and stops cleanly',async function(){
        this.timeout(90000);await harness.startAdapterAndWait(true);
        const state=id=>new Promise((resolve,reject)=>harness.states.getState('hoymiles-wifi.0.'+id,(error,item)=>error?reject(error):resolve(item)));
        const until=async(predicate,timeout=65000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Expected test state not reached');};
        const first=await until(()=>state(sn+'.info.lastResponse'));
        const curve=await until(()=>state(sn+'.history.powerJson'));
        assert.equal(JSON.parse(curve.val).length,1500);
        assert.equal((await until(()=>state(sn+'.history.startTime'))).val,historyStart*1000);
        assert.equal((await until(()=>state(sn+'.history.totalEnergy'))).val,123.456);
        await until(async()=>{const next=await state(sn+'.info.lastResponse');return next?.val>first.val;});
        const config=await until(()=>state(sn+'.raw.config.json'));
        assert.ok(!config.val.includes('fixture-secret'));assert.ok((await state(sn+'.grid.power')).val>=100.2);
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
