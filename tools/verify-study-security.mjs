// Real extension UI in an isolated, muted Edge. All credentials/cards are fixtures.
import { Cdp } from './verify-bilibili.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.YTDS_EXTENSION_ROOT || fileURLToPath(new URL('..', import.meta.url));
const out = process.env.YTDS_STUDY_OUTPUT || path.join(root, 'tools', 'study-security-report');
fs.mkdirSync(out, { recursive: true });
const downloads = fs.mkdtempSync(path.join(out, 'downloads-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytds-study-muted-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { extensionRoot: root, checks: [], limitations: ['Fixture health server and cards; no real ASR capture or Anki application import.'] };
const check = (ok, name) => { if (!ok) throw new Error(name); report.checks.push(name); };
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, service: 'deutsch-overlay-bridge', protocolVersion: 1,
    modelReady: false, engine: 'fixture', languages: ['de', 'zh'] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const portProbe = http.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const args = ['--headless=new', '--mute-audio', '--enable-automation', '--no-first-run',
  '--no-default-browser-check', '--lang=zh-CN', '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile, '--disable-extensions-except=' + root, '--load-extension=' + root, 'about:blank'];
const child = spawn(process.env.YTDS_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args,
  { stdio: 'ignore', windowsHide: true });
let browser, worker, popup, videoPage, studyPage, fixtureTimer;
try {
  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {}
    await delay(250);
  }
  if (!version) throw new Error('Isolated Edge failed to start');
  browser = await Cdp.attach(version.webSocketDebuggerUrl);
  report.browser = version.Browser;
  const command = await browser.send('Browser.getBrowserCommandLine');
  report.muted = command.arguments.includes('--mute-audio');
  check(report.muted, 'actual browser command includes --mute-audio');
  let sw;
  for (let i = 0; i < 40; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    sw = targets.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    if (sw) break;
    await delay(250);
  }
  if (!sw) throw new Error('Extension service worker missing');
  worker = await Cdp.attach(sw.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  await worker.send('Debugger.enable'); // keep this isolated worker alive during async storage checks
  await worker.send('Runtime.runIfWaitingForDebugger');
  report.stage = 'local-token-write';
  check(await worker.evaluate(`(async()=>{
    await YtdsSettings.enqueue({bridgeBase:${JSON.stringify(base)},bridgeToken:'fixture-new-token'});
    const local=await chrome.storage.local.get(['bridgeConfigV1','settingsPendingV1']);
    const sync=await chrome.storage.sync.get(null);
    return (await YtdsBridgeVault.read())==='fixture-new-token'
      && !Object.hasOwn(local.bridgeConfigV1 || {}, 'bridgeToken')
      && !Object.hasOwn(local.settingsPendingV1?.values || {}, 'bridgeToken')
      && !Object.hasOwn(sync, 'bridgeToken');
  })()`), 'real Chrome token writes stay in extension IndexedDB and out of local/sync preferences');
  check(await worker.evaluate(`(async()=>{importScripts('bridge-vault.js');return (await YtdsBridgeVault.read())==='fixture-new-token'})()`),
    'a new vault connection reads the persisted credential');
  const card = { id: 'fixture', videoId: 'BV1xx411c7mD#p2', title: 'Anki 测试', index: 0,
    start: 12345, text: 'Hallo\t世界\n<script>', trans: '你好 & Erklärung', sourceLang: 'de', savedAt: 1 };
  await worker.evaluate(`chrome.storage.local.set({studyCardsV1:[${JSON.stringify(card)}]})`);
  await worker.evaluate(`chrome.storage.sync.set({karaokeBg:'#ffd65c',karaokeTextColor:'#161616',karaokeOpacity:0.95})`);
  const extensionId = new URL(sw.url).hostname;
  const target = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
  const targetList = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  popup = await Cdp.attach(targetList.find(t => t.id === target.targetId).webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await popup.send('Page.enable');
  for (let i = 0; i < 40; i++) {
    if (await popup.evaluate(`!!document.getElementById('bridgeToken') && document.getElementById('bridgeToken').value==='fixture-new-token'`)) break;
    await delay(100);
  }
  check(await popup.evaluate(`document.getElementById('bridgeToken').type==='password' &&
    document.getElementById('bridgeToken').value==='fixture-new-token'`), 'popup reads migrated token and masks the input');
  check(await popup.evaluate(`document.getElementById('recognitionLanguage').options.length===4`),
    'spoken language offers automatic, Chinese, German and English');
  check(await popup.evaluate(`document.getElementById('karaokeTextColor').value==='#ffffff' &&
    getComputedStyle(document.querySelector('.karaoke-preview-word')).color==='rgb(255, 255, 255)'`),
    'legacy default palette upgrades to readable white text in the actual popup preview');
  await popup.evaluate(`document.getElementById('recognitionLanguage').value='de';
    document.getElementById('recognitionLanguage').dispatchEvent(new Event('change'))`);
  for (let i=0;i<30;i++) {
    if (await worker.evaluate(`new Promise(resolve=>YtdsSettings.get({recognitionLanguage:'auto'},v=>resolve(v.recognitionLanguage==='de')))`)) break;
    await delay(100);
  }
  check(await worker.evaluate(`new Promise(resolve=>YtdsSettings.get({recognitionLanguage:'auto'},v=>resolve(v.recognitionLanguage==='de')))`),
    'spoken language selection persists through the real popup event');
  check(await worker.evaluate(`(async()=>{const r=await recogHealth();return !r.ok && r.code==='permission_required'})()`),
    'worker distinguishes missing loopback permission');
  // Permission-dialog interaction is excluded in headless QA; exercise the
  // worker fetch against the fixture server after replacing only contains().
  await worker.evaluate(`chrome.permissions.contains=async()=>true`);
  const health = await worker.evaluate(`recogHealth()`);
  check(health.ok && !health.modelReady && health.tokenVerified === false,
    'real HTTP health fetch reports model not ready and token not verified');
  await popup.evaluate(`chrome.permissions.request=async()=>true; onRecogTest()`);
  await popup.evaluate(`renderRecognizerCard({captionAvailability:'absent'}, 42)`);
  check(await popup.evaluate(`!document.getElementById('recogStart').disabled`), 'confirmed absent captions and health enable start');
  await popup.evaluate(`renderRecognizerCard({captionAvailability:'present'}, 42)`);
  check(await popup.evaluate(`document.getElementById('recogStart').disabled`), 'readable captions block start');
  await popup.evaluate(`renderRecognizerCard({captionAvailability:'unknown'}, 42)`);
  check(await popup.evaluate(`document.getElementById('recogStart').disabled`), 'unknown captions block start');
  await popup.evaluate(`renderRecognizerCard({captionAvailability:'absent'}, 42)`);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await popup.evaluate(`document.getElementById('savedCount').closest('details').open=true;
    document.getElementById('studyAnkiExport').scrollIntoView(); document.getElementById('studyAnkiExport').click()`);
  let file;
  for (let i = 0; i < 40; i++) {
    file = fs.readdirSync(downloads).find(f => f.endsWith('.tsv'));
    if (file) break;
    await delay(100);
  }
  check(!!file, 'Anki button downloads a real TSV file');
  const tsv = fs.readFileSync(path.join(downloads, file), 'utf8');
  report.download = path.join(downloads, file);
  check(tsv.includes('Hallo&#9;世界<br>&lt;script&gt;') && tsv.includes('?p=2&amp;t=12'),
    'download preserves text safely and Bilibili timestamp/part');
  // Real backup import event exercises the shipping study.js, without account data.
  check(await popup.evaluate(`(async()=>{
    const data={format:'yt-dual-subs-study',version:1,cards:[{...${JSON.stringify(card)},videoId:'BV1xx411c7mD#p3'}]};
    const transfer=new DataTransfer(); transfer.items.add(new File([JSON.stringify(data)],'fixture.json',{type:'application/json'}));
    const input=document.getElementById('studyImportFile');input.files=transfer.files;input.dispatchEvent(new Event('change'));
    for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,50));const saved=await chrome.storage.local.get('studyCardsV1');
      if(saved.studyCardsV1.some(c=>c.videoId==='BV1xx411c7mD#p3')) return true;}return false;
  })()`), 'Bilibili part backup imports through the real popup event');
  // Controlled video tab: use the extension's real SRT import and navigation
  // messages, rather than querying the user's logged-in pages.
  const videoTarget = await browser.send('Target.createTarget', { url: 'about:blank' });
  const videoTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  videoPage = await Cdp.attach(videoTargets.find(t => t.id === videoTarget.targetId).webSocketDebuggerUrl);
  await videoPage.send('Runtime.enable');
  await videoPage.send('Page.enable');
  await videoPage.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const wav = Buffer.alloc(44 + 8000 * 4, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__INITIAL_STATE__={videoData:{bvid:'BV1xx411c7mD',aid:12345,cid:111,pages:[{cid:111,page:1}],subtitle:{list:[]}}};
    </script></head><body><div class="bpx-player-container"><div class="bpx-player-video-wrap">
    <video muted src="data:audio/wav;base64,${wav.toString('base64')}"></video></div>
    <div class="bpx-player-control-wrap"><div class="bpx-player-control-bottom-right"></div></div></div></body></html>`;
  let fulfilling = false;
  fixtureTimer = setInterval(async () => {
    if (fulfilling) return;
    const index = videoPage.events.findIndex(e => e.method === 'Fetch.requestPaused');
    if (index < 0) return;
    fulfilling = true;
    const event = videoPage.events.splice(index, 1)[0];
    try {
      const html = event.params.resourceType === 'Document';
      await videoPage.send('Fetch.fulfillRequest', { requestId: event.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: html ? 'text/html' : 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: 'https://www.bilibili.com' },
          { name: 'Access-Control-Allow-Credentials', value: 'true' }],
        body: Buffer.from(html ? fixtureHtml : JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } })).toString('base64') });
    } finally { fulfilling = false; }
  }, 20);
  await videoPage.send('Page.navigate', { url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1' });
  await delay(600);
  const videoTabId = await worker.evaluate(`(async()=>{const tabs=await chrome.tabs.query({url:'https://www.bilibili.com/video/*'});
    return tabs[0]?.id ?? (await chrome.tabs.query({})).find(t=>t.id!==undefined && t.url?.includes('bilibili.com/video/'))?.id})()`);
  // Bilibili host access is limited to the content script; tabs.query(url) may
  // omit its URL. Resolve the actual controlled page using its CDP target ID.
  const tabId = Number.isInteger(videoTabId) ? videoTabId : await worker.evaluate(`(async()=>{
    for(const tab of await chrome.tabs.query({})){try{const s=await chrome.tabs.sendMessage(tab.id,{type:'status'});
      if(s?.platform==='bilibili')return tab.id;}catch{}} return null;})()`);
  check(Number.isInteger(tabId), 'controlled Bilibili video exposes the real content script');
  await worker.evaluate(`const nativeFetch=fetch;globalThis.fetch=(url,init)=>String(url).includes('translate.googleapis.com')
    ? Promise.resolve({ok:true,status:200,json:async()=>[[['Hallo.']]]}):nativeFetch(url,init)`);
  const srt = '1\n00:00:00,000 --> 00:00:01,000\n第一句。\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句。';
  check((await worker.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'importSrt',text:${JSON.stringify(srt)},name:'fixture.srt'})`))?.ok,
    'controlled SRT imports into the actual video tab');
  const studyTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html?studyTab=${tabId}` });
  const studyTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  studyPage = await Cdp.attach(studyTargets.find(t => t.id === studyTarget.targetId).webSocketDebuggerUrl);
  await studyPage.send('Runtime.enable'); await studyPage.send('Page.enable');
  await studyPage.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i=0;i<40;i++) {
    if (await studyPage.evaluate(`document.querySelectorAll('#transcriptList .study-item').length===2`)) break;
    await delay(100);
  }
  check(await studyPage.evaluate(`document.body.classList.contains('study-page') && document.querySelectorAll('#transcriptList .study-item').length===2`),
    'persistent study page stays bound to the video and displays its transcript');
  await studyPage.evaluate(`document.querySelector('#transcriptList .study-item-actions button').click()`);
  check((await studyPage.evaluate(`getActiveTab()`))?.id === tabId, 'sentence navigation keeps the learning page open and bound');
  // Exercise the real popup while a status reply is held back: interval ticks
  // and callers share one operation, then the next refresh can start normally.
  check(await studyPage.evaluate(`(async()=>{
    await refreshStatus();
    const original=sendToTab;
    let calls=0,release;
    const held=new Promise(resolve=>release=resolve);
    sendToTab=(id,msg)=>msg.type==='status'?(calls++,held):original(id,msg);
    try {
      const pending=Array.from({length:20},()=>refreshStatus());
      await new Promise(resolve=>setTimeout(resolve,100));
      const single=calls===1;
      release(null);await Promise.all(pending);
      await refreshStatus();
      return single&&calls===2;
    } finally {sendToTab=original;}
  })()`), '20 concurrent slow popup refreshes issue one status request and recover afterwards');
  check(await studyPage.evaluate(`(async()=>{
    await refreshStatus();
    const original=sendToTab;
    let calls=0,release;
    const held=new Promise(resolve=>release=resolve);
    sendToTab=(id,msg)=>msg.type==='status'?(calls++,held):original(id,msg);
    try {
      const pending=Array.from({length:20},()=>getPageStatus(${tabId}));
      const single=calls===1;
      release(null);await Promise.all(pending);
      await getPageStatus(${tabId});
      return single&&calls===2;
    } finally {sendToTab=original;}
  })()`), 'simultaneous popup and transcript status reads share one request without stale caching');
  // Locate the extension's isolated execution context in the controlled page.
  const contexts = videoPage.events.filter(e => e.method === 'Runtime.executionContextCreated').map(e => e.params.context);
  const isolated = contexts.find(c => c.origin === `chrome-extension://${extensionId}` || c.name === extensionId);
  check(!!isolated, 'real isolated content context is available for security checks');
  const result = await videoPage.send('Runtime.evaluate', { contextId: isolated.id, returnByValue: true, awaitPromise: true,
    expression: `(async()=>{const local=await chrome.storage.local.get('bridgeConfigV1');
      const config=await chrome.runtime.sendMessage({type:'getBridgeConfig'});
      const start=await chrome.runtime.sendMessage({type:'recogStart',tabId:${tabId}});
      const stop=await chrome.runtime.sendMessage({type:'recogStop'});
      const databases=await indexedDB.databases();
      return !local.bridgeConfigV1?.bridgeToken && !config.ok && !start.ok && !stop.ok
        && !databases.some(db=>db.name==='ytds-private');})()` });
  check(result.result?.value === true, 'video scripts cannot read private credentials or command capture');
  await studyPage.evaluate(`document.getElementById('autoPause').checked=true;document.getElementById('autoPause').dispatchEvent(new Event('change'))`);
  await delay(300);
  await videoPage.evaluate(`document.querySelector('video').currentTime=0;document.querySelector('video').play()`);
  await delay(1600);
  const playback = await videoPage.evaluate(`(()=>{const v=document.querySelector('video');return {paused:v.paused,time:v.currentTime}})()`);
  check(playback.paused && playback.time >= 1 && playback.time < 1.6, 'real media pauses at sentence end while the learning page remains open');
  const studyShot = await studyPage.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(out, 'study-page.png'), Buffer.from(studyShot.data, 'base64'));
  check(!studyPage.events.some(e => e.method === 'Runtime.exceptionThrown'), 'persistent study page has no uncaught exception');
  await worker.evaluate(`YtdsSettings.enqueue({karaoke:true,karaokeApproximate:false})`);
  await worker.evaluate(`chrome.tabs.sendMessage(${tabId},{type:'clearSrt'})`);
  await delay(200);
  const recognized = await worker.evaluate(`(()=>{
    const cue=YtdsBridge.cueFromSegment({segmentId:'fixture-recognition',original:'Hallo Welt.',german:'Hallo Welt.',
      startMs:0,endMs:2000,sourceLanguage:'de',words:[
        {text:'Hallo',startMs:0,endMs:600,probability:0.9},
        {text:'Welt.',startMs:800,endMs:1600,probability:0.9}]});
    return chrome.tabs.sendMessage(${tabId},{type:'recognizedCues',videoId:'BV1xx411c7mD#p1',sourceLang:'de',cues:[cue]});
  })()`);
  check(recognized?.ok, 'validated recognition word times reach the actual video cue pipeline');
  await videoPage.evaluate(`document.querySelector('video').currentTime=0.9`);
  await delay(200);
  const recognitionView = await videoPage.evaluate(`(()=>{
    const orig=document.querySelector('.ytds-orig');
    return {text:orig?.textContent,words:orig?.querySelectorAll('.ytds-w').length,
      label:orig?.getAttribute('data-ytds-timing-label'),
      highlighted:orig?.querySelector('.ytds-w-on')?.textContent,
      color:orig?.querySelector('.ytds-w-on') ? getComputedStyle(orig.querySelector('.ytds-w-on')).color : null};})()`);
  check(recognitionView.text==='Hallo Welt.' && recognitionView.words===2 &&
    recognitionView.label==='识别词时间', 'actual overlay labels source recognition timing and preserves the complete sentence');
  check(recognitionView.color==='rgb(255, 255, 255)', 'actual active word remains white and readable on the light highlight');
  report.recognitionView = recognitionView;
  const recognitionShot = await videoPage.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'recognition-overlay.png'), Buffer.from(recognitionShot.data, 'base64'));
  await popup.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 1000, deviceScaleFactor: 1, mobile: false });
  const clip = await popup.evaluate(`(()=>{const top=document.getElementById('bridgeToken').closest('section').getBoundingClientRect();
    const bottom=document.getElementById('savedList').closest('section').getBoundingClientRect();
    return {x:0,y:Math.max(0,top.top+scrollY),width:400,height:bottom.bottom-top.top,scale:1};})()`);
  const shot = await popup.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  fs.writeFileSync(path.join(out, 'popup.png'), Buffer.from(shot.data, 'base64'));
  check(!popup.events.some(e => e.method === 'Runtime.exceptionThrown'), 'popup has no uncaught JavaScript exception');
  report.success = true;
  report.stage = 'complete';
} catch (error) {
  report.success = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  clearInterval(fixtureTimer);
  studyPage?.close(); videoPage?.close(); popup?.close(); worker?.close();
  try { await browser?.send('Browser.close'); } catch {}
  browser?.close(); child.kill();
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
