const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('known subtitle language is used for short-sentence translation and cache identity', async () => {
  const listeners = {};
  const urls = [];
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listeners.message = fn; } } },
    commands: { onCommand: { addListener() {} } }
  };
  const fetch = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => [[['你好。']]] };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), {
    chrome, fetch, Map
  });
  const request = (sourceLang) => new Promise((resolve) => {
    listeners.message({ type: 'translate', text: 'Hallo.',
      targetLang: 'zh-CN', sourceLang }, {}, resolve);
  });
  assert.equal((await request('de')).translated, '你好。');
  assert.equal(new URL(urls[0]).searchParams.get('sl'), 'de');
  await request('de');
  assert.equal(urls.length, 1);
  await request(undefined);
  assert.equal(new URL(urls[1]).searchParams.get('sl'), 'auto');
});
