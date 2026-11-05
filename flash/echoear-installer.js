import {saveAutomaticBackup,latestAutomaticBackup} from './echoear-backup-storage.mjs';
import {installFlashReader,installSlipReader,md5,READ_FLASH_BLOCK,FALLBACK_FLASH_BLOCK} from './echoear-flash-reader.mjs';
import {setupResponse} from './echoear-response.mjs';
import {connectionNvs,hasSavedWifi,savedWifiSsid} from './echoear-nvs.mjs';
import {captureDeviceBackup,applyNetwork,restoreDeviceBackup} from './echoear-device-backup.mjs';
import {PROFILE,REGIONS,hex,inspectDevice,inspectDeviceIdentity,readDeviceRegions,encodeBackup,decodeBackup,upgrade} from './echoear-upgrade-core.mjs';
const $=id=>document.getElementById(id);
const messages={usb_in_use:'USB 正由另一个页面操作。请等该页面完成或断开后再连接。',wifi_credentials_required:'喵伴没有可沿用的 Wi-Fi，请填写 Wi-Fi 名称和密码。',flash_read_checksum_failed:'USB 读取的数据校验未通过，备份已停止，没有开始写入。',flash_recovery_failed:'USB 读取恢复失败，没有开始写入。',invalid_wifi:'请填写 1–32 字节的 Wi-Fi 名称；密码为 8–64 字节，开放网络可留空。',invalid_connection:'设备连接信息不完整，请重新准备连接。',invalid_nvs:'现有设备设置的格式或校验不受支持，已停止，未清空设置。',nvs_space_required:'设备有效设置已占满，整理后仍无足够空间，未修改设备。请先在高级选项保存备份，再处理。',invalid_device_backup:'备份格式无效，设备未开始写入。',backup_not_found:'这台喵伴还没有可用的备份。',backup_storage_failed:'本机备份保存或读取失败，请检查磁盘空间和权限。',invalid_image:'读取的应用镜像格式不完整，请重新检查设备。',wrong_image:'当前应用镜像的芯片或配置不符合这个升级包。',invalid_image_checksum:'读取的应用校验和未通过，请重新检查设备。',invalid_image_hash:'读取的应用指纹校验未通过，请重新检查设备。',wrong_device:'芯片型号或实际 Flash 容量不在支持范围内，已停止检查。',protected_device:'设备启用了安全保护，本向导不支持升级，请联系管理员。',serial_unsupported:'请用电脑上的 Chrome 或 Edge，通过 https 或本机 localhost 打开本页面。',
 unsupported_partition_table:'设备分区与当前升级包不匹配。本向导不能直接安装到这台新设备，需要先确认对应固件方案。',unrecognized_existing_firmware:'已读到设备，但当前固件不在已验证的升级来源中。请记录设备型号和固件版本，不能直接安装此升级包。',
 flash_read_incomplete:'设备返回的数据不完整，检查已停止，没有开始安装。请重新连接后重试。',
 invalid_ota_data:'无法确认设备的启动分区，已停止操作。',pending_ota_validation:'设备上次升级尚未确认，请先让设备正常启动。',
 backup_wrong_device:'备份与当前设备不匹配，已停止恢复。',backup_checksum_failed:'备份校验未通过，请勿用它恢复。',
 invalid_backup_range:'备份的写入范围不受支持，已停止操作。',flash_verification_failed:'写入后的检查未通过。请保持 USB 连接，使用已保存的备份恢复。',
 device_state_changed:'设备状态已改变，请重新连接检查，再保存一份新的备份。',release_not_hardware_validated:'这一版本还在等待实机验收，暂不能安装。',
 firmware_download_failed:'升级包下载失败，已停止，设备没有开始安装。',server_outdated:'VoiceHub 服务端还是旧的备份格式，需要先更新并重启服务端再试。设备没有开始写入。'};
let releaseKey='',release,loader,transport,device,port,upgradeSnapshot,busy=false,writing=false,expectedMac='',heard=false;
let lastStage='',fullBackup=null,connectingAt=0,releaseUsbLock=null,nvsSnapshot=null,savedWifi=false,savedSsid='',formOpen=false;
const thisComputer=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
const USB_FILTERS=[{usbVendorId:0x303a},{usbVendorId:0x1a86},{usbVendorId:0x10c4}];
function friendlyStatus(text){
 // Never round away a live byte count and ETA: that is the whole progress story.
 if(/约剩|\d (?:\.\d+ )?(?:MB|KB) \/ /.test(text))return text;
 if(/重新连接|USB 读取中断/.test(text))return '连接暂时中断，正在自动重试，请保持数据线连接…';
 if(/USB：|读取|芯片|Flash|分区|固件指纹|当前固件检查|应用读取/.test(text))return '正在确认喵伴，请稍等…';
 if(/备份设置|正在备份/.test(text))return '正在保存设置备份，秒级完成…';
 if(/备份原机|原机备份/.test(text))return '正在备份原机，请保持数据线连接…';
 if(/自动准备 VoiceHub|校验升级包|核对更新包|准备 VoiceHub/.test(text))return '正在准备连接…';
 if(/写入连接设置/.test(text))return '正在为喵伴设置网络，请保持数据线连接…';
 if(/设置启动应用|正在安装应用/.test(text))return '正在更新喵伴，请保持数据线连接…';
 if(/配置已保存并校验/.test(text))return '设置完成，即将尝试重启喵伴…';
 if(/原机备份已自动保存并校验|原机备份已保存/.test(text))return '备份完成。';
 if(/应用已写入并校验/.test(text))return '设置完成，请等待喵伴重新连接。';
 return text;
}
function status(text,progress){lastStage=text;$('echoear-install-status').textContent=friendlyStatus(text);$('echoear-technical-details').textContent=text;if(progress!==undefined)$('echoear-install-progress').value=Math.round(Math.max(0,Math.min(1,progress))*100);}
const size=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB';
// The progress bar carries the only number a first-time user cares about:
// how much longer to keep the cable plugged in.
function progressReporter(label){
 const started=Date.now();
 return (done,total)=>{
  if(total<1048576)return status('正在'+label+'…',done/total);
  const seconds=Math.max(1,Math.round((Date.now()-started)/1000)),rate=done/Math.max(1,seconds);
  const left=done>0&&rate>0?Math.max(1,Math.round((total-done)/rate)):0;
  status('正在'+label+'：'+size(done)+' / '+size(total)+(left?'，约剩 '+left+' 秒…':'…'),done/total);
 };
}
function wifiMode(){
 const keep=$('echoear-wifi-mode').value==='keep',open=$('echoear-wifi-open').checked;
 $('echoear-wifi-fields').hidden=keep;
 $('echoear-wifi-ssid').required=!keep;$('echoear-wifi-password').required=!keep&&!open;
 $('echoear-wifi-ssid').disabled=busy||keep;$('echoear-wifi-password').disabled=busy||keep||open;
 $('echoear-wifi-mode').disabled=busy;$('echoear-wifi-open').disabled=busy;
 $('echoear-wifi-hint').textContent=keep?'使用喵伴之前连接过的 Wi-Fi，无需再次填写密码。请让电脑也连接到这个网络。':'使用电脑相同的 2.4 GHz Wi-Fi，可修改名称。请填写密码；开放网络请明确勾选。';
}
function showNetworkForm(){
 formOpen=true;$('echoear-network-intro').hidden=true;$('echoear-network-form').hidden=false;
 $('echoear-wifi-mode').value='new';wifiMode();
 try{$('echoear-wifi-ssid').focus();}catch{}
}
function drawNetworkStep(){
 if(!device)return;
 const intro=$('echoear-network-intro'),form=$('echoear-network-form'),other=$('echoear-other-wifi');
 if(formOpen||!savedWifi){intro.hidden=true;form.hidden=false;other.hidden=true;wifiMode();return;}
 intro.hidden=false;form.hidden=true;other.hidden=false;
 $('echoear-network-lead').textContent='喵伴已连接'+(device.image?.version?'（固件 '+device.image.version+'）':'')+'，并且保存过 Wi-Fi'+(savedSsid?'「'+savedSsid+'」':'')+'。点一下就能完成。';
 $('echoear-open-network').textContent='一键配网（沿用已保存的 Wi-Fi）';
}
function stepControls(){
 const step=connectingAt?3:device?2:1;
 document.querySelectorAll('[data-usb-step]').forEach(el=>{const n=Number(el.dataset.usbStep);if(n===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');el.classList.toggle('done',n<step);});
 document.querySelectorAll('[data-usb-panel]').forEach(el=>el.hidden=Number(el.dataset.usbPanel)!==step);
}
$('echoear-other-wifi').onclick=()=>{if(busy)return;$('echoear-other-wifi').hidden=true;showNetworkForm();
 try{fetch('/api/clients/echoear-s3/current-wifi').then(r=>r.ok?r.json():null).then(value=>{if(value?.ssid&&!$('echoear-wifi-ssid').value)$('echoear-wifi-ssid').value=value.ssid;}).catch(()=>{});}catch{}
};
$('echoear-open-network').onclick=()=>{if(busy||!device)return undefined;return savedWifi?action(()=>provision({keepWifi:true})):showNetworkForm();};
$('echoear-update-with-setup').onchange=controls;
$('echoear-wifi-mode').onchange=wifiMode;$('echoear-wifi-open').onchange=wifiMode;
function controls(){
 const supported=!!navigator.serial&&!!window.isSecureContext;
 $('echoear-serial-note').textContent=supported?'使用数据线连接猫头的 USB 接口。检查会暂时进入下载模式，期间停止联网对话；检查或备份结束后点“断开 USB”让设备重启。':'请用电脑上的 Chrome 或 Edge，通过 HTTPS 或本机 localhost 打开本页面。';
 $('echoear-connect').disabled=busy||!supported||!release?.install;
 $('echoear-backup').disabled=busy||!device||!thisComputer;
 $('echoear-upgrade').disabled=busy||!device||!thisComputer||release?.install?.validated!==true;
 $('echoear-restore').disabled=busy||!device||!thisComputer;
 $('echoear-disconnect').disabled=busy||!transport;
 $('echoear-setup').disabled=busy||!device||!supported||!thisComputer;
 $('echoear-open-network').disabled=busy||!device||!supported||!thisComputer;
 $('echoear-other-wifi').disabled=busy;
 $('echoear-update-with-setup').disabled=busy||release?.install?.validated!==true;
 if(release?.install?.validated!==true)$('echoear-update-with-setup').checked=false;
 $('echoear-update-note').textContent=release?.install?.validated===true?'兼容设备可勾选升级；升级前会自动保存可恢复的原机备份（约 8 MB，1 分钟左右）。':'已有兼容固件可以直接连接。候选新固件尚未完成实机验收，更新选项暂不可选。';
 $('echoear-setup').textContent=release?.install?.validated===true&&$('echoear-update-with-setup').checked?'开始安装并配网':'开始配置';
 $('echoear-network-host').disabled=busy;wifiMode();stepControls();drawNetworkStep();
 if(!thisComputer)$('echoear-setup-status').textContent='USB 一体接入请在运行 VoiceHub 的这台电脑上，通过 localhost 打开页面。';
 $('echoear-heard').disabled=!$('echoear-heard').dataset.ready;
 $('echoear-heard').hidden=!$('echoear-heard').dataset.ready;
 $('echoear-disconnect').hidden=!transport;
 $('echoear-install-progress').hidden=!busy;
}
async function action(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){
 const stage=lastStage;console.warn('EchoEar operation failed:',stage,e.name,e.message);
 const cancelled=!writing&&(e.name==='AbortError'||e.name==='NotFoundError');
 const serialTimeout=/No serial data|Serial data stream stopped|timed?\s*out|Timeout/i.test(e.message||'');
 const message=e.keepConnection?(messages[e.message]||e.message):cancelled?'已取消。设备没有开始安装。':messages[e.message]||
  (serialTimeout?'USB 读取中断或超时。请重新连接；若反复发生，请保留下面的阶段和错误信息。':'操作没有完成。请检查数据线、关闭占用串口的软件，再重新连接；已有备份可用于恢复。');
 // A failed inspection must not retain a stale loader or keep the robot in
 // download mode. Never reset automatically after a failed flash write.
 if(!writing&&!e.keepConnection)await disconnect();
 status(/芯片|Flash|分区|校验|NVS|固件|串口/.test(message)?'暂时无法完成，请重新连接喵伴后再试。':message);
 $('echoear-technical-details').textContent=stage+'\n'+String(e.message||e.name).slice(0,200);
 }finally{busy=false;writing=false;controls();}}
async function acquireUsbLock(){
 if(releaseUsbLock||!navigator.locks)return;
 let decide;const acquired=new Promise(resolve=>{decide=resolve});
 navigator.locks.request('aihub-echoear-usb',{ifAvailable:true},lock=>{
  if(!lock){decide(false);return;}
  return new Promise(resolve=>{releaseUsbLock=resolve;decide(true);});
 }).catch(()=>decide(false));
 if(!await acquired)throw new Error('usb_in_use');
}
async function disconnect(){
 let resetRequested=false;
 if(loader){try{await loader.after('hard_reset');resetRequested=true;}catch{}}
 if(transport){try{await transport.disconnect();}catch{}}
 loader=transport=device=port=upgradeSnapshot=null;nvsSnapshot=null;savedWifi=false;savedSsid='';formOpen=false;$('echoear-device-info').textContent='';
 if(releaseUsbLock){releaseUsbLock();releaseUsbLock=null;}
 return resetRequested;
}
window.addEventListener('aihub:firmware',event=>{
 const next=event.detail;
 if(busy)return;
 const key=JSON.stringify([next?.sha256,next?.install]);
 if(releaseKey!==key){device=upgradeSnapshot=null;expectedMac='';heard=false;$('echoear-heard').dataset.ready='';}
 releaseKey=key;release=next;
 $('echoear-update-with-setup').checked=release?.install?.validated===true;
 $('echoear-release-status').textContent=!release?.install?'安装包还在准备中。已安装适配固件的设备可跳过升级，继续下面的联网设置。':
  release.install.validated?'已提供通过实机验收的版本 '+release.version:'版本 '+release.version+' 已构建，正在等待实机验收；可先检查设备和保存备份。';
 controls();
});
async function openUsbLoader(target,baudrate=460800,block=READ_FLASH_BLOCK){
 const {ESPLoader,Transport,ESPError}=await import('./vendor/esptool-js-0.7.0/bundle.js');
 transport=installSlipReader(new Transport(target,false),ESPError);
 loader=new ESPLoader({transport,baudrate,romBaudrate:115200,debugLogging:false,serialOptions:{bufferSize:1024*1024},
  terminal:{clean(){},writeLine(text){if(text?.trim())status('USB：'+text.trim());},write(){}}});
 loader.FLASH_READ_TIMEOUT=10000;installFlashReader(loader);loader.FLASH_READ_BLOCK=block;
}
// A previously granted port means the novice never sees the browser's port
// picker again; a failing probe falls back to it explicitly.
async function pickPort(){
 if(!navigator.serial)throw new Error('serial_unsupported');
 let known=[];try{known=await navigator.serial.getPorts();}catch{}
 for(const candidate of known){
  let info={};try{info=candidate.getInfo();}catch{}
  if(!info.usbVendorId||USB_FILTERS.some(filter=>filter.usbVendorId===info.usbVendorId))return{target:candidate,remembered:true};
 }
 return{target:await navigator.serial.requestPort({filters:USB_FILTERS}),remembered:false};
}
// Probe the fastest frame size once per connection: 4KB frames are ~4x faster,
// and a link that cannot carry them is retried at the proven 1KB size.
async function connectUsbLoader(target){
 let lastError;
 for(const [baudrate,block] of [[460800,READ_FLASH_BLOCK],[460800,FALLBACK_FLASH_BLOCK],[115200,FALLBACK_FLASH_BLOCK]]){
  try{
   await openUsbLoader(target,baudrate,block);
   status(block===READ_FLASH_BLOCK?'正在连接设备，请稍等…':'正在以兼容方式重新连接设备…',0);
   await loader.main();
   await readDeviceRegions(loader,['table']);
   return;
  }catch(error){
   lastError=error;
   try{await loader?.after('hard_reset');}catch{}
   try{await transport?.disconnect();}catch{}
   loader=transport=null;
  }
 }
 throw lastError;
}
async function reconnect({attempt,regions}){
 status('USB 读取中断，正在重新连接（第 '+attempt+' 次）…',0);
 const target=transport?.device||port;
 try{await transport?.disconnect();}catch{}
 for(let index=0;;index++){
  await new Promise(resolve=>setTimeout(resolve,200*(index+1)));
  try{await connectUsbLoader(target);break;}
  catch(error){if(index>=2||!/(?:Failed to open|already open)/i.test(error.message||''))throw error;}
 }
 const identity=await inspectDeviceIdentity(loader,release);
 if(identity.mac!==device.mac||identity.layout!==device.layout||identity.flashSize!==device.flashSize)throw new Error('backup_wrong_device');
 // A robot that was re-flashed or re-provisioned while we were disconnected
 // must not be stitched into one mixed snapshot.
 for(const [name,bytes] of Object.entries(regions||{})){
  const region=REGIONS[name];
  if(!region||bytes.length!==region.size||typeof loader.flashMd5sum!=='function')continue;
  if(String(await loader.flashMd5sum(region.address,region.size)).toLowerCase()!==hex(md5(bytes)))throw new Error('device_state_changed');
 }
 return loader;
}
async function readNvsState(){
 nvsSnapshot=(await readDeviceRegions(loader,['nvs'])).nvs;
 savedWifi=hasSavedWifi(nvsSnapshot);savedSsid=savedWifi?savedWifiSsid(nvsSnapshot):'';
}
$('echoear-connect').onclick=()=>action(async()=>{
 await disconnect();$('echoear-network-intro').hidden=false;$('echoear-network-form').hidden=true;heard=false;connectingAt=0;expectedMac='';$('echoear-verify-status').textContent='';$('echoear-heard').dataset.ready='';status('请选择 USB 设备…',0);
 await acquireUsbLock();
 const picked=await pickPort();port=picked.target;
 try{await connectUsbLoader(port);}
 catch(error){
  if(!picked.remembered)throw error;
  // The remembered port is not the robot: let the user pick again, once.
  try{await transport?.disconnect();}catch{}
  port=await navigator.serial.requestPort({filters:USB_FILTERS});
  await connectUsbLoader(port);
 }
 device=await inspectDeviceIdentity(loader,release,status);
 expectedMac=device.mac;
 try{await readNvsState();}catch(error){error.keepConnection=true;throw error;}
 const boot=device.bootError?'（启动记录不可用，只能配网，不能升级）':'';
 $('echoear-device-info').textContent='已连接喵伴'+(device.image?.version?' · 固件 '+device.image.version:'')+(device.flashSize?' · '+device.flashSize:'');
 status('喵伴已连接。'+(savedWifi?'点“一键配网”即可。':'请填写 Wi-Fi 名称和密码。')+boot,1);
});
async function knownBackup(device,kind){
 try{return await latestAutomaticBackup(device,{kind});}
 catch(error){if(error.message==='backup_not_found')return null;throw error;}
}
async function capture(kind,label){
 const saved=await captureDeviceBackup(device,loader,{kind,previous:await knownBackup(device,kind),
  progress:progressReporter(label),recover:value=>reconnect(value)});
 return saveAutomaticBackup(saved.bytes,device);
}
function imageOf(backup,slot){return backup.regions[slot?'app1':'app0'];}
async function upgradeBackup(full){
 return decodeBackup(await encodeBackup({mac:device.mac,layout:device.layout,targetSlot:device.targetSlot},[
  {name:'nvs',address:PROFILE.nvs,data:full.regions.nvs},{name:'otadata',address:PROFILE.ota,data:device.ota},
  {name:'target',address:PROFILE.apps[device.targetSlot],data:imageOf(full,device.targetSlot)}]));
}
async function downloadImage(){
 const response=await fetch(release.download);
 if(!response.ok)throw new Error('firmware_download_failed');
 return new Uint8Array(await response.arrayBuffer());
}
// Installing an application needs the full check and a backup that can undo it.
async function installApplication(image){
 status('正在核对现有固件与升级包…',0);
 device=await inspectDevice(loader,release,status,device);
 fullBackup=await capture('full','备份原机');
 upgradeSnapshot=await upgradeBackup(fullBackup);
 writing=true;
 const result=await upgrade(loader,device,release,image,upgradeSnapshot,status);
 const ota=(await readDeviceRegions(loader,['otadata'])).otadata;
 device.ota=ota;
 if(result.slot===undefined)throw new Error('flash_verification_failed');
 return result;
}
async function provision(credentials){
 if(!device||!thisComputer)throw new Error('请在 VoiceHub 本机连接并检查 USB 设备。');
 status('正在自动准备 VoiceHub 设备连接服务…',0);
 const connection=await prepareConnection();
 status('正在检查设备设置空间…',0);
 // Always re-read: an earlier attempt may already have changed the settings.
 nvsSnapshot=(await readDeviceRegions(loader,['nvs'])).nvs;
 const raw=nvsSnapshot;
 let nvs;
 try{nvs=connectionNvs(raw,{...credentials,...connection});}
 catch(error){
  if(error.message==='wifi_credentials_required'){$('echoear-wifi-mode').value='new';error.keepConnection=true;showNetworkForm();status('喵伴没有可沿用的 Wi-Fi，请填写名称和密码。',0);}
  throw error;
 }
 const update=$('echoear-update-with-setup').checked&&release?.install?.validated===true;
 if(update){
  const image=await downloadImage();
  await installApplication(image);
 }else{
  // Only NVS is about to change, so only NVS has to be recoverable. This is
  // the difference between a 10 second setup and a five minute one.
  status('正在保存设置备份…',0);
  fullBackup=await capture('settings','备份设置');
 }
 status('正在写入连接设置并读回核对…',1);
 writing=true;
 await applyNetwork(loader,device,fullBackup,nvs,status);
 $('echoear-wifi-password').value='';connectingAt=Date.now();heard=false;$('echoear-heard').dataset.ready='';
 status('配置已保存并校验，正在请求喵伴重启…',1);
 const resetRequested=await disconnect();
 status(resetRequested?'设置完成，正在等待喵伴重新连接。':'配置已完成，但自动重启请求失败。请将喵伴完全断电 5 秒后重新开机。',1);
 $('echoear-verify-status').textContent='正在等待喵伴上线，首次连接可能需要一些时间。';
 window.dispatchEvent(new CustomEvent('aihub:connection-prepared'));
}
$('echoear-backup').onclick=()=>action(async()=>{
 status('正在检查已有备份…',0);
 fullBackup=await capture('full','备份原机');
 status('原机备份已保存并校验。',1);
});
$('echoear-upgrade').onclick=()=>action(async()=>{
 if(release?.install?.validated!==true)throw new Error('release_not_hardware_validated');
 const image=await downloadImage();
 await installApplication(image);
 await disconnect();status('应用已写入并校验。请等待设备重新启动，然后完成联网设置。',1);
});
$('echoear-restore').onclick=()=>action(async()=>{
 status('正在查找并校验这台喵伴最近的可用备份…',0);
 fullBackup=await latestAutomaticBackup(device);
 status('正在恢复最近的可用备份，请保持 USB 连接。',0);
 writing=true;
 const result=await restoreDeviceBackup(loader,device,fullBackup,status);
 await disconnect();
 status(result.scope==='full'?'已恢复原固件与连接设置。请等待设备重新启动。':'已恢复连接设置（固件未改动）。请等待设备重新启动。',1);
});
$('echoear-disconnect').onclick=()=>action(async()=>{await disconnect();status('USB 已断开，设备已尝试重启。');});
async function prepareConnection(){
 try{
  const host=$('echoear-network-host').value;
  const response=await fetch('/api/clients/echoear-s3/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...(host?{host}:{}),device_id:device.mac})});
  if(response.status===401)throw new Error('请先使用管理员账号登录。');
  const value=await setupResponse(response);
  if(!response.ok){
   if(value.interfaces?.length){
    const select=$('echoear-network-host');select.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择电脑连接喵伴的网络';select.append(placeholder);
    for(const item of value.interfaces){const option=document.createElement('option');option.value=item.address;option.textContent=(item.label||item.interface)+'（'+item.address+'）';select.append(option);}
    $('echoear-network-choice').hidden=false;
   }
   throw new Error(value.error?.message||'设备连接服务准备失败。');
  }
  return value;
 }catch(error){error.keepConnection=true;throw error;}
}
$('echoear-network-form').onsubmit=event=>{
 event.preventDefault();
 return action(async()=>{
  const keepWifi=$('echoear-wifi-mode').value==='keep',ssid=$('echoear-wifi-ssid').value,password=$('echoear-wifi-open').checked?'':$('echoear-wifi-password').value,bytes=new TextEncoder();
  if(!keepWifi&&(!ssid||bytes.encode(ssid).length>32||ssid.includes('\0')||bytes.encode(password).length>64||password.includes('\0')||!$('echoear-wifi-open').checked&&bytes.encode(password).length<8))throw new Error('invalid_wifi');
  await provision({ssid,password,keepWifi});
 });
};
$('echoear-copy-setup').onclick=async()=>{
 try{
  const response=await fetch('/api/clients/echoear-s3/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(device?.mac?{device_id:device.mac}:{})});
  if(response.status===401)throw new Error('请先使用管理员账号登录。');
  const value=await setupResponse(response);if(!response.ok)throw new Error(value.error?.message||'请先让管理员开启设备连接服务。');
  await navigator.clipboard.writeText(value.ota_url);$('echoear-setup-status').textContent='连接入口已复制。连接设备热点后，在设备配网页的“高级设置 → 自定义 OTA 地址”粘贴它并保存，再设置 Wi-Fi。';
 }catch(e){$('echoear-setup-status').textContent=e.message||'复制失败，请使用下方的连接设置下载。';}
};
$('echoear-heard').onclick=()=>{heard=true;$('echoear-verify-status').textContent='你已确认听到设备回复，语音接入完成。之后可以在对话记录和日志里查看。';};
setInterval(async()=>{
 if(!expectedMac||!connectingAt||document.hidden||$('echoear-installer').hidden||heard)return;
 try{
  const response=await fetch('/api/clients/echoear-s3/verify?device='+encodeURIComponent(expectedMac));
  if(!response.ok)return;const value=await setupResponse(response);
  $('echoear-heard').dataset.ready=value.recognized&&value.replied?'yes':'';
  $('echoear-verify-status').textContent=!value.online?(connectingAt&&Date.now()-connectingAt>120000?'尚未看到设备上线。请确认 Wi-Fi 名称和密码、电脑与喵伴网络可互通；同名 Wi-Fi 也可能存在客户端隔离。可以在高级选项中尝试恢复。':'正在等待设备联网。'):!value.recognized?'喵伴已联网！请用设备当前唤醒词唤醒（若为“小宝同学”，请说“小宝同学”），再说一句“你好”。':
   !value.replied?'喵伴听到了，正在准备回复…':value.playback_reported?'喵伴正在回复，你听到声音了吗？':'回复已准备好，请听听喵伴有没有回应。';controls();
 }catch{}
},3000);
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{disconnect().catch(()=>{});});
controls();
// 控制台契约：只有在面板元素全部绑定成功后才声明自己可用。网页控制台据此决定
// 显示刷机面板还是退回文字向导（见 aihub-web README「刷机助手不在这个仓库」）。
window.AIHubFlasher={client:'echoear-s3',module:'echoear-installer'};
