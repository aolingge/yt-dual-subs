const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function mount(initial = []) {
  let cards = structuredClone(initial), listener, fail = false;
  const realm = vm.createContext({
    extensionSender: sender => !sender.tab,
    chrome: {
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { get: async () => ({ studyCardsV1: structuredClone(cards) }),
        set: async patch => { if (fail) throw new Error('quota'); cards = structuredClone(patch.studyCardsV1); } } }
    }
  });
  for (const file of ['study-export.js', 'study-store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), realm);
  return { ask: (patch, sender = {}) => new Promise(resolve => listener({ type: 'studyCards', ...patch }, sender, resolve)),
    fail: value => { fail = value; } };
}
const card = text => ({ videoId: 'speechde001', index: 0, start: 1000, text, trans: '译文', savedAt: 1 });

test('concurrent additions/edits/removals preserve changes from other study windows', async () => {
  const h = mount();
  const results = await Promise.all(['eins', 'zwei', 'drei'].map(text => h.ask({ operation: 'save', card: card(text) })));
  const id = results[0].cards[0].id;
  await Promise.all([h.ask({ operation: 'known', id, known: true }), h.ask({ operation: 'save', card: card('vier') })]);
  let result = await h.ask({ operation: 'read' });
  assert.equal(result.cards.length, 4);
  assert.equal(result.cards.find(c => c.id === id).known, true);
  await Promise.all([h.ask({ operation: 'remove', id }), h.ask({ operation: 'import', cards: [card('fünf')] })]);
  result = await h.ask({ operation: 'read' });
  assert.equal(result.cards.length, 4);
  assert.ok(!result.cards.some(c => c.id === id));
});

test('invalid/overfull imports are atomic; failed storage writes can retry', async () => {
  const h = mount(Array.from({ length: 1000 }, (_, i) => card('word ' + i)));
  assert.equal((await h.ask({ operation: 'import', cards: [card('extra')] })).code, 'full');
  assert.equal((await h.ask({ operation: 'import', cards: [card('valid'), { ...card('bad'), start: '1000' }] })).code, 'invalid');
  assert.equal((await h.ask({ operation: 'read' })).cards.length, 1000);
  const small = mount();
  small.fail(true);
  assert.equal((await small.ask({ operation: 'save', card: card('eins') })).code, 'storage');
  small.fail(false);
  assert.equal((await small.ask({ operation: 'save', card: card('eins') })).ok, true);
  assert.equal((await small.ask({ operation: 'read' }, { tab: { id: 1 } })).code, 'forbidden');
});
