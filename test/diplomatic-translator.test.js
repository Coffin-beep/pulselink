'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiplomaticTranslator, LruTtlCache, ANALYSIS_INPUT_LIMIT } = require('../lib/diplomatic-translator');

test('toxic insult is rewritten locally', async () => {
  const translator = new DiplomaticTranslator();
  const original = 'Ты идиот, идея ужасная';
  const result = await translator.translate(original);
  assert.equal(result.isToxic, true);
  assert.notEqual(result.rewritten, original);
  assert.match(result.rewritten, /виртуоз спорных решений/u);
  assert.ok(['absurd', 'polite', 'cute', 'zen'].includes(result.style));
});

test('neutral text remains unchanged', async () => {
  const translator = new DiplomaticTranslator();
  const original = 'Я тебя жду, давайте созвонимся в пять';
  const result = await translator.translate(original);
  assert.equal(result.isToxic, false);
  assert.equal(result.rewritten, original);
  assert.equal(result.style, 'none');
});

test('emergency text remains unchanged even when it contains aggression', async () => {
  const translator = new DiplomaticTranslator();
  const original = 'Срочно вызови скорую, идиот, человеку плохо';
  const result = await translator.translate(original);
  assert.equal(result.isToxic, false);
  assert.equal(result.rewritten, original);
  assert.equal(result.reason, 'emergency');
});

test('threat is converted into a safe request', async () => {
  const translator = new DiplomaticTranslator();
  const original = 'Я тебя найду и ударю!';
  const result = await translator.translate(original);
  assert.equal(result.isToxic, true);
  assert.doesNotMatch(result.rewritten, /найду|ударю/iu);
  assert.match(result.rewritten, /спокойно обсудить/iu);
});

test('explicit profanity is softened without an external service', async () => {
  const translator = new DiplomaticTranslator();
  const result = await translator.translate('Это дерьмо, переделывай!');
  assert.equal(result.isToxic, true);
  assert.doesNotMatch(result.rewritten, /дерьм/iu);
  assert.match(result.rewritten, /космического хаоса/iu);
});

test('same text is served from cache', async () => {
  const translator = new DiplomaticTranslator();
  await translator.translate('Ты опять всё ужасно сделал');
  const second = await translator.translate('Ты опять всё ужасно сделал');
  assert.equal(second.cached, true);
  assert.equal(second.isToxic, true);
});

test('only first 500 characters are rewritten and untouched tail is preserved', async () => {
  const original = `${'Ты ужасно сделал. '.repeat(40).slice(0, ANALYSIS_INPUT_LIMIT)}ХВОСТ-БЕЗ-ИЗМЕНЕНИЙ`;
  const translator = new DiplomaticTranslator();
  const result = await translator.translate(original);
  assert.equal(result.isToxic, true);
  assert.ok(result.rewritten.endsWith('ХВОСТ-БЕЗ-ИЗМЕНЕНИЙ'));
});

test('emoji-only messages skip analysis', async () => {
  const translator = new DiplomaticTranslator();
  const result = await translator.translate('🎭😡');
  assert.equal(result.isToxic, false);
  assert.equal(result.rewritten, '🎭😡');
  assert.equal(result.reason, 'skipped');
});

test('aggressive uppercase with repeated exclamation marks is softened', async () => {
  const translator = new DiplomaticTranslator();
  const result = await translator.translate('ПЕРЕДЕЛЫВАЙ ЭТО НЕМЕДЛЕННО!!!');
  assert.equal(result.isToxic, true);
  assert.notEqual(result.rewritten, 'ПЕРЕДЕЛЫВАЙ ЭТО НЕМЕДЛЕННО!!!');
});

test('LRU cache expires entries after one hour and caps size', () => {
  let clock = 0;
  const cache = new LruTtlCache({ maxSize: 2, ttlMs: 60 * 60 * 1000, now: () => clock });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  clock = 60 * 60 * 1000 + 1;
  assert.equal(cache.get('a'), undefined);
});
