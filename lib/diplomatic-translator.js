'use strict';

const crypto = require('crypto');

const DEFAULT_CACHE_SIZE = 1000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const ANALYSIS_INPUT_LIMIT = 500;
const STYLES = ['absurd', 'polite', 'cute', 'zen'];

const WORD_TAIL = '[\\p{L}-]*';
const LEFT_EDGE = '(?<![\\p{L}\\p{N}_])';
const RIGHT_EDGE = '(?![\\p{L}\\p{N}_])';
const bounded = (source, flags = 'iu') => new RegExp(`${LEFT_EDGE}(?:${source})${RIGHT_EDGE}`, flags);
const EMERGENCY_PATTERN = bounded(`срочно|экстренн${WORD_TAIL}|чп|пожар${WORD_TAIL}|скор(?:ая|ую)|врач${WORD_TAIL}|больниц${WORD_TAIL}|помогите|помощ${WORD_TAIL}|умира${WORD_TAIL}|кровотеч${WORD_TAIL}|задыха${WORD_TAIL}|авари${WORD_TAIL}|полици${WORD_TAIL}|спасател${WORD_TAIL}|деньг${WORD_TAIL}|банк${WORD_TAIL}|карт(?:а|у|ы)\\s+(?:украл${WORD_TAIL}|заблокир${WORD_TAIL})|перевод${WORD_TAIL}`);
const TOXIC_PATTERNS = [
  bounded(`(?:идиот|дебил|кретин|тупиц|придур|урод|мерзав|ничтожест|бездар|дурак|твар|сволоч)${WORD_TAIL}`),
  bounded(`(?:бл(?:я|е|ё)|сука|х(?:у|y)[йяеёию]|пизд|еб|ёб|мудак|говн|дерьм)${WORD_TAIL}`),
  bounded(`заткнись|сдохни|пош[её]л${WORD_TAIL}|проваливай|ненавижу`),
  bounded('убью|прибью|ударю|сломаю|уничтожу|зарежу|пожалеешь|найду\\s+тебя'),
  new RegExp(`${LEFT_EDGE}(?:ты|вы)${RIGHT_EDGE}.{0,60}${LEFT_EDGE}(?:ужасн|отвратительн|кошмарн|никч[её]мн)${WORD_TAIL}${RIGHT_EDGE}`, 'iu'),
  new RegExp(`${LEFT_EDGE}(?:ужасн|отвратительн|кошмарн|никч[её]мн)${WORD_TAIL}${RIGHT_EDGE}.{0,60}${LEFT_EDGE}(?:ты|вы)${RIGHT_EDGE}`, 'iu')
];

const REPLACEMENTS = [
  [bounded(`(?:идиот|дебил|кретин|тупиц|придур|дурак)${WORD_TAIL}`, 'giu'), 'виртуоз спорных решений'],
  [bounded(`(?:урод|мерзав|ничтожест|бездар|твар|сволоч)${WORD_TAIL}`, 'giu'), 'необычайно колючий собеседник'],
  [bounded(`(?:бл(?:я|е|ё)|сука|х(?:у|y)[йяеёию]|пизд|еб|ёб|мудак|говн|дерьм)${WORD_TAIL}`, 'giu'), 'феномен космического хаоса'],
  [bounded('заткнись', 'giu'), 'давайте возьмём паузу в этом монологе'],
  [bounded(`сдохни|пош[её]л${WORD_TAIL}|проваливай`, 'giu'), 'предлагаю отправиться на прогулку за спокойствием'],
  [bounded('ненавижу', 'giu'), 'испытываю внушительное несогласие с'],
  [bounded('убью|прибью|ударю|сломаю|уничтожу|зарежу|пожалеешь|найду(?:\\s+тебя)?', 'giu'), 'очень настойчиво прошу остановиться и всё спокойно обсудить'],
  [bounded(`ужасн${WORD_TAIL}`, 'giu'), 'поразительно неудачно'],
  [bounded(`отвратительн${WORD_TAIL}`, 'giu'), 'крайне сомнительно'],
  [bounded(`(?:кошмарн|никч[её]мн)${WORD_TAIL}`, 'giu'), 'достойно внепланового совещания с печеньем']
];

class LruTtlCache {
  constructor({ maxSize = DEFAULT_CACHE_SIZE, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now } = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxSize) this.entries.delete(this.entries.keys().next().value);
  }
}

function hasAggressiveCaps(text) {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  return letters.length >= 8 && letters.every((char) => char === char.toUpperCase()) && /!{2,}/u.test(text);
}

function normalizePunctuation(text) {
  return text.trim().replace(/!{2,}/g, '!').replace(/\?{3,}/g, '?!');
}

function rewriteLocally(text, style) {
  let softened = normalizePunctuation(text);
  for (const [pattern, replacement] of REPLACEMENTS) softened = softened.replace(pattern, replacement);
  softened = softened.replace(/\s{2,}/g, ' ').trim();
  const withoutFinalStop = softened.replace(/[.!?…]+$/u, '');
  if (style === 'polite') return `Позвольте выразить это предельно вежливо: ${withoutFinalStop}.`;
  if (style === 'cute') return `Без колючек, но по существу: ${withoutFinalStop}. Чайная пауза прилагается 🫖`;
  if (style === 'zen') return `Вдохнём, выдохнем и спокойно отметим: ${withoutFinalStop}.`;
  return `Офисный кактус созвал внеплановое совещание: ${withoutFinalStop}.`;
}

class DiplomaticTranslator {
  constructor(options = {}) {
    this.cache = options.cache || new LruTtlCache({ maxSize: DEFAULT_CACHE_SIZE, ttlMs: DEFAULT_CACHE_TTL_MS });
  }

  static shouldProcess(text) {
    return typeof text === 'string' && text.trim().length > 0 && /[\p{L}\p{N}]/u.test(text);
  }

  async translate(text) {
    const original = String(text ?? '');
    if (!DiplomaticTranslator.shouldProcess(original)) {
      return { isToxic: false, rewritten: original, style: 'none', fallback: false, reason: 'skipped', cached: false };
    }

    const hash = crypto.createHash('sha256').update(original).digest('hex');
    const cached = this.cache.get(hash);
    if (cached) return { ...cached, cached: true };

    const analyzedText = original.slice(0, ANALYSIS_INPUT_LIMIT);
    const untouchedTail = original.slice(ANALYSIS_INPUT_LIMIT);
    const isEmergency = EMERGENCY_PATTERN.test(analyzedText);
    const isToxic = !isEmergency && (TOXIC_PATTERNS.some((pattern) => pattern.test(analyzedText)) || hasAggressiveCaps(analyzedText));
    const style = isToxic ? STYLES[parseInt(hash.slice(0, 8), 16) % STYLES.length] : 'none';
    const result = {
      isToxic,
      rewritten: isToxic ? rewriteLocally(analyzedText, style) + untouchedTail : original,
      style,
      fallback: false,
      reason: isEmergency ? 'emergency' : null,
      cached: false
    };
    this.cache.set(hash, result);
    return result;
  }
}

module.exports = {
  DiplomaticTranslator,
  LruTtlCache,
  ANALYSIS_INPUT_LIMIT,
  rewriteLocally
};
