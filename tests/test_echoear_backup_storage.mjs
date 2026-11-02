import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,capture} from './fixtures/echoear-loader.mjs';
import {saveAutomaticBackup,latestAutomaticBackup} from '../flash/echoear-backup-storage.mjs';
const id=n=>String(n).padStart(20,'0')+'-'+'a'.repeat(32);
const same=(a,b)=>assert.equal(Buffer.compare(Buffer.from(a),Buffer.from(b)),0);
test('automatic save verifies the exact persisted copy without a file picker',async t=>{
 const f=await fixture(),{bytes}=await capture(f,'full');let saved=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(options?.method==='POST'){same(options.body,bytes);saved=true;return Response.json({id:id(1)},{status:201});}
  assert.ok(saved);assert.match(url,new RegExp('/'+id(1)+'\\?'));return new Response(bytes);
 });
 const result=await saveAutomaticBackup(bytes,f.device);
 assert.equal(result.kind,'full');
 same(result.regions.app0,f.flash.slice(0x20000,0x410000));
 same(result.regions.nvs,f.flash.slice(0x9000,0xd000));
});
test('automatic recovery skips a newer checksum-valid backup with invalid firmware',async t=>{
 const f=await fixture(),good=(await capture(f,'full')).bytes;
 f.flash[0x20000]=0;const bad=(await capture(f,'full')).bytes;let calls=0;
 t.mock.method(globalThis,'fetch',async url=>{
  calls++;const params=new URL(url,'http://localhost').searchParams;assert.equal(params.get('mac'),f.device.mac);assert.equal(params.get('layout'),f.device.layout);
  if(calls===1){assert.equal(params.has('before'),false);return new Response(bad,{headers:{'X-Backup-Id':id(2)}});}
  assert.equal(params.get('before'),id(2));return new Response(good,{headers:{'X-Backup-Id':id(1)}});
 });
 const restored=await latestAutomaticBackup(f.device);assert.equal(restored.regions.app0[0],0xe9);assert.equal(calls,2);
});
test('a settings-only backup never satisfies a restore that needs the firmware back',async t=>{
 const f=await fixture(),settings=(await capture(f,'settings')).bytes;
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  if(options?.method==='POST')return Response.json({id:id(1)},{status:201});
  calls++;return calls===1?new Response(settings,{headers:{'X-Backup-Id':id(2)}}):Response.json({error:{code:'backup_not_found'}},{status:404});
 });
 assert.equal((await latestAutomaticBackup(f.device)).kind,'settings');
 await assert.rejects(()=>latestAutomaticBackup(f.device,{kind:'full'}),/backup_not_found/);
});
test('storage failures, missing copies, or failed readback cannot produce a usable backup',async t=>{
 const f=await fixture(),{bytes}=await capture(f,'full');
 const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'backup_storage_failed'}},{status:507}));
 await assert.rejects(()=>saveAutomaticBackup(bytes,f.device),/backup_storage_failed/);
 fetch.mock.mockImplementation(async()=>Response.json({error:{code:'backup_not_found'}},{status:404}));
 await assert.rejects(()=>latestAutomaticBackup(f.device),/backup_not_found/);
 fetch.mock.mockImplementation(async(_url,options)=>options?.method==='POST'?Response.json({id:id(1)}):new Response(bytes.subarray(0,bytes.length-1)));
 await assert.rejects(()=>saveAutomaticBackup(bytes,f.device),/backup_checksum_failed|invalid_device_backup/);
});
test('a server that only knows the old container is reported as outdated',async t=>{
 const f=await fixture(),{bytes}=await capture(f,'settings');
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'invalid_device_backup'}},{status:400}));
 await assert.rejects(()=>saveAutomaticBackup(bytes,f.device),/server_outdated/);
});
