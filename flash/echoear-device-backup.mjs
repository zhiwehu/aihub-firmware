// VoiceHub device backups. Version 2 stores only the regions this project can
// change (settings, or settings plus both application slots); version 1 files
// that still hold a complete 16/32MB image remain readable and restorable.
import {PROFILE,REGIONS,SETTINGS_REGIONS,FULL_REGIONS,sha256,readDeviceRegions,writeAndVerify,inspectImage,selectBoot} from './echoear-upgrade-core.mjs';
const magic1=new TextEncoder().encode('VOICEHUB-DEVICE/1\n'),magic2=new TextEncoder().encode('VOICEHUB-DEVICE/2\n');
const fail=code=>{throw new Error(code);};
const CANONICAL={table:[PROFILE.table,4096],otadata:[PROFILE.ota,PROFILE.otaSize],
 nvs:[PROFILE.nvs,PROFILE.nvsSize],app0:[PROFILE.apps[0],PROFILE.appSize],app1:[PROFILE.apps[1],PROFILE.appSize]};
const startsWith=(bytes,magic)=>bytes.length>=magic.length&&magic.every((v,i)=>bytes[i]===v);
const SIZE={'16MB':16*1024*1024,'32MB':32*1024*1024};
export const BACKUP_KINDS=['settings','full'];
// A settings backup is only ever written back over NVS. A full backup covers
// every partition this project can overwrite, so it can undo an upgrade.
export function regionsFor(kind){return kind==='full'?FULL_REGIONS:kind==='settings'?SETTINGS_REGIONS:fail('invalid_device_backup');}
export async function encodeDeviceBackup({kind,device,regions,firmware}){
 const names=regionsFor(kind);
 const metadata={version:2,kind,mac:device.mac,layout:device.layout,flashSize:device.flashSize,regions:[]};
 if(firmware)metadata.firmware=firmware;
 for(const name of names){
  const [address,size]=CANONICAL[name];
  if(!(regions[name] instanceof Uint8Array)||regions[name].length!==size)fail('invalid_device_backup');
  metadata.regions.push({name,address,size,sha256:await sha256(regions[name])});
 }
 const json=new TextEncoder().encode(JSON.stringify(metadata));
 const total=names.reduce((n,name)=>n+CANONICAL[name][1],0);
 const bytes=new Uint8Array(magic2.length+4+json.length+total);
 bytes.set(magic2);new DataView(bytes.buffer).setUint32(magic2.length,json.length,true);bytes.set(json,magic2.length+4);
 let offset=magic2.length+4+json.length;
 for(const name of names){bytes.set(regions[name],offset);offset+=CANONICAL[name][1];}
 return bytes;
}
async function decodeV2(bytes){
 const start=magic2.length+4;
 if(bytes.length<start)fail('invalid_device_backup');
 const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(magic2.length,true);
 if(length<1||length>4096||start+length>=bytes.length)fail('invalid_device_backup');
 const metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(start,start+length)));
 if(metadata?.version!==2||!BACKUP_KINDS.includes(metadata.kind)||!SIZE[metadata.flashSize])fail('invalid_device_backup');
 if(!Array.isArray(metadata.regions)||!metadata.regions.length||metadata.regions.length>8)fail('invalid_device_backup');
 let offset=start+length;const regions={};
 for(const item of metadata.regions){
  const canonical=CANONICAL[item?.name];
  if(!canonical||item.address!==canonical[0]||item.size!==canonical[1]||item.name in regions)fail('invalid_device_backup');
  if(offset+item.size>bytes.length)fail('invalid_device_backup');
  const data=bytes.slice(offset,offset+item.size);offset+=item.size;
  if(await sha256(data)!==item.sha256)fail('backup_checksum_failed');
  regions[item.name]=data;
 }
 if(offset!==bytes.length)fail('invalid_device_backup');
 for(const name of regionsFor(metadata.kind))if(!regions[name])fail('invalid_device_backup');
 const hashes={};for(const item of metadata.regions)hashes[item.name]=item.sha256;
 return{...metadata,regions,hashes};
}
function decodeV1(bytes){
 if(bytes.length>33*1024*1024)fail('invalid_device_backup');
 const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(magic1.length,true);
 if(length<1||length>4096||magic1.length+4+length>=bytes.length)fail('invalid_device_backup');
 const metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(magic1.length+4,magic1.length+4+length)));
 const data=bytes.slice(magic1.length+4+length);
 if(data.length!==(SIZE[metadata.flashSize]||0))fail('invalid_device_backup');
 const regions={};
 for(const [name,[address,size]] of Object.entries(CANONICAL))regions[name]=data.subarray(address,address+size);
 return{version:1,kind:'full',mac:metadata.mac,layout:metadata.layout,flashSize:metadata.flashSize,data,regions,
  digest:metadata.sha256,firmware:metadata.current_sha256};
}
export async function decodeDeviceBackup(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<magic2.length+4)fail('invalid_device_backup');
 const backup=startsWith(bytes,magic2)?await decodeV2(bytes):startsWith(bytes,magic1)?decodeV1(bytes):fail('invalid_device_backup');
 if(await sha256(backup.regions.table.subarray(0,3072))!==backup.layout)fail('backup_checksum_failed');
 return backup;
}
// Self-consistency only: this proves the file describes one coherent device
// snapshot. Whether it belongs to the connected robot is checked per operation.
export async function validateDeviceBackup(backup,device){
 if(!backup.regions?.table||!backup.regions?.nvs||!backup.regions?.otadata)fail('invalid_device_backup');
 if(backup.mac!==device.mac||backup.layout!==device.layout||backup.flashSize!==device.flashSize)fail('backup_wrong_device');
 if(backup.digest&&await sha256(backup.data)!==backup.digest)fail('backup_checksum_failed');
 for(const [name,digest] of Object.entries(backup.hashes||{}))if(await sha256(backup.regions[name])!==digest)fail('backup_checksum_failed');
 if(await sha256(backup.regions.table.subarray(0,3072))!==device.layout)fail('backup_wrong_device');
 if(backup.kind!=='full')return backup;
 const boot=selectBoot(backup.regions.otadata);
 const image=await inspectImage(backup.regions[boot.slot?'app1':'app0']);
 if(backup.firmware&&image.sha256!==backup.firmware)fail('backup_checksum_failed');
 return backup;
}
// Read what has to be preserved before the first device write. Reusing an
// unchanged application slot keeps a repeat backup to a few seconds.
export async function captureDeviceBackup(device,loader,{kind='settings',previous=null,progress=()=>{},recover}={}){
 const regions=await readDeviceRegions(loader,regionsFor(kind),previous?.regions||null,progress,recover?{recover}:{});
 const firmware=device.current?.sha256||previous?.firmware;
 const bytes=await encodeDeviceBackup({kind,device,regions,firmware});
 return{bytes,backup:await decodeDeviceBackup(bytes)};
}
export async function applyNetwork(loader,device,backup,nvs,progress=()=>{}){
 await validateDeviceBackup(backup,device);
 if(!(nvs instanceof Uint8Array)||nvs.length!==PROFILE.nvsSize)fail('invalid_nvs');
 if(await loader.chip.readMac(loader)!==device.mac)fail('backup_wrong_device');
 // Re-read the settings the write lands on; reconnect, reboot or a second
 // writer invalidates the plan.
 for(const name of ['table','otadata','nvs']){
  const current=(await readDeviceRegions(loader,[name]))[name];
  const expected=name==='otadata'&&device.ota?device.ota:backup.regions[name];
  if(await sha256(current)!==await sha256(expected))fail('device_state_changed');
 }
 await writeAndVerify(loader,PROFILE.nvs,nvs,p=>progress('正在写入连接设置，请保持 USB 连接…',p));
}
export async function restoreDeviceBackup(loader,device,backup,progress=()=>{}){
 await validateDeviceBackup(backup,device);
 if(await loader.chip.readMac(loader)!==device.mac||await sha256((await readDeviceRegions(loader,['table'])).table)!==await sha256(backup.regions.table))fail('backup_wrong_device');
 if(backup.kind!=='full'){
  // Nothing but settings was ever written to this device by the wizard.
  await writeAndVerify(loader,PROFILE.nvs,backup.regions.nvs,p=>progress('正在恢复连接设置…',p));
  return{scope:'settings'};
 }
 // Only application slots and settings; never rewrite bootloader/table/assets.
 let active;try{active=selectBoot((await readDeviceRegions(loader,['otadata'])).otadata).slot;}catch{active=undefined;}
 const names=active===0?['app1','app0']:['app0','app1'];
 for(const name of [...names,'nvs','otadata'])
  await writeAndVerify(loader,REGIONS[name].address,backup.regions[name],p=>progress('正在恢复原固件与连接设置…',p));
 return{scope:'full'};
}
