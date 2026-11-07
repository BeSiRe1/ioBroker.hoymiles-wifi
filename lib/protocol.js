// ============================================================
// [BLOCK:000] Systemkopf
// ============================================================

// ************************************************************
// Hoymiles WiFi – Protokoll
//
// Liest DTU-Antworten mit geordneten Verbindungen und vollständiger Paketprüfung.
//
// Version: 0.1.0.0 (07.11.2026)
//
// ************************************************************
// ============================================================

// ============================================================
// BLOCK-NAVIGATION (STRG+F → BLOCK:XYZ)
// ============================================================
// [BLOCK:000] Systemkopf
// [BLOCK:100] Abhängigkeiten und Protokolldefinitionen
// [BLOCK:200] Rahmen und Datenkodierung
// [BLOCK:300] Verbindung und Warteschlange
// [BLOCK:400] DTU-Abfragen
// [BLOCK:900] Modulexport
// [BLOCK:1000] Änderungsverlauf
// ============================================================

// ============================================================
// [BLOCK:100] Abhängigkeiten und Protokolldefinitionen
// ============================================================
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const protobuf = require('protobufjs');
require('protobufjs/ext/descriptor');

const schema = protobuf.Root.fromDescriptor(fs.readFileSync(path.join(__dirname, '../protocol/hoymiles.desc')));
for(const file of ['WarnData','AlarmData','EventData'])protobuf.parse(fs.readFileSync(path.join(__dirname,`../protocol/${file}.proto`),'utf8'),schema,{keepCase:true});
// ============================================================

// ============================================================
// [BLOCK:200] Rahmen und Datenkodierung
// ============================================================
const COMMANDS = Object.freeze({info:0xa301, config:0xa309, live:0xa311, network:0xa314, history:0xa315, command:0xa305, heartbeat:0xa302});
const publicCommands = new Set([0xa301,0xa201,0xa302,0xa202]);
class ProtocolError extends Error { constructor(code) { super(code); this.code=code; } }
const assert = (condition,code) => {if(!condition) throw new ProtocolError(code);};

function crc16(bytes) {
  let crc=0xffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xa001:crc>>>1;}
  return crc;
}
function tripleHash(bytes){for(let i=0;i<3;i++)bytes=crypto.createHash('sha256').update(bytes).digest();return bytes;}
function crypt(bytes,random,tag,sequence,decrypt=false){
  assert(Buffer.isBuffer(random)&&random.length===16,'INVALID_ENCRYPTION_DATA');
  const aad=Buffer.alloc(4);aad.writeUInt16LE(tag,0);aad.writeUInt16LE(sequence,2);
  const key=tripleHash(random).subarray(0,16);
  const nonce=tripleHash(Buffer.concat([aad,random])).subarray(20,32);
  if(decrypt){
    assert(bytes.length>=16,'INCOMPLETE_AUTHENTICATION_TAG');
    const cipher=crypto.createDecipheriv('aes-128-gcm',key,nonce);cipher.setAAD(aad);cipher.setAuthTag(bytes.subarray(-16));
    try{return Buffer.concat([cipher.update(bytes.subarray(0,-16)),cipher.final()]);}catch{throw new ProtocolError('AUTHENTICATION_FAILED');}
  }
  const cipher=crypto.createCipheriv('aes-128-gcm',key,nonce);cipher.setAAD(aad);
  return Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
}
function encode(type,value){
  const message=schema.lookupType(type),normalized={...value};
  for(const field of message.fieldsArray){
    if(normalized[field.name]===undefined)continue;
    if(field.type==='bytes'&&typeof normalized[field.name]==='string')normalized[field.name]=Buffer.from(normalized[field.name],'utf8');
    if(field.type==='string'&&Buffer.isBuffer(normalized[field.name]))normalized[field.name]=normalized[field.name].toString('utf8');
    if(/^(u?int|sint|fixed|sfixed)64$/.test(field.type)){
      const values=field.repeated?normalized[field.name]:[normalized[field.name]];
      for(const item of values){
        assert((typeof item==='number'&&Number.isSafeInteger(item))||(typeof item==='string'&&/^-?\d+$/.test(item)),'INVALID_64_BIT_INTEGER');
        const integer=BigInt(item),unsigned=field.type==='uint64'||field.type==='fixed64';
        assert(integer>=(unsigned?0n:-(1n<<63n))&&integer<=(unsigned?(1n<<64n)-1n:(1n<<63n)-1n),'INTEGER_OUT_OF_RANGE');
      }
    }
  }
  const converted=message.fromObject(normalized),error=message.verify(converted);assert(!error,'INVALID_PROTOBUF_REQUEST');
  return Buffer.from(message.encode(converted).finish());
}
function decode(type,bytes){if(typeof type==='function')return type(bytes);const message=schema.lookupType(type);try{return message.toObject(message.decode(bytes),{longs:String,enums:Number,bytes:String,arrays:true,objects:true});}catch{throw new ProtocolError('INVALID_PROTOBUF_RESPONSE');}}
function decodeWarning(bytes){
  const reader=protobuf.Reader.create(bytes);let legacy=false;
  try{while(reader.pos<reader.len){const tag=reader.uint32();if((tag>>>3)===3&&(tag&7)===2)legacy=true;reader.skipType(tag&7);}}catch{throw new ProtocolError('INVALID_PROTOBUF_RESPONSE');}
  if(!legacy)return decode('WarnReqDTO',bytes);
  const data=decode('WInfoReqDTO',bytes);
  return {...data,warning_schema:'WInfoReqDTO',warns:(data.mWInfo||[]).map(w=>({...w,code:w.WCode??0,num:w.WNum??0,s_time:w.WTime1??0,e_time:w.WTime2??0,w_data1:w.WData1??0,w_data2:w.WData2??0}))};
}
function frame(tag,sequence,payload,{encrypted=false,random}={}){
  const useEncryption=encrypted&&!publicCommands.has(tag);
  const body=useEncryption?crypt(payload,random,tag,sequence):payload;
  const declared=10+body.length-(useEncryption?16:0);
  assert(declared<=65535,'FRAME_TOO_LARGE');
  const header=Buffer.alloc(10);header.write('HM');header.writeUInt16BE(tag,2);header.writeUInt16BE(sequence,4);header.writeUInt16BE(crc16(useEncryption?body.subarray(0,-16):body),6);header.writeUInt16BE(declared,8);
  return Buffer.concat([header,body]);
}
function frameLength(header,encrypted=false){
  assert(header.length>=10,'INCOMPLETE_HEADER');assert(header.subarray(0,2).toString()==='HM','INVALID_MAGIC');
  const declared=header.readUInt16BE(8);assert(declared>=10,'INVALID_LENGTH');
  return declared+(encrypted&&!publicCommands.has(header.readUInt16BE(2))?16:0);
}
function unframe(bytes,{encrypted=false,random,sequence,tag}={}){
  const length=frameLength(bytes,encrypted);assert(bytes.length===length,'INCOMPLETE_FRAME');
  const responseTag=bytes.readUInt16BE(2),responseSequence=bytes.readUInt16BE(4),declared=bytes.readUInt16BE(8);
  if(sequence!==undefined)assert(responseSequence===sequence,'SEQUENCE_MISMATCH');
  if(tag!==undefined)assert(responseTag===tag||responseTag===(tag&0xfeff),'COMMAND_MISMATCH');
  assert(crc16(bytes.subarray(10,declared))===bytes.readUInt16BE(6),'CRC_MISMATCH');
  const payload=encrypted&&!publicCommands.has(responseTag)?crypt(bytes.subarray(10),random,responseTag,responseSequence,true):bytes.subarray(10);
  return {tag:responseTag,sequence:responseSequence,payload};
}
// ============================================================

// ============================================================
// [BLOCK:300] Verbindung und Warteschlange
// ============================================================
class Transport {
  constructor({host,port=10081,timeoutMs=10000,gapMs=2000,strictSequence=false,connect=net.createConnection}={}){
    assert(typeof host==='string'&&host.trim().length>0,'INVALID_HOST');
    this.host=host;this.port=port;this.timeoutMs=timeoutMs;this.gapMs=Math.max(0,gapMs);this.connect=connect;this.strictSequence=strictSequence;this.sequenceMismatchCount=0;
    this.tail=Promise.resolve();this.lastClosedAt=0;this.closed=false;this.sequence=0;this.encrypted=false;this.random=undefined;this.controller=new AbortController();this.socket=undefined;
  }
  request(tag,requestType,responseType,request,collection){
    const operation=this.tail.then(()=>this.execute(tag,requestType,responseType,request,collection));
    this.tail=operation.catch(()=>{});return operation;
  }
  async execute(tag,requestType,responseType,request,collection){
    assert(!this.closed,'CLOSED');
    const remaining=this.gapMs-(performance.now()-this.lastClosedAt);
    if(remaining>0)try{await sleep(remaining,undefined,{signal:this.controller.signal});}catch{throw new ProtocolError('CLOSED');}
    assert(!this.closed,'CLOSED');
    this.sequence=(this.sequence+1)&0xffff;
    const sequence=this.sequence;
    const requestFrame=frame(tag,sequence,encode(requestType,request),this);
    let socket;
    try{
      return await new Promise((resolve,reject)=>{
        let done=false,buffer=Buffer.alloc(0),primary,followTimer;
        const messages=[];
        const collected=()=>({ack:primary??null,messages});
        const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(followTimer);this.rejectActive=undefined;if(error)reject(error);else resolve(value);};
        const finishOnEnd=code=>{if(collection&&(primary!==undefined||messages.length))finish(null,collected());else finish(new ProtocolError(code));};
        const timer=setTimeout(()=>finishOnEnd('TIMEOUT'),this.timeoutMs);
        this.rejectActive=()=>finish(new ProtocolError('CLOSED'));
        try{socket=this.connect({host:this.host,port:this.port});this.socket=socket;}catch{finish(new ProtocolError('CONNECT_FAILED'));return;}
        socket.setNoDelay?.(true);
        socket.once('connect',()=>{if(!done)socket.write(requestFrame);});
        socket.on('data',chunk=>{
          if(done)return;
          buffer=Buffer.concat([buffer,chunk]);
          try{
            assert(buffer.length<=1048576,'FRAME_TOO_LARGE');
            while(buffer.length>=10&&!done){
              const length=frameLength(buffer,this.encrypted);if(buffer.length<length)return;
              const packet=buffer.subarray(0,length);buffer=buffer.subarray(length);
              const decoded=unframe(packet,{encrypted:this.encrypted,random:this.random});
              if(decoded.tag===tag||decoded.tag===(tag&0xfeff)){
                if(this.strictSequence)assert(decoded.sequence===sequence,'SEQUENCE_MISMATCH');
                if(decoded.sequence!==sequence)this.sequenceMismatchCount++;
                this.lastResponseMeta={tag:decoded.tag,requestSequence:sequence,responseSequence:decoded.sequence,sequenceMatches:decoded.sequence===sequence};
                primary=decode(responseType,decoded.payload);
                if(!collection){finish(null,primary);return;}
              }else if(collection?.types[decoded.tag]){
                assert(messages.length<64,'TOO_MANY_FOLLOWUP_MESSAGES');
                messages.push({tag:decoded.tag,data:decode(collection.types[decoded.tag],decoded.payload)});
              }else throw new ProtocolError('COMMAND_MISMATCH');
              if(collection&&!followTimer&&(primary!==undefined||messages.length))followTimer=setTimeout(()=>{if(buffer.length)finish(new ProtocolError('INCOMPLETE_RESPONSE'));else finish(null,collected());},Math.min(collection.waitMs||5000,this.timeoutMs));
            }
          }catch(error){finish(error instanceof ProtocolError?error:new ProtocolError('DECODE_FAILED'));}
        });
        socket.once('error',()=>finish(new ProtocolError('SOCKET_ERROR')));
        socket.once('end',()=>{if(buffer.length)finish(new ProtocolError('INCOMPLETE_RESPONSE'));else finishOnEnd('INCOMPLETE_RESPONSE');});
        socket.once('close',()=>finishOnEnd('SOCKET_CLOSED'));
      });
    }finally{
      if(socket&&!socket.destroyed){
        await new Promise(resolve=>{
          const timer=setTimeout(()=>{socket.destroy();resolve();},250);
          socket.once('close',()=>{clearTimeout(timer);resolve();});
          socket.end();
        });
      }
      this.socket=undefined;this.lastClosedAt=performance.now();
    }
  }
  close(){this.closed=true;this.controller.abort();this.rejectActive?.();this.socket?.destroy();}
}
// ============================================================

// ============================================================
// [BLOCK:400] DTU-Abfragen
// ============================================================
function clockRequest(){const d=new Date();const part=x=>String(x).padStart(2,'0');return {time:Math.floor(d.getTime()/1000),offset:28800,time_ymd_hms:`${d.getFullYear()}-${part(d.getMonth()+1)}-${part(d.getDate())} ${part(d.getHours())}:${part(d.getMinutes())}:${part(d.getSeconds())}`};}
function mergePages(pages){
  const result={};
  for(const page of pages)for(const [key,value]of Object.entries(page)){if(Array.isArray(value))result[key]=[...(result[key]||[]),...value];else result[key]=value;}
  if(Object.hasOwn(pages[0],'absolute_start'))result.absolute_start=pages[0].absolute_start;
  return result;
}
class Dtu {
  constructor(options){this.transport=options instanceof Transport?options:new Transport(options);this.serial=undefined;}
  async initialize(){
    const info=await this.infoPages();
    assert(typeof info.dtu_serial_number==='string'&&/^[\dA-F]{8,32}$/i.test(info.dtu_serial_number),'INVALID_DTU_ID');
    this.serial=info.dtu_serial_number.toUpperCase();
    this.transport.encrypted=Boolean((Number(info.dtu_info?.dfs||0)>>>25)&1);
    if(this.transport.encrypted){const random=Buffer.from(info.dtu_info.enc_rand||'','base64');assert(random.length===16,'MISSING_ENCRYPTION_DATA');this.transport.random=random;}
    return info;
  }
  async infoPages(){
    const first=await this.transport.request(COMMANDS.info,'APPInfoDataResDTO','APPInfoDataReqDTO',{...clockRequest(),current_package:0});
    const pages=[first],total=first.package_number||1;assert(Number.isInteger(total)&&total>=1&&total<=64,'INVALID_PAGE_COUNT');
    for(let current=1;current<total;current++){
      const page=await this.transport.request(COMMANDS.info,'APPInfoDataResDTO','APPInfoDataReqDTO',{...clockRequest(),current_package:current});
      assert((page.package_number||1)===total&&page.current_package===current,'PAGE_MISMATCH');pages.push(page);
    }
    return mergePages(pages);
  }
  async paged(tag,requestType,responseType,request){
    const pages=[];
    const first=await this.transport.request(tag,requestType,responseType,{...request,cp:0});
    const total=first.ap||1;assert(Number.isInteger(total)&&total>=1&&total<=64,'INVALID_PAGE_COUNT');
    if(first.cp!==undefined)assert(first.cp===0,'PAGE_MISMATCH');
    pages.push(first);
    for(let cp=1;cp<total;cp++){
      const page=await this.transport.request(tag,requestType,responseType,{...request,cp});
      assert((page.ap||1)===total&&page.cp===cp,'PAGE_MISMATCH');
      if(first.serial_number!==undefined)assert(page.serial_number===first.serial_number,'SERIAL_MISMATCH');
      if(first.device_serial_number!==undefined)assert(page.device_serial_number===first.device_serial_number,'SERIAL_MISMATCH');
      pages.push(page);
    }
    return mergePages(pages);
  }
  async live(){
    const response=await this.paged(COMMANDS.live,'RealDataNewResDTO','RealDataNewReqDTO',clockRequest());
    if(this.serial&&response.device_serial_number)assert(response.device_serial_number.toUpperCase()===this.serial,'SERIAL_MISMATCH');
    assert(['sgs_data','tgs_data','pv_data','meter_data','rp_data','rsd_data'].some(k=>response[k]?.length)||Object.hasOwn(response,'dtu_power'),'EMPTY_MEASUREMENTS');
    return response;
  }
  history(day=0){assert(Number.isInteger(day)&&day>=0&&day<=31,'INVALID_HISTORY_DAY');return this.paged(COMMANDS.history,'AppGetHistPowerResDTO','AppGetHistPowerReqDTO',{offset:28800,requested_time:Math.floor(Date.now()/1000),requested_day:day}).then(data=>{assert(Boolean(data.serial_number)||data.request_time>0||data.absolute_start>0,'EMPTY_HISTORY');return data;});}
  config(){return this.transport.request(COMMANDS.config,'GetConfigResDTO','GetConfigReqDTO',{offset:28800,time:Math.floor(Date.now()/1000)-60});}
  network(){return this.transport.request(COMMANDS.network,'NetworkInfoResDTO','NetworkInfoReqDTO',{offset:28800,time:Math.floor(Date.now()/1000)});}
  information(){return this.transport.request(COMMANDS.info,'InfoDataResDTO','InfoDataReqDTO',clockRequest());}
  heartbeat(){return this.transport.request(COMMANDS.heartbeat,'HBResDTO','HBReqDTO',clockRequest());}
  async warnings(){
    const request={ymd_hms:clockRequest().time_ymd_hms,offset:28800,time:Math.floor(Date.now()/1000)};
    const first=await this.transport.request(0xa304,'WarnResDTO',decodeWarning,{...request,package_now:0});
    const total=first.package_nub||1,pages=[first];assert(Number.isInteger(total)&&total>=1&&total<=64,'INVALID_PAGE_COUNT');
    for(let current=1;current<total;current++){
      const page=await this.transport.request(0xa304,'WarnResDTO',decodeWarning,{...request,package_now:current});
      assert((page.package_nub||1)===total&&page.package_now===current,'PAGE_MISMATCH');pages.push(page);
    }
    return mergePages(pages);
  }
  readAction(action){assert([46,50].includes(action),'ACTION_NOT_ALLOWED');return this.transport.request(COMMANDS.command,'CommandResDTO','CommandReqDTO',{...clockRequest(),action,package_nub:1,dev_kind:action===50?0:1,tid:String(Math.floor(Date.now()/1000))},{types:{0xa204:decodeWarning,0xa218:'EventDataReqDTO',0xa206:'CommandStatusReqDTO'},waitMs:5000});}
  alarms(){return this.readAction(50);}
  events(){return this.readAction(46);}
  close(){this.transport.close();}
}
// ============================================================

// ============================================================
// [BLOCK:900] Modulexport
// ============================================================
module.exports={schema,COMMANDS,ProtocolError,crc16,crypt,encode,decode,decodeWarning,frame,unframe,frameLength,Transport,Dtu,clockRequest,mergePages};
// ============================================================

// ============================================================
// [BLOCK:1000] Änderungsverlauf
// ============================================================
// 0.1.0.0 (07.11.2026): 
// - Erste Entwicklungsfassung der lokalen Hoymiles-WLAN-Anbindung.
//
// ============================================================
