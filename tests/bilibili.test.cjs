'use strict';
// ============================================================================
// Bilibili-specific tests: the platform adapter (`site.js`), the MAIN-world
// caption reader (`bilibili-page.js`) and the contract between the two.
//
// Everything here boots the shipping files; nothing is re-implemented.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { read, bilibiliDom, mountSite, mountReader, flush } = require('./bilibili-harness.cjs');

const BILI_P1 = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1';
const BILI_P2 = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
const CDN = 'https://i0.hdslb.com/bfs/subtitle/zh-cn.json';

// Values that come out of a VM context carry that context's prototypes, which
// strict deep-equality rejects. Compare plain copies instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- fixtures --------------------------------------------------------------

const TRACK_ZH_HUMAN = {
  id_str: 'zh1', lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: CDN,
  type: 0, ai_type: 0, ai_status: 0, role: 1,
};
const TRACK_ZH_AI = {
  id_str: 'zh2', lan: 'zh-CN', lan_doc: '中文（自动生成）', subtitle_url: 'https://i0.hdslb.com/bfs/subtitle/zh-ai.json',
  type: 1, ai_type: 0, ai_status: 1, role: 0,
};
const TRACK_ZH_HANT = {
  id_str: 'zh3', lan: 'zh-Hant', lan_doc: '中文（繁體）', subtitle_url: 'https://i0.hdslb.com/bfs/subtitle/zh-hant.json',
  type: 0, ai_type: 0, ai_status: 0, role: 0,
};
const TRACK_EN = {
  id_str: 'en1', lan: 'en-US', lan_doc: 'English(US)', subtitle_url: 'https://i0.hdslb.com/bfs/subtitle/en.json',
  type: 0, ai_type: 0, ai_status: 0, role: 0,
};

function sampleState(pages = [{ cid: 111, page: 1, part: 'P1' }, { cid: 222, page: 2, part: 'P2' }], list = [TRACK_ZH_HUMAN]) {
  return {
    aid: 80433022,
    bvid: 'BV1xx411c7mD',
    videoData: {
      aid: 80433022,
      bvid: 'BV1xx411c7mD',
      pages,
      subtitle: { allow_submit: false, list },
    },
  };
}

function metaJson(tracks) {
  return JSON.stringify({ code: 0, data: { subtitle: { allow_submit: false, subtitles: tracks } } });
}

const BODY_ZH = JSON.stringify({
  body: [
    { from: 1.2, to: 3.7, location: 2, content: '今天我们来聊聊怎么学习德语。' },
    { from: 4.0, to: 6.5, location: 2, content: '先从最容易混淆的语法开始。' },
  ],
});

// Mount a reader that answers metadata and the cue body, then configure it the
// way content.js does, and hand back what it posted.
async function mounted({ tracks = [TRACK_ZH_HUMAN], body = BODY_ZH, state = sampleState(undefined, tracks), url = BILI_P1, nonce = 1, trackId = '', respond } = {}) {
  const api = mountReader({
    url,
    initialState: state,
    respond: respond || ((target) => {
      if (target.includes('/x/player/wbi/v2')) return { body: metaJson(tracks) };
      if (target.includes('subtitle')) return { body };
      return { status: 404 };
    }),
  });
  api.configure({ nonce, trackId });
  await flush(8);
  return api;
}

// ---- site.js: which platform, and how the two are kept apart ---------------

test('site.js reports the platform and what it can do', () => {
  const bili = mountSite(BILI_P1).site;
  assert.equal(bili.platform, 'bilibili');
  assert.equal(bili.isBilibili, true);
  // Bilibili has no site-supplied translation track, and its caption control
  // opens a panel instead of toggling, so we never click it.
  assert.equal(bili.supportsTlang, false);
  assert.equal(bili.autoEnableNativeCaptions, false);
  assert.equal(bili.toggleButtonClass(), 'ytds-toggle ytds-toggle-bili notranslate');

  const yt = mountSite('https://www.youtube.com/watch?v=abc123').site;
  assert.equal(yt.platform, 'youtube');
  assert.equal(yt.isBilibili, false);
  assert.equal(yt.supportsTlang, true);
  assert.equal(yt.autoEnableNativeCaptions, true);
  assert.equal(yt.toggleButtonClass(), 'ytp-button ytds-toggle notranslate');
});

test('Bilibili defaults to German on top without changing anything YouTube reads', () => {
  const bili = mountSite(BILI_P1).site;
  assert.deepEqual({ ...bili.siteDefaults() }, { enabled: true, targetLang: 'de', order: 'trans-top', bbGermanLayoutV1: false });

  // A logical Bilibili write lands on Bilibili's own storage keys...
  assert.deepEqual({ ...bili.toStore({ enabled: false, targetLang: 'de', order: 'trans-top', origSize: 22 }) },
    { bbEnabled: false, bbTargetLang: 'de', bbOrder: 'trans-top', origSize: 22 });
  // ...so the user's YouTube languages survive a Bilibili change, and vice versa.
  const stored = { targetLang: 'zh-CN', order: 'orig-top', bbTargetLang: 'de', bbOrder: 'trans-top' };
  assert.deepEqual(plain(bili.fromStore(stored)), { targetLang: 'de', order: 'trans-top' });

  // A change notification for YouTube's keys must not look like a Bilibili change.
  assert.deepEqual({ ...bili.logicalChanges({ targetLang: 'zh-CN', bbTargetLang: 'de', origSize: 24 }) },
    { targetLang: 'de', origSize: 24 });

  const yt = mountSite('https://www.youtube.com/watch?v=abc123').site;
  assert.deepEqual({ ...yt.siteDefaults() }, {});
  assert.deepEqual({ ...yt.toStore({ targetLang: 'zh-CN' }) }, { targetLang: 'zh-CN' });
  assert.deepEqual({ ...yt.logicalChanges({ targetLang: 'zh-CN' }) }, { targetLang: 'zh-CN' });
});

test('the video key is the video AND the part, so parts never share a cache', () => {
  const site = mountSite(BILI_P1).site;
  assert.equal(site.videoKey(), 'BV1xx411c7mD#p1');
  assert.equal(mountSite(BILI_P2).site.videoKey(), 'BV1xx411c7mD#p2');
  // A URL without ?p= is part 1, and a bare watch page is not a video at all.
  assert.equal(mountSite('https://www.bilibili.com/video/BV1xx411c7mD/').site.videoKey(), 'BV1xx411c7mD#p1');
  assert.equal(mountSite('https://www.bilibili.com/video/av80433022?p=3').site.videoKey(), 'av80433022#p3');
  assert.equal(mountSite('https://www.bilibili.com/').site.videoKey(), '');
});

test('Bilibili enable state is independent of YouTube, including change notifications', () => {
  const site = mountSite(BILI_P1).site;
  const yt = site.forPlatform('youtube');
  assert.deepEqual(plain(site.toStore({ enabled: false })), { bbEnabled: false });
  assert.deepEqual(plain(yt.toStore({ enabled: true })), { enabled: true });
  const saved = { enabled: false, bbEnabled: true };
  assert.equal(site.fromStore(saved).enabled, true);
  assert.equal(yt.fromStore(saved).enabled, false);
  assert.ok(!('enabled' in site.fromStore({ enabled: false })), 'old global off state does not disable Bilibili');
  assert.deepEqual(plain(site.logicalChanges({ enabled: { newValue: false } })), {});
  assert.deepEqual(plain(site.logicalChanges({ bbEnabled: { newValue: false } })), { enabled: { newValue: false } });
});

test('the old Chinese-to-Chinese layout is repaired once without rewriting YouTube', () => {
  const site = mountSite(BILI_P1).site;
  const saved = { enabled: false, targetLang: 'zh-CN', order: 'orig-top',
    bbTargetLang: 'zh-CN', bbOrder: 'orig-top' };
  const logical = site.fromStore(saved);
  const repair = site.repairSettings(logical);
  const storedPatch = site.toStore(repair);
  const repaired = { ...saved, ...storedPatch };
  assert.equal(repaired.bbTargetLang, 'de');
  assert.equal(repaired.bbOrder, 'trans-top');
  assert.equal(repaired.enabled, false);
  assert.equal(repaired.targetLang, 'zh-CN');
  assert.equal(repaired.order, 'orig-top');
  assert.deepEqual(plain(site.repairSettings(site.fromStore(repaired))), {});
  assert.deepEqual(plain(site.forPlatform('bilibili').repairSettings(logical)), plain(repair));
  assert.deepEqual(plain(site.forPlatform('youtube').repairSettings(saved)), {});
  assert.deepEqual(plain(site.repairSettings({ bbGermanLayoutV1: true, targetLang: 'en', order: 'orig-top' })), {},
    'a later deliberate preference survives');
});

test('the player toggle waits for the native right control group', () => {
  const dom = bilibiliDom();
  const site = mountSite(BILI_P1, dom).site;
  dom.controlsRight.remove();
  assert.equal(site.controlsHost(dom.player), null);
  dom.controlWrap.appendChild(dom.controlsRight);
  assert.equal(site.controlsHost(dom.player), dom.controlsRight);
});

test('the overlay attaches to the video box, not the whole player', () => {
  const dom = bilibiliDom();
  const site = mountSite(BILI_P1, dom).site;
  const player = site.getPlayer();
  assert.equal(player, dom.player);
  assert.equal(site.overlayHost(player), dom.videoWrap);
  // The toggle button goes somewhere that cannot disturb the native bar.
  assert.equal(site.controlsHost(player), dom.controlsRight);
  assert.equal(site.getVideo(), dom.video);
});

test('native caption text is read from the player container, never a guessed class', () => {
  for (const controlsHidden of [false, true]) {
    const dom = bilibiliDom({ captionText: '今天我们来聊聊\n怎么学习德语。', controlsHidden });
    const site = mountSite(BILI_P1, dom).site;
    assert.deepEqual(plain(site.nativeCaptionSegments()), ['今天我们来聊聊', '怎么学习德语。']);
  }
});

test('the caption button is located by its label and its state read from it', () => {
  const dom = bilibiliDom();
  const site = mountSite(BILI_P1, dom).site;
  assert.equal(site.captionsButton(), dom.subtitlesButton);
  assert.equal(site.captionsAvailable(dom.subtitlesButton), true);

  dom.subtitlesButton.setAttribute('aria-label', '关闭字幕');
  assert.equal(site.captionsOn(dom.subtitlesButton), true);
  dom.subtitlesButton.setAttribute('aria-label', '开启字幕');
  assert.equal(site.captionsOn(dom.subtitlesButton), false);
  // Nothing that looks like a caption control -> null, never a wrong button.
  dom.subtitlesButton.setAttribute('aria-label', '弹幕');
  assert.equal(site.captionsButton(), null);
});

test('the control bar height is measured from the real Bilibili bar', () => {
  const dom = bilibiliDom();
  dom.controlWrap.getBoundingClientRect = () => ({ top: 490, bottom: 540, height: 50, left: 0, right: 960 });
  const site = mountSite(BILI_P1, dom).site;
  const rect = { top: 0, bottom: 540, height: 540, left: 0, right: 960 };
  // bar top 490 -> 540 - 490 + 12 = 62, which beats the 8% floor of 43.2.
  assert.equal(site.playerBottomInset(dom.player, rect), 62);
});

// ---- bilibili-page.js: the cue contract ------------------------------------

test('a classic CDN cue body becomes engine cues in milliseconds', async () => {
  const api = await mounted();
  const msg = api.last('cues');
  assert.ok(msg, 'the reader must post cues');
  assert.equal(msg.videoId, 'BV1xx411c7mD#p1');
  assert.equal(msg.sourceLang, 'zh-CN');
  assert.equal(msg.trackId, 'zh1');
  // The engine's own translation queue must own the German, so the page says
  // it has no translation track and no word times of its own.
  assert.equal(msg.aligned, null);
  assert.equal(msg.tcues, null);
  assert.equal(msg.translationPending, false);
  assert.deepEqual(plain(msg.cues.map((c) => ({ start: c.start, dur: c.dur, text: c.text }))), [
    { start: 1200, dur: 2500, text: '今天我们来聊聊怎么学习德语。' },
    { start: 4000, dur: 2500, text: '先从最容易混淆的语法开始。' },
  ]);
});

test('cue bodies arrive in several shapes and all of them normalise', async () => {
  const cases = [
    ['seconds with start/end', JSON.stringify([{ start: 1.5, end: 3, text: '甲' }]), [{ start: 1500, dur: 1500, text: '甲' }]],
    ['milliseconds with tStartMs/dDurationMs', JSON.stringify({ events: [{ tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '乙' }, { utf8: '丙' }] }] }), [{ start: 2000, dur: 1500, text: '乙丙' }]],
    ['milliseconds with startTime/endTime', JSON.stringify({ subtitles: [{ startTime: 3000, endTime: 4200, content: '丁' }] }), [{ start: 3000, dur: 1200, text: '丁' }]],
    ['a bare array with from/to', JSON.stringify([{ from: 0.5, to: 1, content: '戊' }]), [{ start: 500, dur: 500, text: '戊' }]],
  ];
  for (const [name, body, expected] of cases) {
    const api = await mounted({ body });
    const msg = api.last('cues');
    assert.ok(msg, name + ': cues expected');
    assert.deepEqual(plain(msg.cues.map((c) => ({ start: c.start, dur: c.dur, text: c.text }))), expected, name);
  }
});

test('empty, duplicated and unusable cues are cleaned away, wording kept intact', async () => {
  const body = JSON.stringify({
    body: [
      { from: 1, to: 2, content: '' },
      { from: 2, to: 3, content: '  ' },
      { from: 3, to: 4, content: '第一句。' },
      { from: 3, to: 4, content: '第一句。' },
      { from: 5, to: 6, content: '第二句，带标点！' },
      { from: 'x', to: 7, content: '非法时间' },
      { from: 8, to: 9, content: '换行\n合并' },
    ],
  });
  const api = await mounted({ body });
  const cues = plain(api.last('cues').cues);
  assert.deepEqual(cues.map((c) => c.text), ['第一句。', '第二句，带标点！', '换行 合并']);
  assert.deepEqual(cues.map((c) => c.start), [3000, 5000, 8000]);
  // Sorted, one cue per caption: the engine does its own sentence grouping.
  assert.deepEqual(cues.map((c) => c.start), [...cues.map((c) => c.start)].sort((a, b) => a - b));
});

test('a human simplified track wins over Traditional and auto-generated ones', async () => {
  const api = await mounted({ tracks: [TRACK_EN, TRACK_ZH_HANT, TRACK_ZH_AI, TRACK_ZH_HUMAN] });
  assert.equal(api.last('cues').trackId, 'zh1');
  assert.equal(api.last('cues').sourceLang, 'zh-CN');

  // A human track always beats an auto-generated one — including a Traditional
  // human track, because it is still a human Chinese original.
  const ai = await mounted({ tracks: [TRACK_EN, TRACK_ZH_HANT, TRACK_ZH_AI] });
  assert.equal(ai.last('cues').trackId, 'zh3');

  // With no human Chinese track at all, the auto-generated one is next best.
  const aiOnly = await mounted({ tracks: [TRACK_EN, TRACK_ZH_AI] });
  assert.equal(aiOnly.last('cues').trackId, 'zh2');

  // Traditional Chinese is still Chinese, and beats an English-only video.
  const hant = await mounted({ tracks: [TRACK_EN, TRACK_ZH_HANT] });
  assert.equal(hant.last('cues').trackId, 'zh3');
  assert.equal(hant.last('cues').sourceLang, 'zh-Hant');

  // An English-only video is not Chinese: say so instead of translating English.
  const none = await mounted({ tracks: [TRACK_EN], state: sampleState(undefined, [TRACK_EN]) });
  assert.equal(none.last('cues'), null);
  assert.equal(none.last('nocues').reason, 'not_chinese');
});

test('a track the user picked by hand beats the automatic choice', async () => {
  const api = await mounted({
    tracks: [TRACK_ZH_HUMAN, TRACK_ZH_HANT],
    trackId: 'zh3',
  });
  assert.equal(api.last('cues').trackId, 'zh3');
  assert.equal(api.last('cues').sourceLang, 'zh-Hant');
});

test('the metadata request uses the page session, the caption CDN does not', async () => {
  const api = await mounted();
  const meta = api.requests.find((r) => r.url.includes('/x/player/wbi/v2'));
  const body = api.requests.find((r) => r.url.includes('hdslb.com'));
  assert.ok(meta, 'the reader must ask the player API itself when the page has not');
  assert.equal(meta.credentials, 'include');
  assert.ok(body, 'the cue body must be fetched from the CDN');
  assert.equal(body.credentials, 'omit');
  assert.ok(meta.url.includes('aid=80433022') && meta.url.includes('cid=111'), meta.url);
});

test('an obfuscated subtitle.bilibili.com URL is decoded to the CDN it stands for', async () => {
  // Rebuild the player's own encoding: the path is the XOR of
  // "<prefix><real path>" with "<secret>bilibili".
  const prefix = 'nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`';
  const secret = '=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`';
  const realPath = '/bfs/subtitle/abcdef123456.json';
  const xor = (value, key) => {
    let out = '';
    for (let i = 0; i < value.length; i++) out += String.fromCharCode(value.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return out;
  };
  const encoded = xor(prefix + realPath, secret + 'bilibili');
  const obfuscated = '//subtitle.bilibili.com/' + encodeURIComponent(encoded) + '?deadline=1';

  const track = { ...TRACK_ZH_HUMAN, subtitle_url: obfuscated };
  const seen = [];
  const api = mountReader({
    url: BILI_P1,
    initialState: sampleState(undefined, [track]),
    respond: (target) => {
      if (target.includes('/x/player/wbi/v2')) return { body: metaJson([track]) };
      seen.push(target);
      if (target.includes('aisubtitle')) return { body: BODY_ZH };
      return { status: 404 };
    },
  });
  api.configure();
  await flush(8);

  assert.ok(seen.some((u) => u.startsWith('//aisubtitle.hdslb.com' + realPath)), JSON.stringify(seen));
  assert.ok(!seen.some((u) => u.includes('subtitle.bilibili.com')), 'the raw obfuscated URL must never be requested');
  assert.ok(api.last('cues'), 'the decoded URL must yield cues');
});

test('protobuf track metadata is decoded like the player decodes it', async () => {
  const bytes = [];
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); return out; };
  const str = (s) => Array.from(Buffer.from(s, 'utf8'));
  const lenField = (no, payload) => [...varint((no << 3) | 2), ...varint(payload.length), ...payload];
  const intField = (no, value) => [...varint((no << 3) | 0), ...varint(value)];
  const item = [
    ...lenField(2, str('zh9')), ...lenField(3, str('zh-CN')), ...lenField(4, str('中文（中国）')),
    ...lenField(5, str(CDN)), ...intField(7, 0), ...intField(9, 0), ...intField(10, 0), ...intField(11, 1),
  ];
  bytes.push(...lenField(1, [...lenField(3, item)]));

  const api = mountReader({
    url: BILI_P1,
    initialState: sampleState(undefined, []),
    respond: (target) => {
      if (target.includes('/x/v2/subtitle/web/view')) return { buffer: new Uint8Array(bytes).buffer };
      if (target.includes('subtitle')) return { body: BODY_ZH };
      return { status: 404 };
    },
  });
  api.configure();
  await flush(4);
  assert.equal(api.last('tracks'), null, 'nothing is known before the page asks');

  // The player itself asks for its tracks; the reader observes that response.
  await api.sandbox.fetch('//api.bilibili.com/x/v2/subtitle/web/view?oid=111&pid=80433022');
  await flush(8);

  const tracks = api.last('tracks');
  assert.ok(tracks, 'the protobuf reply must yield a track list');
  assert.deepEqual(plain(tracks.tracks), [
    { lan: 'zh-CN', lanDoc: '中文（中国）', idStr: 'zh9', aiType: 0, hasUrl: true },
  ]);  assert.equal(api.last('cues').sourceLang, 'zh-CN');
  assert.equal(api.last('cues').trackId, 'zh9');
});

test('no caption track at all reports the reason instead of spinning', async () => {
  const api = await mounted({
    tracks: [],
    state: sampleState(undefined, []),
  });
  const msg = api.last('nocues');
  assert.ok(msg, 'a reason must be posted');
  assert.equal(msg.reason, 'no_track');
  assert.equal(msg.videoId, 'BV1xx411c7mD#p1');
  assert.equal(api.last('cues'), null);
});

test('tracks the page lists but the API will not hand over report need_login', async () => {
  const api = await mounted({
    tracks: [],
    state: sampleState(undefined, [TRACK_ZH_HUMAN]),
  });
  assert.equal(api.last('nocues').reason, 'need_login');
});

test('a failing caption download reports fetch_failed, never a spinner', async () => {
  const api = await mounted({
    respond: (target) => {
      if (target.includes('/x/player/wbi/v2')) return { body: metaJson([TRACK_ZH_HUMAN]) };
      return { throws: 'network down' };
    },
  });
  const msg = api.last('nocues');
  assert.equal(msg.reason, 'fetch_failed');
  assert.match(msg.detail, /network down/);
});

test('subtitle tracks on remote or non-HTTPS hosts are refused', async () => {
  const evil = { ...TRACK_ZH_HUMAN, subtitle_url: 'http://attacker.example/subtitle.json' };
  const api = await mounted({
    tracks: [evil],
    state: sampleState(undefined, [evil]),
    respond: (target) => {
      if (target.includes('/x/player/wbi/v2')) return { body: metaJson([evil]) };
      return { body: BODY_ZH };
    }
  });
  assert.equal(api.requests.some((r) => /attacker\.example/i.test(r.url)), false);
  assert.equal(api.last('cues'), null);
});

test('retries are bounded and stop on their own', async () => {
  const api = mountReader({
    url: BILI_P1,
    initialState: sampleState([{ cid: 111, page: 1, part: 'P1' }], []),
    respond: () => ({ throws: 'offline' }),
  });
  api.configure();
  await flush(4);
  // Drive every scheduled retry; the reader may only ever schedule a few.
  for (let i = 0; i < 20; i++) {
    api.runTimers();
    await flush(4);
  }
  assert.ok(api.timers.length <= 6, 'retries must be bounded, saw ' + api.timers.length);
  // Once the attempts are used up the reader must REPORT something instead of
  // leaving the overlay in a permanent loading state.
  assert.equal(api.last('nocues').reason, 'fetch_failed');
  assert.match(api.last('nocues').detail, /did not answer/);
});

test('switching part never publishes the previous part under the new key', async () => {
  const bodies = {
    '111': BODY_ZH,
    '222': JSON.stringify({ body: [{ from: 1, to: 2, content: '第二P的中文。' }] }),
  };
  const api = mountReader({
    url: BILI_P1,
    initialState: sampleState(),
    respond: (target) => {
      if (target.includes('/x/player/wbi/v2')) {
        const cid = /cid=(\d+)/.exec(target)[1];
        // Part 1's caption download never finishes before the switch.
        if (cid === '111') return { defer: true };
        return { body: metaJson([{ ...TRACK_ZH_HUMAN, subtitle_url: 'https://i0.hdslb.com/bfs/subtitle/p2.json' }]) };
      }
      if (target.includes('p2.json')) return { body: bodies['222'] };
      return { status: 404 };
    },
  });

  api.configure({ nonce: 1 });
  await flush(6);
  assert.equal(api.deferredCount(), 1, 'part 1 is waiting on its caption body');

  // The viewer switches to part 2 while part 1 is still in flight.
  api.navigate(BILI_P2);
  api.configure({ nonce: 2 });
  await flush(8);

  // Now the stale part-1 answer finally arrives.
  api.release('cid=111');
  await flush(8);

  const cues = api.posted('cues');
  assert.equal(cues.length, 1, 'only the part that is playing may publish');
  assert.equal(cues[0].videoId, 'BV1xx411c7mD#p2');
  assert.equal(cues[0].nonce, 2);
  assert.deepEqual(plain(cues[0].cues.map((c) => c.text)), ['第二P的中文。']);
});

test('the track list is published for the manual switcher', async () => {
  const api = await mounted({ tracks: [TRACK_ZH_HUMAN, TRACK_EN] });
  const msg = api.last('tracks');
  assert.ok(msg, 'the reader must publish the tracks it found');
  assert.equal(msg.videoId, 'BV1xx411c7mD#p1');
  assert.deepEqual(plain(msg.tracks), [
    { lan: 'zh-CN', lanDoc: '中文（中国）', idStr: 'zh1', aiType: 0, hasUrl: true },
    { lan: 'en-US', lanDoc: 'English(US)', idStr: 'en1', aiType: 0, hasUrl: true },
  ]);
});

test('an unsupported page reports unsupported_page', async () => {
  const api = mountReader({ url: 'https://www.bilibili.com/bangumi/play/ep123', initialState: sampleState() });
  api.configure();
  await flush(4);
  assert.equal(api.last('nocues').reason, 'unsupported_page');
});

test('stale page state from another video is never adopted', async () => {
  const state = sampleState();
  state.videoData.bvid = 'BV1OTHER0001';
  const api = mountReader({
    url: BILI_P1,
    initialState: state,
    respond: () => ({ throws: 'offline' }),
  });
  // The reader must not trust a videoData block that belongs to another video.
  assert.equal(api.last('tracks'), null);
  api.configure();
  await flush(4);
  assert.equal(api.last('cues'), null, 'captions from another video must never be published');
  // With no usable page state and no answer from the player API, the reader
  // keeps trying for a bounded while and then reports why.
  for (let i = 0; i < 20; i++) { api.runTimers(); await flush(4); }
  assert.equal(api.last('nocues').reason, 'fetch_failed');
  assert.match(api.last('nocues').detail, /did not answer/);
});

// ---- the contract content.js relies on -------------------------------------

test('the reader and the adapter agree on the video key format', () => {
  const site = mountSite(BILI_P2).site;
  assert.match(site.videoKey(), /^[^#]+#p\d+$/);
  const source = read('bilibili-page.js');
  assert.match(source, /return m\[1\] \+ "#p" \+ p;/);
});

test('content.js sends the platform, the manual track and no tlang request', () => {
  const source = read('content.js');
  assert.match(source, /platform: SITE \? SITE\.platform : "youtube"/);
  assert.match(source, /useTlang: \(SITE \? SITE\.supportsTlang : true\)/);
  assert.match(source, /trackId: manualTrackId\(\)/);
  assert.match(source, /SITE\.onNavigate\(onNav\)/);
});

test('the extension never ships a broad host permission for Bilibili', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const hosts = [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];
  assert.ok(!hosts.includes('<all_urls>'));
  assert.ok(!hosts.some((h) => h.includes('bilibili.com')), 'the page match pattern already covers it');
  const matches = manifest.content_scripts.flatMap((s) => s.matches);
  assert.ok(matches.includes('https://www.bilibili.com/video/*'));
});

// ---- the popup, which runs on neither site --------------------------------

test('the popup can ask any platform for its settings mapping', () => {
  const site = mountSite(BILI_P1).site;
  // The popup's own origin is the extension, so its local `site` object is
  // always the YouTube one; the tab decides which mapping is used.
  assert.equal(site.platform, 'bilibili');
  const forBili = site.forPlatform('bilibili');
  const forYt = site.forPlatform('youtube');
  assert.equal(forBili.isBilibili, true);
  assert.equal(forYt.isBilibili, false);
  assert.deepEqual(plain(forBili.toStore({ targetLang: 'de', order: 'trans-top' })),
    { bbTargetLang: 'de', bbOrder: 'trans-top' });
  assert.deepEqual(plain(forYt.toStore({ targetLang: 'zh-CN', order: 'orig-top' })),
    { targetLang: 'zh-CN', order: 'orig-top' });
  assert.deepEqual(plain(forBili.siteDefaults()), { enabled: true, targetLang: 'de', order: 'trans-top', bbGermanLayoutV1: false });
  assert.deepEqual(plain(forYt.siteDefaults()), {});
  // Round trip: what the popup reads back is logical again, and the other
  // site's stored key is dropped rather than leaking in.
  assert.deepEqual(
    plain(forBili.fromStore({ bbTargetLang: 'de', bbOrder: 'trans-top', targetLang: 'zh-CN', rowGap: 6 })),
    { targetLang: 'de', order: 'trans-top', rowGap: 6 });
  assert.deepEqual(plain(forBili.logicalChanges({ targetLang: { newValue: 'ja' } })), {});
  assert.deepEqual(
    plain(forBili.logicalChanges({ bbTargetLang: { newValue: 'de' } })),
    { targetLang: { newValue: 'de' } });
});

test('a tab URL decides the platform, and anything else counts as YouTube', () => {
  const site = mountSite(BILI_P1).site;
  assert.equal(site.platformOfUrl('https://www.bilibili.com/video/BV1xx411c7mD/?p=2'), 'bilibili');
  assert.equal(site.platformOfUrl('https://space.bilibili.com/1'), 'bilibili');
  assert.equal(site.platformOfUrl('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(site.platformOfUrl('chrome-extension://abcdef/popup.html'), 'youtube');
  assert.equal(site.platformOfUrl(''), 'youtube');
  assert.equal(site.platformOfUrl(undefined), 'youtube');
  assert.equal(site.isBilibiliVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD/?p=2'), true);
  assert.equal(site.isBilibiliVideoUrl('https://www.bilibili.com/video/av80433022'), true);
  assert.equal(site.isBilibiliVideoUrl('https://www.bilibili.com/'), false);
  assert.equal(site.isBilibiliVideoUrl('https://space.bilibili.com/1'), false);
  assert.equal(site.isBilibiliVideoUrl('https://www.bilibili.com/bangumi/play/ep123'), false);
  assert.equal(site.isBilibiliVideoUrl(undefined), false);
});

test('the popup reads and writes the settings of the tab it is opened over', () => {
  const source = read('popup.js');
  assert.match(source, /site = YtdsSite\.forPlatform\(await platformForTab\(tab\)\)/);
  assert.match(source, /sendToTab\(tab\.id, \{ type: "status" \}\)/);
  assert.match(source, /YtdsSettings\.set\(toStore\(patch\)\)/);
  assert.match(source, /YtdsSettings\.get\(toStore\(\{ \.\.\.DEFAULTS, \.\.\.site\.siteDefaults\(\) \}\)/);
  const stored = /const stored = fromStore\(got\);/.exec(source);
  assert.ok(stored, 'the popup must map stored keys back to logical names');
  // The popup's site adapter comes from the tab, so it can never be the
  // extension origin's own (deliberately absent) site.
  assert.ok(!/location\.hostname/.test(source), 'the popup must not guess a site from its own URL');
});

test('the popup loads the adapter and ships the Bilibili card', () => {
  const html = read('popup.html');
  const siteTag = html.indexOf('<script src="site.js"></script>');
  const settingsTag = html.indexOf('<script src="settings.js"></script>');
  assert.ok(siteTag > -1, 'popup.html must load site.js');
  assert.ok(siteTag < settingsTag, 'site.js must load before the settings model');
  for (const id of ['biliCard', 'bbTrack', 'bbStatus']) {
    assert.ok(html.includes(`id="${id}"`), `popup.html must contain #${id}`);
  }
  assert.match(html, /data-i18n="bbSection"/);
  assert.match(html, /data-i18n="bbTrackHint"/);

  const source = read('popup.js');
  assert.match(source, /function renderBiliCard\(s\)/);
  // Settings can be site-scoped, but video controls only appear on watch pages.
  assert.match(source, /const isBilibiliVideo = !!site && site\.isBilibili/);
  assert.match(source, /site\.isBilibiliVideoUrl\(activeTab && activeTab\.url\)/);
  // The track pick is bound to the video AND part, never to the language alone.
  assert.match(source, /const value = select\.value \? videoId \+ "\|" \+ select\.value : "";/);
});

test('the manual track, the Bilibili reasons and the locale files agree', () => {
  // Every reason the reader can report must have a message the popup can show.
  const reasons = ['unsupported_page', 'loading', 'need_login', 'no_track', 'not_chinese', 'fetch_failed', 'import_missing'];
  const popup = read('popup.js');
  for (const reason of reasons) {
    assert.ok(new RegExp(`\\b${reason}: "bb`).test(popup), `no popup message mapped for ${reason}`);
  }
  // And that message must exist in every shipped locale, with the same key set.
  const locales = ['en', 'zh_CN', 'zh_TW'].map((l) => JSON.parse(read(`_locales/${l}/messages.json`)));
  const sets = locales.map((o) => new Set(Object.keys(o)));
  for (const [i, name] of ['en', 'zh_CN', 'zh_TW'].entries()) {
    for (const key of sets[0]) {
      assert.ok(sets[i].has(key), `${name} is missing the message ${key}`);
    }
  }
  for (const reason of reasons) {
    const key = new RegExp(`\\b${reason}: "(bb[A-Za-z]+)"`).exec(popup)[1];
    for (const [i, name] of ['en', 'zh_CN', 'zh_TW'].entries()) {
      assert.ok(sets[i].has(key), `${name} is missing ${key}`);
    }
  }
});

test('every message the popup markup or script uses exists in the locales', () => {
  const en = new Set(Object.keys(JSON.parse(read('_locales/en/messages.json'))));
  const html = read('popup.html');
  for (const match of html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) {
    assert.ok(en.has(match[1]), `popup.html asks for the missing message ${match[1]}`);
  }
  for (const match of read('popup.js').matchAll(/\bt\("([A-Za-z][A-Za-z0-9]*)"/g)) {
    assert.ok(en.has(match[1]), `popup.js asks for the missing message ${match[1]}`);
  }
});

// ---- local subtitle import (the practical answer when no track is readable) --

test('the manifest ships the local-file parser with the display stack', () => {
  const scripts = JSON.parse(read('manifest.json')).content_scripts;
  for (const s of scripts) {
    if (s.world === 'MAIN') continue;
    assert.ok(s.js.includes('srt.js'),
      'srt.js must be available wherever content.js runs: ' + s.matches.join(' '));
    // It must be defined before content.js reads globalThis.YtdsSrt.
    assert.ok(s.js.indexOf('srt.js') < s.js.indexOf('content.js'));
  }
});

test('an imported file is bound to the video and the part, and kept locally', () => {
  const content = read('content.js');
  // chrome.storage.local, never sync: the file is large, it is the user's own
  // material, and it must not travel between machines.
  assert.match(content, /function srtArea\(\)[\s\S]{0,120}chrome\.storage\.local/);
  assert.doesNotMatch(content, /chrome\.storage\.sync[\s\S]{0,80}SRT\.storageKey/);
  // The binding key is the platform video key, which carries the part.
  assert.match(content, /function srtStorageKey\(\)[\s\S]{0,120}SRT\.storageKey\(currentVideoId\)/);
});

test('the imported file rides the same cue pipeline as a caption track', () => {
  const content = read('content.js');
  const body = content.slice(content.indexOf('function applyImportedCues()'));
  const call = body.slice(0, body.indexOf('\n  }'));
  // Same shape the reader posts, so translation, sync, styles, study tools and
  // export all keep working without a second code path.
  assert.match(call, /aligned: null/);
  assert.match(call, /tcues: null/);
  assert.match(call, /translationPending: false/);
  // The language of the file decides the dictionary lookup and the translation
  // direction, and it is the same answer on every site.
  assert.match(call, /sourceLang: importedSourceLang\(\)/);
  assert.match(call, /onCues\(data\)/);
});

test('an imported file is usable on either site and says which language it is', () => {
  const content = read('content.js');
  const start = content.indexOf('function importedSourceLang()');
  assert.ok(start > 0, 'the imported-file language helper exists');
  const body = content.slice(start, content.indexOf('\n  }', start));
  assert.match(body, /SITE\.isBilibili\) return "zh-CN"/);
  const handler = content.slice(content.indexOf('async function handleImportSrt(msg)'));
  assert.match(handler.slice(0, handler.indexOf('\n  }')), /if \(!SRT\) return \{ ok: false, reason: "unsupported" \}/);
  assert.doesNotMatch(handler.slice(0, handler.indexOf('\n  }')), /isBilibili/);
});

test('a bound file outranks the page and can be unbound', () => {
  const content = read('content.js');
  // While a file is bound the reader's cues are ignored rather than merged.
  assert.match(content, /if \(importedSrt && \(d\.type === "cues" \|\| d\.type === "nocues"\)\) return;/);
  assert.match(content, /msg\.type === "importSrt"/);
  assert.match(content, /msg\.type === "clearSrt"/);
  // Undoing the binding hands the video back to the page's own captions.
  const clear = content.slice(content.indexOf('async function handleClearSrt()'));
  assert.match(clear.slice(0, clear.indexOf('\n  }')), /teardownAll\(\);[\s\S]{0,40}applyStateToDom\(\);/);
});

test('the popup offers the file picker and the unbind entry, and reports the reason', () => {
  const html = read('popup.html');
  assert.match(html, /id="bbFile"[^>]*type="file"|type="file"[^>]*id="bbFile"/);
  assert.match(html, /id="bbImport"/);
  assert.match(html, /id="bbClear"/);
  const js = read('popup.js');
  assert.match(js, /type: "importSrt"/);
  assert.match(js, /type: "clearSrt"/);
  assert.match(js, /file\.text\(\)/);
  // The reader's reason for showing nothing is surfaced, never a permanent spinner.
  assert.match(js, /BB_REASON_KEYS/);
  assert.match(js, /bbNeedLogin/);
});

test('reading a caption track still needs the viewer, and nothing exports a cookie', () => {
  const reader = read('bilibili-page.js');
  // The page's own session is used, in the page's own world; no cookie is ever
  // read, copied or exported, and no login or access restriction is bypassed.
  assert.doesNotMatch(reader, /document\.cookie/);
  assert.doesNotMatch(reader, /chrome\.cookies/);
  assert.match(reader, /credentials/);
  // The token that makes a stale reply lose is real, not decorative.
  assert.match(reader, /evalToken/);
});
