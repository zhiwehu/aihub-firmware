import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PROFILE} from '../flash/echoear-upgrade-core.mjs';
import {setupResponse} from '../flash/echoear-response.mjs';

// The browser module is loaded with its imports replaced by stubs, so the
// decision "one click when Wi-Fi is already stored" and "only the settings need
// a backup when no application is installed" stay under test.
function installer(){
 const nodes=new Map();
 const node=()=>({value:'',checked:false,dataset:{},children:[],disabled:false,hidden:false,required:false,textContent:'',
  append(child){this.children.push(child)},replaceChildren(){this.children=[]},setAttribute(k,v){this[k]=v},removeAttribute(k){delete this[k]},
  classList:{toggle(){}},focus(){}});
 const steps=[1,2,3].map(n=>({...node(),dataset:{usbStep:String(n)}})),panels=[1,2,3].map(n=>({...node(),dataset:{usbPanel:String(n)}}));
 const document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)},createElement:node,
  querySelectorAll(selector){return selector==='[data-usb-step]'?steps:panels}};
 const calls={captures:[],saved:[],applied:[],upgraded:[],downloads:0,prepare:[]};
 const context={PROFILE,REGIONS:{nvs:{address:PROFILE.nvs,size:PROFILE.nvsSize}},READ_FLASH_BLOCK:4096,FALLBACK_FLASH_BLOCK:1024,hex:()=>'',
  md5:()=>new Uint8Array(16),installFlashReader:x=>x,installSlipReader:x=>x,setupResponse,
  hasSavedWifi:()=>state.savedWifi,savedWifiSsid:()=>'home-wifi',
  connectionNvs:raw=>raw,readDeviceRegions:async()=>({nvs:new Uint8Array(PROFILE.nvsSize),otadata:new Uint8Array(PROFILE.otaSize)}),
  captureDeviceBackup:async(_device,_loader,{kind})=>{calls.captures.push(kind);return{bytes:new Uint8Array(8),backup:{kind}}},
  saveAutomaticBackup:async bytes=>{calls.saved.push(bytes.length);return{kind:calls.captures.at(-1),regions:{nvs:new Uint8Array(PROFILE.nvsSize)}}},
  applyNetwork:async(_loader,_device,backup)=>calls.applied.push(backup.kind),
  restoreDeviceBackup:async()=>({scope:'settings'}),encodeBackup:async()=>new Uint8Array(),decodeBackup:async()=>({}),
  inspectDevice:async(_l,_m,_p,identity)=>({...identity,targetSlot:1}),
  inspectDeviceIdentity:async()=>({mac:'90:e5:b1:ae:80:a0',layout:'a'.repeat(64),flashSize:'16MB',image:{version:'2.0.5'}}),
  upgrade:async()=>{calls.upgraded.push(1);return{slot:1}},
  latestAutomaticBackup:async()=>{throw new Error('backup_not_found')},
  document,nodes,steps,panels,location:{hostname:'127.0.0.1'},navigator:{serial:{},locks:null},
  window:{isSecureContext:true,addEventListener(){},dispatchEvent(){}},
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}},
  TextEncoder,TextDecoder,console:{warn(){}},setInterval(){},setTimeout(){},
  fetch:async (url,options)=>{
   if(String(url).includes('/prepare')){calls.prepare.push(JSON.parse(options.body));return Response.json({ota_url:'http://10.0.0.2:8766/xiaozhi/ota/token/',websocket:{url:'ws://10.0.0.2:8766/xiaozhi/v1/',token:'t'.repeat(20),version:1}});}
   calls.downloads++;return new Response(new Uint8Array(64));
  }};
 const state={savedWifi:false};
 const source=fs.readFileSync(new URL('../flash/echoear-installer.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 context.__api=vm.runInNewContext(source+`
  ;({provision,controls,
    setDevice(value){device=value},
    setRelease(value){release=value},
    setSaved(value){savedWifi=value;savedSsid=value?'home-wifi':'';controls()},

    node(id){return document.getElementById(id)}})`,context);
 return{context,calls,nodes,steps,panels,api:context.__api};
}
const device=()=>({mac:'90:e5:b1:ae:80:a0',layout:'a'.repeat(64),flashSize:'16MB',ota:new Uint8Array(8192),
 boot:{slot:0,sequence:1,record:1},image:{version:'2.0.5'}});
test('a device that already stores Wi-Fi is provisioned from a single click',async()=>{
 const app=installer();
 app.api.setDevice(device());app.api.setSaved(true);
 assert.equal(app.nodes.get('echoear-network-form').hidden,true);
 assert.equal(app.nodes.get('echoear-other-wifi').hidden,false);
 assert.match(app.nodes.get('echoear-open-network').textContent,/一键配网/);
 await app.nodes.get('echoear-open-network').onclick();
 assert.deepEqual(app.calls.captures,['settings'],'without a firmware update only the settings are backed up');
 assert.deepEqual(app.calls.applied,['settings']);
 assert.equal(app.calls.downloads,0);
 assert.equal(app.calls.prepare[0].device_id,device().mac);
});
test('a device with no stored Wi-Fi asks for the credentials instead of failing late',()=>{
 const app=installer();
 app.api.setDevice(device());app.api.setSaved(false);
 assert.equal(app.nodes.get('echoear-network-form').hidden,false);
 assert.equal(app.nodes.get('echoear-network-intro').hidden,true);
 assert.equal(app.nodes.get('echoear-other-wifi').hidden,true);
});
test('opting into a firmware update backs up both application slots first',async()=>{
 const app=installer();
 app.api.setDevice(device());app.api.setSaved(true);
 app.api.setRelease({install:{validated:true},version:'2.0.5',download:'/firmware/application.bin',sha256:'a'.repeat(64)});
 app.nodes.get('echoear-update-with-setup').checked=true;
 await app.nodes.get('echoear-open-network').onclick();
 assert.deepEqual(app.calls.captures,['full']);
 assert.deepEqual(app.calls.upgraded,[1]);
 assert.deepEqual(app.calls.applied,['full']);
 assert.equal(app.calls.downloads,1);
});
