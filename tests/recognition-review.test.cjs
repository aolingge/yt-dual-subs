const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

const original = { id: 'clip-0', epoch: 0, start: 0, end: 2000, dur: 2000,
  text: 'Wrong words', rawOriginal: 'Wrong words', sourceLang: 'en', uncertain: true,
  wordTimingSource: 'recognition', words: [], trans: '' };

test('local pending transcripts keep native absent gate and never request cloud translation', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'absent');
  assert.equal(page.request({ type: 'recognizedCues', videoId: page.status().videoId, cues: [original], sourceLang: 'en' }).ok, true);
  page.at(0.5);
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'absent');
  assert.equal(page.requests.filter(r => r.message.type === 'translate').length, 0);
  const entry = page.request({ type: 'studyCues' }).entries[0];
  assert.equal(entry.id, original.id);
  assert.equal(entry.uncertain, true);
});

test('non-German display targets translate the bridge intermediate without replacing the original', async () => {
  const page = await mountContent({ skipCues: true, settings: { targetLang: 'zh-CN' } });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  const cue = { ...original, id: 'clip-zh', text: 'Hello', rawOriginal: 'Hello',
    trans: 'Guten Tag', sourceLang: 'en' };
  assert.equal(page.request({ type: 'recognizedCues', videoId, cues: [cue], sourceLang: 'en' }).ok, true);
  const request = page.requests.find((entry) => entry.message.type === 'translate');
  assert.ok(request, 'the German bridge line is sent for the selected display target');
  assert.equal(request.message.sourceLang, 'de');
  page.request({ type: 'studyCorrect', videoId, index: 0, expectedStart: 0, id: 'clip-zh', epoch: 0,
    text: '人工原文', trans: '人工译文' });
  page.respond(page.requests.indexOf(request), { ok: true, translated: '迟到译文' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.request({ type: 'studyCues' }).entries[0].trans, '人工译文');
});

test('manual correction survives late recognition revisions and retains raw text', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognizedCues', videoId, cues: [original], sourceLang: 'en' });
  const patch = { type: 'studyCorrect', videoId, index: 0, expectedStart: 0, id: 'clip-0', epoch: 0,
    text: 'Correct words.', trans: 'Richtige Wörter.' };
  assert.equal(page.request(patch).ok, true);
  page.request({ type: 'recognizedCues', videoId, cues: [{ ...original, text: 'Late revision', revision: 3 }], sourceLang: 'en' });
  page.at(0.5);
  const entry = page.request({ type: 'studyCues' }).entries[0];
  assert.equal(entry.text, 'Correct words.');
  assert.equal(entry.trans, 'Richtige Wörter.');
  assert.equal(entry.rawOriginal, 'Wrong words');
  assert.equal(entry.corrected, true);
  assert.equal(page.request({ ...patch, videoId: 'other' }).ok, false);
  assert.equal(page.request({ ...patch, epoch: 1 }).ok, false);
});

test('study status revision changes when recognized text changes', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognizedCues', videoId, cues: [original], sourceLang: 'en' });
  const firstRevision = page.status().contentRevision;
  page.request({ type: 'recognizedCues', videoId,
    cues: [{ ...original, text: 'Updated words', rawOriginal: 'Updated words', revision: 2 }], sourceLang: 'en' });
  assert.ok(page.status().contentRevision > firstRevision);
  assert.equal(page.request({ type: 'studyCues' }).entries[0].text, 'Updated words');
});

test('clearing a correction exposes a pending retry state and raw text', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognizedCues', videoId, cues: [original], sourceLang: 'en' });
  page.request({ type: 'studyCorrect', videoId, index: 0, expectedStart: 0, id: 'clip-0', epoch: 0,
    text: 'Correct words.', trans: 'Richtige Wörter.' });
  assert.equal(page.request({ type: 'studyClearCorrection', videoId, index: 0,
    expectedStart: 0, id: 'clip-0', epoch: 0 }).ok, true);
  const entry = page.request({ type: 'studyCues' }).entries[0];
  assert.equal(entry.recognitionState, 'pending');
  assert.equal(entry.text, original.rawOriginal);
  assert.equal(entry.corrected, false);
});

test('native captions appearing after recognition block subsequent retries', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  page.request({ type: 'recognizedCues', videoId: page.status().videoId, cues: [original], sourceLang: 'en' });
  page.sendCues({ cues: [{ start: 0, dur: 2000, text: 'Native caption.' }], aligned: true });
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'present');
});

test('empty authoritative retry clears recognized list and preserves absent gate', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognizedCues', videoId, cues: [original] });
  page.at(0.5);
  assert.equal(page.request({ type: 'recognizedCues', videoId, cues: [] }).ok, true);
  assert.equal(page.request({ type: 'studyCues' }).reason, 'nocue');
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'absent');
});

test('new native track blocks late recognition even before track text loads', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognizedCues', videoId, cues: [original] });
  page.changeSettings({ bbTracks: JSON.stringify([{ id: 'native', lang: 'de' }]) });
  assert.equal(page.request({ type: 'recognizedCues', videoId, cues: [original] }).reason, 'captions_present');
});

test('non-Chinese native captions cannot authorize recognition', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'not_chinese' });
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'unknown');
});

test('repeated native no-track notices retain recognized subtitles and corrections', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognizedCues', videoId, cues: [original] });
  page.request({ type: 'studyCorrect', videoId, index: 0, expectedStart: 0, id: 'clip-0', epoch: 0,
    text: 'Correct words.', trans: 'Richtige Wörter.' });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  assert.equal(page.request({ type: 'studyCues' }).entries?.[0]?.text, 'Correct words.');
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'absent');
});

test('unknown native-caption status stops recognition and rejects late updates', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  const videoId = page.status().videoId;
  page.request({ type: 'recognitionState', state: 'running' });
  page.request({ type: 'recognizedCues', videoId, cues: [original] });
  page.sendInject({ type: 'nocues', reason: 'fetch_failed' });
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'unknown');
  assert.ok(page.requests.some(request => request.message.type === 'recognitionAbandoned'));
  assert.equal(page.request({ type: 'recognizedCues', videoId, cues: [original] }).ok, false);
});

test('unknown caption status stops a starting session before its first cue arrives', async () => {
  const page = await mountContent({ skipCues: true });
  page.sendInject({ type: 'nocues', reason: 'no_track' });
  page.request({ type: 'recognitionState', state: 'starting' });
  page.sendInject({ type: 'nocues', reason: 'loading' });
  assert.ok(page.requests.some(request => request.message.type === 'recognitionAbandoned'));
  assert.equal(page.request({ type: 'recognitionContext' }).context.captionAvailability, 'unknown');
});
