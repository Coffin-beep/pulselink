'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiplomaticTranslator, LruTtlCache, LLM_INPUT_LIMIT } = require('../lib/diplomatic-translator');

function translatorWith(response, options = {}) {
  return new DiplomaticTranslator({
    timeoutMs: options.timeoutMs || 100,
    llmCall: options.llmCall || (async () => JSON.stringify(response))
  });
}

test('toxic text is rewritten', async () => {
  const translator = translatorWith({ is_toxic: true, rewritten: 'Сударь, ваша идея удивительно смела.', style: 'polite' });
  const result = await translator.translate('Ты идиот, идея ужасная');
  assert.equal(result.isToxic, true);
  assert.equal(result.rewritten, 'Сударь, ваша идея удивительно смела.');
  assert.equal(result.style, 'polite');
  assert.equal(result.fallback, false);
});

test('neutral text remains unchanged', async () => {
  const original = 'Давайте созвонимся в пять';
  const translator = translatorWith({ is_toxic: false, rewritten: original, style: 'none' });
  const result = await translator.translate(original);
  assert.equal(result.isToxic, false);
  assert.equal(result.rewritten, original);
  assert.equal(result.style, 'none');
});

test('emergency text remains unchanged when model marks it non-toxic', async () => {
  const original = 'Срочно вызови скорую, человеку плохо';
  const translator = translatorWith({ is_toxic: false, rewritten: original, style: 'none' });
  const result = await translator.translate(original);
  assert.equal(result.isToxic, false);
  assert.equal(result.rewritten, original);
});

test('timeout gracefully falls back to original', async () => {
  const original = 'Очень злое сообщение';
  const translator = translatorWith(null, { timeoutMs: 15, llmCall: () => new Promise(() => {}) });
  const result = await translator.translate(original);
  assert.equal(result.rewritten, original);
  assert.equal(result.isToxic, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'timeout');
});

test('invalid JSON gracefully falls back to original', async () => {
  const original = 'Грубый текст';
  const translator = translatorWith(null, { llmCall: async () => 'not-json' });
  const result = await translator.translate(original);
  assert.equal(result.rewritten, original);
  assert.equal(result.isToxic, false);
  assert.equal(result.fallback, true);
});

test('empty toxic rewrite gracefully falls back to original', async () => {
  const original = 'Грубый текст';
  const translator = translatorWith({ is_toxic: true, rewritten: '   ', style: 'absurd' });
  const result = await translator.translate(original);
  assert.equal(result.rewritten, original);
  assert.equal(result.isToxic, false);
  assert.equal(result.fallback, true);
});

test('same text is served from cache without another LLM call', async () => {
  let calls = 0;
  const translator = translatorWith(null, {
    llmCall: async () => {
      calls += 1;
      return JSON.stringify({ is_toxic: true, rewritten: 'Мягкая версия', style: 'zen' });
    }
  });
  await translator.translate('Одинаковая грубость');
  const second = await translator.translate('Одинаковая грубость');
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
});

test('only first 500 characters go to LLM and untouched tail is preserved', async () => {
  const original = `${'Я'.repeat(LLM_INPUT_LIMIT)}ХВОСТ`;
  let received = '';
  const translator = translatorWith(null, {
    llmCall: async ({ text }) => {
      received = text;
      return JSON.stringify({ is_toxic: true, rewritten: 'Смягчённое начало', style: 'cute' });
    }
  });
  const result = await translator.translate(original);
  assert.equal(received.length, LLM_INPUT_LIMIT);
  assert.equal(result.rewritten, 'Смягчённое началоХВОСТ');
});

test('emoji-only messages skip LLM', async () => {
  let calls = 0;
  const translator = translatorWith(null, { llmCall: async () => { calls += 1; return '{}'; } });
  const result = await translator.translate('🎭😡');
  assert.equal(calls, 0);
  assert.equal(result.rewritten, '🎭😡');
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
