import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {READ_FLASH_BLOCK,FALLBACK_FLASH_BLOCK} from '../flash/echoear-flash-reader.mjs';

// Exercise the actual browser connection helper with serial hardware replaced.
const source=await readFile(new URL('../flash/echoear-installer.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function connectUsbLoader('),source.indexOf("$('echoear-connect').onclick"));
function fixture(fail){
 const attempts=[],closed=[],reset=[],probes=[];
 const context={READ_FLASH_BLOCK,FALLBACK_FLASH_BLOCK,loader:null,transport:null,status(){},
  async openUsbLoader(port,rate,block){
   assert.equal(port,'usb');attempts.push([rate,block]);
   context.loader={async main(){if(fail?.(attempts.length,'connect'))throw new Error('connect failed')},async after(){reset.push(attempts.length)}};
   context.transport={async disconnect(){closed.push(attempts.length)}};
  },
  async readDeviceRegions(loader,names){
   assert.equal(names.length,1);assert.equal(names[0],'table');probes.push(attempts.length);
   if(fail?.(attempts.length,'read'))throw new Error('read failed');
   return{table:new Uint8Array(4096)};
  }};
 vm.createContext(context);vm.runInContext(helper,context);
 return {context,attempts,closed,reset,probes};
}
test('connection asks for 4KB frames and verifies a flash reply',async()=>{
 const f=fixture();await f.context.connectUsbLoader('usb');
 assert.deepEqual(f.attempts,[[460800,READ_FLASH_BLOCK]]);assert.deepEqual(f.probes,[1]);assert.deepEqual(f.closed,[]);
});
for(const phase of ['connect','read'])test(`a ${phase} failure falls back to the proven 1KB frame size`,async()=>{
 const f=fixture(attempt=>attempt===1&&phase);await f.context.connectUsbLoader('usb');
 assert.deepEqual(f.attempts,[[460800,READ_FLASH_BLOCK],[460800,FALLBACK_FLASH_BLOCK]]);
 assert.deepEqual(f.closed,[1]);assert.deepEqual(f.reset,[1]);assert.deepEqual(f.probes,[2]);
});
test('a link that rejects both frame sizes still retries at the compatible rate',async()=>{
 const f=fixture(attempt=>attempt<=2);await f.context.connectUsbLoader('usb');
 assert.deepEqual(f.attempts,[[460800,READ_FLASH_BLOCK],[460800,FALLBACK_FLASH_BLOCK],[115200,FALLBACK_FLASH_BLOCK]]);
 assert.deepEqual(f.probes,[3]);
});
test('failure on every attempt is bounded and closes the failed connection',async()=>{
 const f=fixture(()=>true);await assert.rejects(()=>f.context.connectUsbLoader('usb'),/connect failed/);
 assert.equal(f.attempts.length,3);assert.deepEqual(f.closed,[1,2,3]);assert.equal(f.context.loader,null);
});
