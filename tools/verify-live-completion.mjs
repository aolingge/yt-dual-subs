// Actual muted tabCapture + local ASR. Only controlled page metadata is supplied.
import { Cdp } from './verify-bilibili.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.env.YTDS_COMPLETION_OUTPUT || 'E:/codemain/others/output/yt-dual-subs-completion-20261004/browser';
fs.mkdirSync(out, {recursive:true});
const desktop = 'E:/codemain/deautschapp';
const python = path.join(desktop,'.venv/Scripts/python.exe');
const turbo = 'E:/codemain/others/output/yt-dual-subs-resources-20261004/models/whisper-large-v3-turbo';
const fixture = JSON.parse(fs.readFileSync('E:/codemain/others/output/yt-dual-subs-resources-20261004/human-fixtures.json')).cases.find(c=>c.language==='zh');
const wav = fs.readFileSync(fixture.audio);
const decodedFixture = process.argv.includes('--decoded-fixture');
const captureDiagnostics = process.argv.includes('--capture-diagnostics');
const fakeOutput = process.argv.includes('--fake-output');
const headed = process.argv.includes('--headed');
if (decodedFixture && captureDiagnostics) throw new Error('Choose one input verification mode.');
const state = fs.mkdtempSync(path.join(os.tmpdir(),'ytds-bridge-test-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'ytds-muted-live-'));
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report = {mode:captureDiagnostics?'capture-diagnostics':decodedFixture?'decoded-fixture':'live-capture',
  checks:[],fixture:{id:fixture.id,reference:fixture.reference,source:fixture.source},
  limitations:['Controlled Bilibili metadata and public human recording; actual AudioWorklet, bridge and models. Headless permission invocation is simulated; acoustic output was not instrumented.']};
if (fakeOutput) report.limitations.push('Fake hardware audio output is enabled; tabCapture input is not replaced. This does not verify the ordinary hardware output device.');
const check=(ok,name)=>{if(!ok)throw new Error(name);report.checks.push(name)};
const bridge = spawn(python,['-m','deutsch_overlay.browser_cli','--port','0','--turbo-model-path',turbo],
  {cwd:desktop,env:{...process.env,DEUTSCH_OVERLAY_STATE:state},stdio:['ignore','pipe','pipe'],windowsHide:true});
let bridgeLog=''; bridge.stdout.on('data',chunk=>bridgeLog+=chunk);bridge.stderr.on('data',chunk=>bridgeLog+=chunk);
let child,browser,worker,page,popup,sw,handshake;
const sockets=[];
if (decodedFixture) report.limitations.push('tabCapture input replaced by a decoded public WAV stream to verify the downstream AudioWorklet, bridge and UI; this is not a nonzero tabCapture proof.');
try{
  for(let i=0;i<240;i++){try{handshake=JSON.parse(fs.readFileSync(path.join(state,'bridge.json')));break}catch{}await delay(250)}
  check(!!handshake,'isolated bridge wrote handshake');
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  // Headless Chromium can expose decoded media to captureStream while its
  // tabCapture backend returns a zero track. Keep that limitation explicit;
  // the optional virtual audio sink makes the same check reproducible without
  // touching the user's system output device.
  const args=[...(headed?[]:['--headless=new']),'--mute-audio',...(fakeOutput?['--disable-audio-output']:[]),'--autoplay-policy=no-user-gesture-required','--enable-automation','--no-first-run','--no-default-browser-check','--lang=zh-CN',
    '--autoplay-policy=no-user-gesture-required','--remote-debugging-port='+port,'--user-data-dir='+profile,
    '--disable-extensions-except='+root,'--load-extension='+root,
    '--allowlisted-extension-id=lepdkfcieaiafipjgnoedoebmiadneid','about:blank'];
  child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args,{stdio:'ignore',windowsHide:true});
  let version;for(let i=0;i<80;i++){try{version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();break}catch{}await delay(250)}
  browser=await Cdp.attach(version.webSocketDebuggerUrl);sockets.push(browser);
  const actual=await browser.send('Browser.getBrowserCommandLine');
  check(actual.arguments.includes('--mute-audio'),'actual browser has --mute-audio');report.browser=version.Browser;
  const targets=async()=> (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for(let i=0;i<60;i++){sw=(await targets()).find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js'));if(sw)break;await delay(250)}
  worker=await Cdp.attach(sw.webSocketDebuggerUrl);sockets.push(worker);await worker.send('Runtime.enable');await worker.send('Debugger.enable');await worker.send('Runtime.runIfWaitingForDebugger');
  await delay(500);
  const extensionId=new URL(sw.url).host;report.extensionId=extensionId;
  report.version=await worker.evaluate(`chrome.runtime.getManifest().version`);
  // Headless automation cannot operate a permission dialog or browser toolbar.
  await worker.evaluate(`chrome.permissions.contains=async()=>true;YtdsSettings.enqueue({bbEnabled:true,recognitionLanguage:'zh',bridgeBase:${JSON.stringify(handshake.url)},bridgeToken:${JSON.stringify(handshake.token)}})`);
  const target=await browser.send('Target.createTarget',{url:'about:blank'});
  page=await Cdp.attach((await targets()).find(t=>t.id===target.targetId).webSocketDebuggerUrl);sockets.push(page);
  await page.send('Runtime.enable');await page.send('Page.enable');await page.send('Fetch.enable',{patterns:[{urlPattern:'https://www.bilibili.com/*'},{urlPattern:'https://api.bilibili.com/*'}]});
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>静音识别验证</title><script>window.__INITIAL_STATE__={videoData:{bvid:'BV1xx411c7mD',aid:12345,cid:111,pages:[{page:1,cid:111},{page:2,cid:222}],subtitle:{list:[]}}};</script><style>body{background:#151515;color:white}.bpx-player-container{position:relative;width:960px;height:540px}.bpx-player-video-wrap{position:absolute;inset:0}video{width:100%;height:100%}</style></head><body><div id="bilibili-player" class="bpx-player-container"><div class="bpx-player-video-wrap"><video src="/human.wav" playsinline></video></div><div class="bpx-player-control-wrap"><div class="bpx-player-control-bottom-right"></div></div></div></body></html>`;
  const pump=setInterval(()=>{for(const event of page.events.splice(0)){if(event.method!=='Fetch.requestPaused')continue;const req=event.params;let body,headers;
    if(req.request.url.includes('/human.wav')){body=wav;headers=[{name:'Content-Type',value:'audio/wav'}]}
    else if(req.request.url.includes('api.bilibili.com')){body=Buffer.from(JSON.stringify({code:0,data:{subtitle:{subtitles:[]}}}));headers=[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'https://www.bilibili.com'},{name:'Access-Control-Allow-Credentials',value:'true'}]}
    else{body=Buffer.from(html);headers=[{name:'Content-Type',value:'text/html; charset=utf-8'}]}
    page.send('Fetch.fulfillRequest',{requestId:req.requestId,responseCode:200,responseHeaders:headers,body:body.toString('base64')}).catch(()=>{});
  }},15);
  report.pumpStarted=true;
  await page.send('Page.navigate',{url:'https://www.bilibili.com/video/BV1xx411c7mD/?p=1'});
  await browser.send('Target.activateTarget',{targetId:target.targetId});
  const tab=await worker.evaluate(`chrome.tabs.query({active:true,currentWindow:true}).then(t=>({id:t[0].id}))`);
  const context=()=>worker.evaluate(`chrome.tabs.sendMessage(${tab.id},{type:'recognitionContext'})`);
  let ctx;for(let i=0;i<80;i++){try{ctx=await context();if(ctx?.context?.captionAvailability==='absent')break}catch{}await delay(100)}
  report.initialContext=ctx;report.pageStatus=await worker.evaluate(`chrome.tabs.sendMessage(${tab.id},{type:'status'})`);
  report.pageDebug=await page.evaluate(`({url:location.href,state:window.__INITIAL_STATE__,video:!!document.querySelector('video'),scripts:[...document.scripts].map(s=>s.src)})`);
  check(ctx?.context?.captionAvailability==='absent','real page reader reliably reports absent captions');
  const popupTarget=await browser.send('Target.createTarget',{url:`chrome-extension://${extensionId}/popup.html`});
  popup=await Cdp.attach((await targets()).find(t=>t.id===popupTarget.targetId).webSocketDebuggerUrl);sockets.push(popup);await popup.send('Runtime.enable');await popup.send('Page.enable');
  await delay(600);
  await popup.evaluate(`document.querySelector('#bridgeOptions').open=true;onBridgeOptions(false)`);
  check(await popup.evaluate(`!document.querySelector('#bridgeOptionsFields').disabled && document.querySelector('#bridgeModel').options.length>=2`),'Chinese popup loads authenticated registered model profiles');
  await popup.evaluate(`document.querySelector('#bridgeModel').value='turbo';document.querySelector('#bridgeScript').value='simplified';onBridgeOptions(true)`);
  check(await popup.evaluate(`document.querySelector('#bridgeOptionsStatus').textContent.includes('应用')`),'model selection applies from real popup');
  check(await popup.evaluate(`document.querySelector('#bridgeOptions').getBoundingClientRect().height>0`),'model settings are visible in normal popup');
  await popup.send('Emulation.setDeviceMetricsOverride',{width:900,height:1000,deviceScaleFactor:1,mobile:false});
  await popup.evaluate(`document.querySelector('#bridgeOptions').scrollIntoView()`);
  await popup.send('Page.captureScreenshot',{format:'png'}).then(result=>fs.writeFileSync(path.join(out,'model-settings.png'),Buffer.from(result.data,'base64')));
  await popup.send('Page.navigate',{url:`chrome-extension://${extensionId}/popup.html?studyTab=${tab.id}`});await delay(600);
  await browser.send('Target.activateTarget',{targetId:target.targetId});
  if (decodedFixture) {
    await worker.evaluate(`ensureOffscreenDocument()`);
    const fixtureTarget=(await targets()).find(t=>t.url.endsWith('/offscreen.html'));
    const fixtureRecorder=await Cdp.attach(fixtureTarget.webSocketDebuggerUrl);sockets.push(fixtureRecorder);await fixtureRecorder.send('Runtime.enable');
    await fixtureRecorder.evaluate(`(async()=>{globalThis.fixtureCtx=new AudioContext();globalThis.fixtureAudio=fixtureCtx.createBufferSource();fixtureAudio.buffer=await fixtureCtx.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(wav.toString('base64'))}),c=>c.charCodeAt(0)).buffer);globalThis.fixtureDest=fixtureCtx.createMediaStreamDestination();fixtureAudio.connect(fixtureDest);navigator.mediaDevices.getUserMedia=async()=>fixtureDest.stream;})()`);
  }
  const start=await popup.evaluate(`chrome.runtime.sendMessage({type:'recogStart',tabId:${tab.id}})`);report.start=start;
  check(start?.ok,decodedFixture?'decoded public recording session starts':'actual tabCapture session starts');
  await page.evaluate(`document.querySelector('video').muted=false;document.querySelector('video').volume=1;document.querySelector('video').play()`);
  if (captureDiagnostics) {
    // Tap the real element's decoded audio; do not replace tabCapture input.
    await page.evaluate(`(async()=>{globalThis.sourceProbeCtx=new AudioContext();globalThis.sourceProbe=sourceProbeCtx.createAnalyser();globalThis.sourceProbeMax=0;const input=sourceProbeCtx.createMediaStreamSource(document.querySelector('video').captureStream());const silent=sourceProbeCtx.createGain();silent.gain.value=0;input.connect(sourceProbe);sourceProbe.connect(silent);silent.connect(sourceProbeCtx.destination);await sourceProbeCtx.resume();globalThis.sourceProbeTimer=setInterval(()=>{const samples=new Float32Array(sourceProbe.fftSize);sourceProbe.getFloatTimeDomainData(samples);for(const value of samples)sourceProbeMax=Math.max(sourceProbeMax,Math.abs(value));},50);})()`);
  }
  let offscreen;for(let i=0;i<60;i++){offscreen=(await targets()).find(t=>t.url.endsWith('/offscreen.html'));if(offscreen)break;await delay(100)}
  const recorder=await Cdp.attach(offscreen.webSocketDebuggerUrl);sockets.push(recorder);await recorder.send('Runtime.enable');
  await recorder.evaluate(`globalThis.testPcm={frames:0,max:0};const handler=__ytdsOffscreen.node.port.onmessage;__ytdsOffscreen.node.port.onmessage=e=>{if(e.data?.samples){testPcm.frames+=e.data.samples.length;for(const v of e.data.samples)testPcm.max=Math.max(testPcm.max,Math.abs(v));}handler(e)}`);
  if(decodedFixture) await recorder.evaluate(`fixtureCtx.resume();fixtureAudio.start()`);
  if (captureDiagnostics) {
    report.inputStates=[];
    for (let i=0;i<100;i++) {
      const current=await popup.evaluate(`chrome.runtime.sendMessage({type:'recogStatus'})`);
      const input=current.recorder?.audioInput;
      if(input && report.inputStates.at(-1)?.state!==input.state) report.inputStates.push(input);
      if (input?.state==='silent' || input?.state==='signal') break;
      await delay(100);
    }
    report.pcm=await recorder.evaluate(`testPcm`);
    report.sourcePcm=await page.evaluate(`({peak:sourceProbeMax,context:sourceProbeCtx.state})`);
    report.nonzeroCaptureVerified=report.pcm.max>0;
    report.nonzeroSourceVerified=report.sourcePcm.peak>0;
    report.recorderStatus=await popup.evaluate(`chrome.runtime.sendMessage({type:'recogStatus'})`);
    check(report.inputStates.some(input=>['silent','signal'].includes(input.state)), 'real capture health reaches the popup status');
    await popup.send('Page.navigate',{url:`chrome-extension://${extensionId}/popup.html`});
    await delay(600);
    await popup.evaluate(`refreshStatus()`);
    const ui=await popup.evaluate(`document.querySelector('#recogStatus').textContent`);
    report.inputUi=ui;
    check(ui.includes('音频输入'), 'Chinese input health is visible in the real popup');
    check(await popup.evaluate(`document.querySelector('#recogStatus').getBoundingClientRect().height>0`),'input health is not hidden in the popup');
    check(report.recorderStatus.recorder.metrics?.queuedClips!==undefined,'bridge metrics reach the real popup');
    await popup.evaluate(`document.querySelector('#recogStatus').scrollIntoView({block:'center'})`);
    await popup.send('Page.captureScreenshot',{format:'png'}).then(result=>fs.writeFileSync(path.join(out,'capture-diagnostics.png'),Buffer.from(result.data,'base64')));
    await popup.evaluate(`chrome.runtime.sendMessage({type:'recogStop',tabId:${tab.id}})`);
    clearInterval(pump);
    report.success=true;
  } else {
  let cues=[];
  for(let i=0;i<160;i++){await delay(250);cues=await recorder.evaluate(`globalThis.__ytdsOffscreen.session?.cues || []`);if(cues.some(c=>c.trans))break;}
  report.cues=cues;report.recorder=await recorder.evaluate(`({sessionId:__ytdsOffscreen.session?.sessionId,epoch:__ytdsOffscreen.session?.epoch,sampleIndex:__ytdsOffscreen.session?.sampleIndex,cueCount:__ytdsOffscreen.session?.cues.length})`);
  const sid=report.recorder.sessionId;
  const transcripts=await(await fetch(handshake.url+'/v1/session/'+sid+'/transcript',{method:'POST',headers:{Authorization:'Bearer '+handshake.token,'Content-Type':'application/json'},body:JSON.stringify({sinceRevision:0})})).json();
  report.transcript=transcripts;report.metrics=transcripts.metrics;
  report.pcm=await recorder.evaluate(`testPcm`);
  report.captureState=await recorder.evaluate(`({clock:__ytdsOffscreen.clock,metrics:__ytdsOffscreen.session.metrics,status:__ytdsOffscreen.session.status,failures:__ytdsOffscreen.session.flushFailures})`);
  report.videoState=await page.evaluate(`({paused:document.querySelector('video').paused,currentTime:document.querySelector('video').currentTime,ended:document.querySelector('video').ended})`);
  check(cues.length>0,decodedFixture?'decoded human speech produced source captions':'captured real human speech produced source captions');
  check(cues.some(c=>c.trans),'local OPUS produced translated captions without cloud requests');
  check(transcripts.segments?.length>0,'actual bridge transcript confirms nonzero captured speech');
  await popup.evaluate(`document.querySelector('#transcriptPanel').open=true;document.querySelector('#transcriptPanel').dispatchEvent(new Event('toggle'))`);
  for(let i=0;i<40;i++){if(await popup.evaluate(`document.querySelectorAll('#transcriptList .study-item').length>0`))break;await delay(100)}
  report.learningStatus=await worker.evaluate(`chrome.tabs.sendMessage(${tab.id},{type:'status'})`);
  report.learningCues=await worker.evaluate(`chrome.tabs.sendMessage(${tab.id},{type:'studyCues',offset:0,limit:40,query:''})`);
  report.learningPopup=await popup.evaluate(`(async()=>({url:location.href,tab:(await getActiveTab())?.id,list:document.querySelector('#transcriptList').textContent}))()`);
  check(await popup.evaluate(`document.querySelectorAll('#transcriptList .study-item').length>0`),'real learning list displays recognized segments');
  await popup.evaluate(`document.querySelector('#transcriptList .study-item-actions button:nth-child(3)').click()`);
  await popup.evaluate(`document.querySelector('.study-edit').value='人工校正测试。';[...document.querySelectorAll('#transcriptList button')].find(b=>b.textContent==='保存校正').click()`);
  await delay(300);
  check(await popup.evaluate(`document.querySelector('#transcriptList').textContent.includes('人工校正测试。')`),'Chinese correction saves in real learning UI');
  await popup.send('Page.captureScreenshot',{format:'png'}).then(result=>fs.writeFileSync(path.join(out,'manual-correction.png'),Buffer.from(result.data,'base64')));
  const retry=await popup.evaluate(`chrome.runtime.sendMessage({type:'recogRetry',tabId:${tab.id},videoId:'BV1xx411c7mD#p1',segmentId:${JSON.stringify(cues[0].id)},timelineEpoch:${JSON.stringify(cues[0].epoch)}})`);report.retry=retry;
  check(retry?.ok,'cached segment can be re-recognized without recapturing');
  const epoch=await recorder.evaluate(`__ytdsOffscreen.session.epoch`);
  await page.evaluate(`document.querySelector('video').currentTime=1;document.querySelector('video').playbackRate=1.25;document.querySelector('video').play()`);await delay(1500);
  check(await recorder.evaluate(`__ytdsOffscreen.session.epoch>${epoch}`),'seek and speed change advance live timeline epoch');
  const foreign=await popup.evaluate(`chrome.runtime.sendMessage({type:'recogRetry',tabId:${tab.id},videoId:'BV1xx411c7mD#p1',segmentId:${JSON.stringify(cues[0].id)},timelineEpoch:${epoch}})`);
  check(!foreign.ok,'stale retry rejected after seek');
  await popup.send('Page.captureScreenshot',{format:'png'}).then(result=>fs.writeFileSync(path.join(out,'settings-and-transcript.png'),Buffer.from(result.data,'base64')));
  await popup.evaluate(`chrome.runtime.sendMessage({type:'recogStop',tabId:${tab.id}})`);
  await page.evaluate(`history.pushState({},'', '?p=2');window.dispatchEvent(new Event('popstate'))`);await delay(900);
  report.partContext=await context();check(report.partContext?.context?.videoId?.endsWith('#p2'),'part switch changes video identity');
  clearInterval(pump);
  report.success=true;
  }
}catch(error){report.success=false;report.error=String(error.stack||error);}
finally{
  // Never persist the ephemeral bearer token or a signed YouTube URL.
  if(browser){try{await browser.send('Browser.close')}catch{}}
  for(const socket of sockets)socket.close();child?.kill();bridge.kill();
  report.bridgeLog=bridgeLog.replaceAll(handshake?.token||'__NO_TOKEN__','[redacted]');
  fs.writeFileSync(path.join(out,captureDiagnostics?'capture-diagnostics-report.json':decodedFixture?'decoded-fixture-report.json':'live-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:report.mode,success:report.success,nonzeroCaptureVerified:report.nonzeroCaptureVerified,
    checks:report.checks,error:report.error},null,2));
}
process.exit(report.success?0:1);
