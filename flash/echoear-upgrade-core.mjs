import {retryableFlashRead,md5} from './echoear-flash-reader.mjs';
// Exact existing-device upgrade profile. No arbitrary-address or erase-all API.
export const PROFILE={board:'echoear-s3',flashSizes:['16MB','32MB'],table:0x8000,nvs:0x9000,nvsSize:0x4000,
 ota:0xd000,otaSize:0x2000,apps:[0x20000,0x410000],appSize:0x3f0000};
// Only regions this project can ever change are backed up. Assets, bootloader
// and the partition table are written by nothing here, and the 15MB of unused
// space is never read back.
export const REGIONS={table:{address:PROFILE.table,size:4096},otadata:{address:PROFILE.ota,size:PROFILE.otaSize},
 nvs:{address:PROFILE.nvs,size:PROFILE.nvsSize},app0:{address:PROFILE.apps[0],size:PROFILE.appSize},
 app1:{address:PROFILE.apps[1],size:PROFILE.appSize}};
export const SETTINGS_REGIONS=['table','otadata','nvs'],FULL_REGIONS=['table','otadata','nvs','app0','app1'];
const fail=code=>{throw new Error(code);};
export const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
// Only verified complete blocks advance progress. Backup callers may reconnect
// after a transient read failure, with a global cap and identity/snapshot check.
export async function readFlashBounded(loader,address,size,progress=()=>{},options={}){
 const data=new Uint8Array(size),chunkSize=64*1024;let active=loader,recoveries=0,blockRecoveries=0;
 for(let offset=0;offset<size;){
  const length=Math.min(chunkSize,size-offset);let chunk;
  try{
   chunk=await active.readFlash(address+offset,length);
   if(!(chunk instanceof Uint8Array)||chunk.length!==length)fail('flash_read_incomplete');
  }catch(error){
   if(!options.recover||recoveries>=8||blockRecoveries>=2||!retryableFlashRead(error))throw error;
   blockRecoveries++;active=await options.recover({attempt:++recoveries,address:address+offset,completed:data.subarray(0,offset)});
   if(!active||typeof active.readFlash!=='function')fail('flash_recovery_failed');
   continue;
  }
  blockRecoveries=0;data.set(chunk,offset);offset+=length;progress(chunk,offset,size);
 }
 return data;
}
export const regionBytes=names=>names.reduce((total,name)=>total+REGIONS[name].size,0);
// Read named regions in one pass. Regions that already exist in `previous` and
// whose on-device digest is unchanged are reused, so a repeat backup only pays
// for what actually changed.
export async function readDeviceRegions(loader,names,previous=null,progress=()=>{},options={}){
 const total=regionBytes(names),data={};let done=0,active=loader,recoveries=0;
 const reconnect=async value=>{
  if(!options.recover||recoveries>=8)fail('flash_recovery_failed');
  const next=await options.recover({...value,attempt:++recoveries,completed:done});
  if(!next||typeof next.readFlash!=='function')fail('flash_recovery_failed');
  return(active=next);
 };
 for(const name of names){
  const {address,size}=REGIONS[name];
  // Settings live in the first 64KB and are cheap: never trust a cached copy.
  const reusable=name.startsWith('app')&&previous?.[name]?.length===size&&typeof active.flashMd5sum==='function';
  let unchanged=false;
  if(reusable){
   try{unchanged=(await active.flashMd5sum(address,size)).toLowerCase()===hex(md5(previous[name]));}
   catch(error){
    // No guessing after a broken checksum command. Reconnect before reading.
    if(!options.recover)throw error;
    await reconnect({name,address});
   }
  }
  if(unchanged)data[name]=previous[name].slice();
  else data[name]=await readFlashBounded(active,address,size,(_chunk,read)=>progress(done+read,total),
   options.recover?{recover:value=>reconnect({...value,name,regions:data})}:{});
  done+=size;progress(done,total);
 }
 if(done!==total)fail('flash_read_incomplete');
 return data;
}
export async function sha256(bytes){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
export function crc32(bytes,seed=0xffffffff){let crc=(seed^0xffffffff)>>>0;for(const b of bytes){crc^=b;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
export function validateSecurity(info,flashSize){
 if(!info||info.chipId!==9||!PROFILE.flashSizes.includes(flashSize))fail('wrong_device');
 if(info.flashCryptCnt!==0||!info.parsedFlags||info.parsedFlags.SECURE_BOOT_EN||info.parsedFlags.SECURE_DOWNLOAD_ENABLE)fail('protected_device');
}
export function makeBootRecord(sequence){
 if(!Number.isInteger(sequence)||sequence<1||sequence>=0xffffffff)fail('invalid_ota_sequence');
 const bytes=new Uint8Array(4096).fill(255),view=new DataView(bytes.buffer);
 view.setUint32(0,sequence,true);view.setUint32(24,2,true);view.setUint32(28,crc32(bytes.subarray(0,4)),true);return bytes;
}
export function selectBoot(bytes){
 if(bytes.length!==8192)fail('invalid_ota_data');const records=[];
 for(let i=0;i<2;i++){
  const b=bytes.subarray(i*4096,i*4096+32),v=new DataView(b.buffer,b.byteOffset,b.length);
  const seq=v.getUint32(0,true),state=v.getUint32(24,true),crc=v.getUint32(28,true);
  if(seq!==0xffffffff&&seq>0&&![3,4].includes(state)&&crc===crc32(b.subarray(0,4))){
   if(state===1)fail('pending_ota_validation');records.push({slot:(seq-1)%2,sequence:seq,record:i});
  }
 }
 if(records.length)return records.sort((a,b)=>b.sequence-a.sequence)[0];
 if([0,4096].every(offset=>bytes.subarray(offset,offset+32).every(v=>v===255)))return{slot:0,sequence:0,record:1};
 fail('invalid_ota_data');
}
export async function inspectImage(raw){
 if(!(raw instanceof Uint8Array)||raw.length<288||raw[0]!==0xe9||raw[1]<1||raw[1]>16)fail('invalid_image');
 const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
 if(view.getUint16(12,true)!==9||(raw[3]>>4)!==4||view.getUint32(32,true)!==0xabcd5432)fail('wrong_image');
 let pos=24,checksum=0xef;
 for(let i=0;i<raw[1];i++){
  if(pos+8>raw.length)fail('invalid_image');const size=view.getUint32(pos+4,true);pos+=8;
  if(size>PROFILE.appSize||pos+size>raw.length)fail('invalid_image');
  for(const b of raw.subarray(pos,pos+size))checksum^=b;pos+=size;
 }
 const checksumOffset=Math.ceil((pos+1)/16)*16-1;
 if(checksumOffset>=raw.length||raw[checksumOffset]!==checksum||raw[23]!==1)fail('invalid_image_checksum');
 const end=checksumOffset+33;if(end>raw.length)fail('invalid_image');
 const embedded=hex(raw.subarray(checksumOffset+1,end));
 if(await sha256(raw.subarray(0,checksumOffset+1))!==embedded)fail('invalid_image_hash');
 const text=offset=>new TextDecoder().decode(raw.subarray(offset,offset+32)).split('\0')[0];
 return{data:raw.slice(0,end),sha256:await sha256(raw.subarray(0,end)),version:text(48),project:text(80)};
}
// Header-only identity: enough to name the firmware on screen and to size the
// image, without transferring and hashing the whole application.
export async function inspectImageHeader(loader,address){
 const header=await readFlashBounded(loader,address,288);
 if(header[0]!==0xe9||header[1]<1||header[1]>16||header[23]!==1)fail('invalid_image');
 const view=new DataView(header.buffer,header.byteOffset,header.byteLength);
 if(view.getUint16(12,true)!==9||(header[3]>>4)!==4||view.getUint32(32,true)!==0xabcd5432)fail('wrong_image');
 const text=offset=>new TextDecoder().decode(header.subarray(offset,offset+32)).split('\0')[0];
 return{version:text(48),project:text(80),header};
}
export async function validateLayout(table,install){
 if(!install||install.board!==PROFILE.board||install.partition_bytes!==3072||table.length!==4096||
  await sha256(table.subarray(0,3072))!==install.partition_sha256)fail('unsupported_partition_table');
 const expected=[['nvs',1,2,0x9000,0x4000],['otadata',1,0,0xd000,0x2000],['phy_init',1,1,0xf000,0x1000],
 ['ota_0',0,16,0x20000,0x3f0000],['ota_1',0,17,0x410000,0x3f0000],['assets',1,130,0x800000,0x800000]];
 const view=new DataView(table.buffer,table.byteOffset,table.byteLength);
 for(let i=0;i<expected.length;i++){
  const p=i*32,[name,type,subtype,address,size]=expected[i];
  if(view.getUint16(p,true)!==0x50aa||table[p+2]!==type||table[p+3]!==subtype||
   view.getUint32(p+4,true)!==address||view.getUint32(p+8,true)!==size||view.getUint32(p+28,true)!==0||
   new TextDecoder().decode(table.subarray(p+12,p+28)).split('\0')[0]!==name)fail('unsupported_partition_table');
 }
 return install.partition_sha256;
}
const backupMagic=new TextEncoder().encode('VOICEHUB-BACKUP/1\n');
export async function encodeBackup(identity,regions){
 const metadata={...identity,regions:[]};
 for(const r of regions)metadata.regions.push({name:r.name,address:r.address,size:r.data.length,sha256:await sha256(r.data)});
 const json=new TextEncoder().encode(JSON.stringify(metadata));
 const bytes=new Uint8Array(backupMagic.length+4+json.length+regions.reduce((n,r)=>n+r.data.length,0));
 bytes.set(backupMagic);new DataView(bytes.buffer).setUint32(backupMagic.length,json.length,true);bytes.set(json,backupMagic.length+4);
 let offset=backupMagic.length+4+json.length;for(const r of regions){bytes.set(r.data,offset);offset+=r.data.length;}return bytes;
}
export async function decodeBackup(bytes){
 if(bytes.length<backupMagic.length+4||bytes.length>16*1024*1024||!backupMagic.every((v,i)=>bytes[i]===v))fail('invalid_backup');
 const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(backupMagic.length,true);
 if(size>8192||size+backupMagic.length+4>bytes.length)fail('invalid_backup');
 const identity=JSON.parse(new TextDecoder().decode(bytes.subarray(backupMagic.length+4,backupMagic.length+4+size)));
 if(!Array.isArray(identity.regions)||identity.regions.length!==3)fail('invalid_backup');
 let pos=backupMagic.length+4+size;
 for(const r of identity.regions){
  if(!Number.isInteger(r.size)||r.size<1||r.size>PROFILE.appSize||pos+r.size>bytes.length)fail('invalid_backup');
  r.data=bytes.slice(pos,pos+r.size);pos+=r.size;if(await sha256(r.data)!==r.sha256)fail('backup_checksum_failed');
 }
 if(pos!==bytes.length)fail('invalid_backup');return identity;
}
export function validateBackup(backup,device){
 if(backup.mac!==device.mac||backup.layout!==device.layout||![0,1].includes(backup.targetSlot))fail('backup_wrong_device');
 const allowed={nvs:[PROFILE.nvs,PROFILE.nvsSize],otadata:[PROFILE.ota,PROFILE.otaSize],target:[PROFILE.apps[backup.targetSlot],PROFILE.appSize]};
 if(backup.regions.length!==3||new Set(backup.regions.map(r=>r.name)).size!==3)fail('invalid_backup');
 for(const r of backup.regions){const a=allowed[r.name];if(!a||r.address!==a[0]||r.data.length!==a[1])fail('invalid_backup_range');}
}
// Identity of a device, without its application bytes: chip, Flash, MAC,
// partition table and boot record. A broken OTA record is reported but does not
// block Wi-Fi setup, which only ever writes NVS.
export async function inspectDeviceIdentity(loader,manifest,progress=()=>{}){
 progress('正在读取芯片安全状态和 Flash 容量…',0);
 const security=await loader.getSecurityInfo(),flashSize=await loader.detectFlashSize();
 progress('检测到芯片 ID '+security.chipId+'，实际 Flash '+(flashSize||'未知')+'，正在核对分区。',0);
 validateSecurity(security,flashSize);
 const mac=await loader.chip.readMac(loader);
 const table=await readFlashBounded(loader,PROFILE.table,4096);const layout=await validateLayout(table,manifest.install);
 const ota=await loader.readFlash(PROFILE.ota,PROFILE.otaSize);let boot=null,bootError=null;
 try{boot=selectBoot(ota);}catch(error){bootError=error.message;}
 // A damaged application must not block Wi-Fi setup: only NVS is written.
 let image=null,imageError=null;
 try{image=await inspectImageHeader(loader,PROFILE.apps[boot?.slot??0]);}catch(error){imageError=error.message;}
 return{mac,layout,flashSize,table,ota,boot,bootError,image,imageError};
}
// Full check used only when an application is about to be installed: it hashes
// the running firmware so an unknown build cannot be overwritten by accident.
export async function inspectDevice(loader,manifest,progress=()=>{},identity=null){
 const base=identity||await inspectDeviceIdentity(loader,manifest,progress);
 if(!base.boot)fail(base.bootError||'invalid_ota_data');
 const bytes=await readApplication(loader,PROFILE.apps[base.boot.slot],(p,w,t)=>progress('正在读取现有应用以核对固件（'+Math.round(w/1024)+' KB / '+Math.round(t/1024)+' KB），此时不写入设备。',w/t));
 progress('应用读取完成，正在校验固件指纹…',1);
 const image=await inspectImage(bytes);
 if(!(manifest.install.upgrade_from_sha256||[]).includes(image.sha256)&&image.sha256!==manifest.sha256)fail('unrecognized_existing_firmware');
 if(base.boot.sequence>=0xfffffffd)fail('invalid_ota_sequence');
 return{...base,current:image,targetSlot:1-base.boot.slot};
}
export async function readApplication(loader,address,progress=()=>{}){
 const header=await readFlashBounded(loader,address,24);
 if(header[0]!==0xe9||header[1]<1||header[1]>16||header[23]!==1)fail('invalid_image');
 let pos=24;
 for(let i=0;i<header[1];i++){
  if(pos+8>PROFILE.appSize)fail('invalid_image');
  const segment=await readFlashBounded(loader,address+pos,8);
  const size=new DataView(segment.buffer,segment.byteOffset,segment.byteLength).getUint32(4,true);
  pos+=8;if(size>PROFILE.appSize-pos)fail('invalid_image');pos+=size;
 }
 const length=Math.ceil((pos+1)/16)*16+32;
 if(length>PROFILE.appSize||length<288)fail('invalid_image');
 return readFlashBounded(loader,address,length,progress);
}
// A device-computed MD5 of the written region is as strong as a full read-back
// for detecting a failed write, and costs one command instead of megabytes.
export async function writeAndVerify(loader,address,data,progress){
 await loader.writeFlash({fileArray:[{address,data}],flashSize:'keep',flashMode:'keep',flashFreq:'keep',eraseAll:false,compress:true,
  reportProgress:(_i,w,t)=>progress?.(w/t)});
 if(typeof loader.flashMd5sum==='function'){
  const digest=String(await loader.flashMd5sum(address,data.length)).toLowerCase();
  if(digest!==hex(md5(data)))fail('flash_verification_failed');
  return;
 }
 const actual=await readFlashBounded(loader,address,data.length);
 if(await sha256(actual)!==await sha256(data))fail('flash_verification_failed');
}
export async function upgrade(loader,device,manifest,image,backup,progress=()=>{}){
 validateBackup(backup,device);
 if(backup.targetSlot!==device.targetSlot||await sha256(backup.regions.find(r=>r.name==='otadata').data)!==await sha256(device.ota))fail('backup_wrong_device');
 if(await loader.chip.readMac(loader)!==device.mac)fail('backup_wrong_device');
 if(manifest.install?.validated!==true)fail('release_not_hardware_validated');
 const parsed=await inspectImage(image);
 if(parsed.sha256!==manifest.sha256||parsed.data.length>PROFILE.appSize)fail('wrong_image');
 // Re-read critical state immediately before writing; reconnect/reboot invalidates the plan.
 if(await sha256(await loader.readFlash(PROFILE.table,4096))!==await sha256(device.table)||
  await sha256(await loader.readFlash(PROFILE.ota,8192))!==await sha256(device.ota))fail('device_state_changed');
 await writeAndVerify(loader,PROFILE.apps[device.targetSlot],parsed.data,p=>progress('正在安装应用',p));
 let sequence=device.boot.sequence+1;while((sequence-1)%2!==device.targetSlot)sequence++;
 const address=PROFILE.ota+(1-device.boot.record)*4096;
 await writeAndVerify(loader,address,makeBootRecord(sequence),p=>progress('正在设置启动应用',p));
 return{slot:device.targetSlot,sha256:parsed.sha256};
}
export async function restore(loader,device,backup,progress=()=>{}){
 validateBackup(backup,device);
 if(await loader.chip.readMac(loader)!==device.mac||await sha256(await loader.readFlash(PROFILE.table,4096))!==await sha256(device.table))fail('backup_wrong_device');
 // Restore only the previously overwritten inactive application and settings; boot selection last.
 for(const name of ['target','nvs','otadata']){
  const r=backup.regions.find(x=>x.name===name);await writeAndVerify(loader,r.address,r.data,p=>progress('正在恢复升级前备份',p));
 }
}
