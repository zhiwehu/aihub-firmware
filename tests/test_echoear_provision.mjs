import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,capture} from './fixtures/echoear-loader.mjs';
import {PROFILE,sha256,upgrade,inspectDeviceIdentity,inspectDevice} from '../flash/echoear-upgrade-core.mjs';
import {captureDeviceBackup,applyNetwork,restoreDeviceBackup} from '../flash/echoear-device-backup.mjs';
const same=(a,b)=>assert.equal(Buffer.compare(Buffer.from(a),Buffer.from(b)),0);
async function prepared(kind='full'){const f=await fixture();const {bytes,backup}=await capture(f,kind);return{...f,bytes,full:backup,kind};}
test('provisioning backs up only settings and writes only NVS',async()=>{
 const f=await prepared('settings'),nvs=new Uint8Array(PROFILE.nvsSize).fill(3);
 assert.equal(f.full.kind,'settings');
 assert.equal(f.bytes.length<64*1024,true,'a settings backup must not carry application slots');
 assert.deepEqual(Object.keys(f.full.regions).sort(),['nvs','otadata','table']);
 await applyNetwork(f.loader,f.device,f.full,nvs);
 assert.deepEqual(f.writes,[PROFILE.nvs]);
 same(f.flash.slice(PROFILE.nvs,PROFILE.nvs+PROFILE.nvsSize),nvs);
 same(f.flash.slice(PROFILE.apps[0],PROFILE.apps[0]+f.old.length),f.old);
 await restoreDeviceBackup(f.loader,f.device,f.full);
 assert.deepEqual(f.writes,[PROFILE.nvs,PROFILE.nvs]);
 same(f.flash.slice(PROFILE.nvs,PROFILE.nvs+PROFILE.nvsSize),f.full.regions.nvs);
});
test('wrong device, changed NVS, or altered backup cannot start a write',async()=>{
 const f=await prepared('settings'),nvs=new Uint8Array(PROFILE.nvsSize);
 await assert.rejects(()=>applyNetwork(f.loader,{...f.device,mac:'other'},f.full,nvs),/backup_wrong_device/);
 f.flash[PROFILE.nvs]^=1;await assert.rejects(()=>applyNetwork(f.loader,f.device,f.full,nvs),/device_state_changed/);f.flash[PROFILE.nvs]^=1;
 f.full.regions.nvs[0]^=1;await assert.rejects(()=>applyNetwork(f.loader,f.device,f.full,nvs),/backup_checksum_failed/);
 assert.deepEqual(f.writes,[]);
});
test('write readback failure is reported and a full backup restores original apps and settings',async()=>{
 const f=await prepared('full'),original=f.loader.writeFlash;
 f.loader.writeFlash=async()=>{};
 await assert.rejects(()=>applyNetwork(f.loader,f.device,f.full,new Uint8Array(PROFILE.nvsSize)),/flash_verification_failed/);
 f.loader.writeFlash=original;
 await applyNetwork(f.loader,f.device,f.full,new Uint8Array(PROFILE.nvsSize));
 await restoreDeviceBackup(f.loader,f.device,f.full);
 assert.deepEqual(f.writes,[PROFILE.nvs,PROFILE.apps[1],PROFILE.apps[0],PROFILE.nvs,PROFILE.ota]);
 for(const name of ['app0','app1','nvs','otadata']){
  const address={app0:PROFILE.apps[0],app1:PROFILE.apps[1],nvs:PROFILE.nvs,otadata:PROFILE.ota}[name];
  const size={app0:PROFILE.appSize,app1:PROFILE.appSize,nvs:PROFILE.nvsSize,otadata:PROFILE.otaSize}[name];
  same(f.flash.slice(address,address+size),f.full.regions[name]);
 }
});
test('optional validated update can be followed by connection setup without touching assets',async()=>{
 const f=await prepared('full');await upgrade(f.loader,f.device,f.manifest,f.next,f.backup);
 f.device.ota=(await f.loader.readFlash(PROFILE.ota,PROFILE.otaSize));
 await applyNetwork(f.loader,f.device,f.full,new Uint8Array(PROFILE.nvsSize));
 assert.deepEqual(f.writes,[PROFILE.apps[1],PROFILE.ota+4096,PROFILE.nvs]);
 assert.deepEqual([...f.flash.slice(0x800000,0x800003)],[7,8,9]);
});
test('a damaged application or OTA record still allows Wi-Fi provisioning',async()=>{
 const f=await fixture();
 f.flash[PROFILE.apps[0]]=0;f.flash.fill(0,PROFILE.ota,PROFILE.ota+PROFILE.otaSize);
 await assert.rejects(()=>inspectDevice(f.loader,f.manifest));
 const identity=await inspectDeviceIdentity(f.loader,f.manifest);
 assert.equal(identity.mac,f.device.mac);assert.equal(identity.boot,null);assert.equal(identity.image,null);
 const {backup}=await captureDeviceBackup(identity,f.loader,{kind:'settings'});
 assert.equal(backup.kind,'settings');
 const nvs=new Uint8Array(PROFILE.nvsSize).fill(9);
 await applyNetwork(f.loader,identity,backup,nvs);
 same(f.flash.slice(PROFILE.nvs,PROFILE.nvs+PROFILE.nvsSize),nvs);
});
test('an unchanged application slot is not re-read on the next backup',async()=>{
 const f=await fixture(),first=await capture(f,'full');
 let bytes=0;const read=f.loader.readFlash.bind(f.loader);
 f.loader.readFlash=async(a,n)=>{bytes+=n;return read(a,n)};
 const second=await capture(f,'full',{previous:first.backup});
 assert.equal(bytes,4096+PROFILE.otaSize+PROFILE.nvsSize,'only the settings regions are re-read');
 same(second.backup.regions.app0,first.backup.regions.app0);
 same(second.backup.regions.app1,first.backup.regions.app1);
});
test('a slot that changed on the device is read again instead of reused',async()=>{
 const f=await fixture(),first=await capture(f,'full');
 f.flash[PROFILE.apps[1]+16]^=1;
 const second=await capture(f,'full',{previous:first.backup});
 assert.notEqual(Buffer.compare(Buffer.from(second.backup.regions.app1),Buffer.from(first.backup.regions.app1)),0);
 same(second.backup.regions.app0,first.backup.regions.app0);
 assert.equal(await sha256(second.backup.regions.app1),second.backup.hashes.app1);
});
