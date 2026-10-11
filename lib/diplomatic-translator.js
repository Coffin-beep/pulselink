'use strict';

const crypto = require('crypto');

const DEFAULT_CACHE_SIZE = 1000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const ANALYSIS_INPUT_LIMIT = 500;
const STYLES = ['absurd', 'cute', 'polite'];
const WORD_TAIL = '[\\p{L}-]*';
const LEFT_EDGE = '(?<![\\p{L}\\p{N}_])';
const RIGHT_EDGE = '(?![\\p{L}\\p{N}_])';
const bounded = (source, flags = 'iu') => new RegExp(`${LEFT_EDGE}(?:${source})${RIGHT_EDGE}`, flags);

const EMERGENCY_PATTERN = bounded(`срочно|экстренн${WORD_TAIL}|чп|пожар${WORD_TAIL}|скор(?:ая|ую)|врач${WORD_TAIL}|больниц${WORD_TAIL}|помогите|помощ${WORD_TAIL}|умира${WORD_TAIL}|кровотеч${WORD_TAIL}|задыха${WORD_TAIL}|авари${WORD_TAIL}|полици${WORD_TAIL}|спасател${WORD_TAIL}|деньг${WORD_TAIL}|банк${WORD_TAIL}|карт(?:а|у|ы)\\s+(?:украл${WORD_TAIL}|заблокир${WORD_TAIL})|перевод${WORD_TAIL}`);

const INSULT_SOURCE = `(?:идиот|дебил|кретин|тупиц|тупорыл|тупоголов|туп(?:ой|ая|ое|ые|ого|ому|ым|ую|ых)|придур|дурак|долбо[её]б|долба[её]б|имбецил|олигофрен|дегенерат|даун|безмозгл|рукожоп|урод|мерзав|ничтожест|бездар|бесполезн|жалк|мраз|падл|гнид|ублюд|вырод|засран|говнюк|мудак|мудач|чмо|лох|коз[её]л|скотин|свинь|шавк|крыс|петух|балбес|остолоп|дубин|тормоз|клоун|неадекват|баран|ос[её]л|обезьян|психопат|кончен|шлюх|отсто|дрян|idiot|moron|stupid|dumb|loser|asshole)${WORD_TAIL}`;
const PROFANITY_SOURCE = `(?:бл(?:я|е|ё)|сука|суч|х(?:у|y)[йяеёию]|нах(?:у|y)[йяеёию]|пизд|[её]б|(?:за|на|по|про|вы|до|от|пере)[её]б|мудак|говн|дерьм|жоп|хрен|фигн|охуел|охренел|fuck|shit|bitch)${WORD_TAIL}`;
const DISMISSAL_SOURCE = `заткнись|завались|сдохни|умри|пош[её]л${WORD_TAIL}|проваливай|отвали|вали\\s+отсюда|катись${WORD_TAIL}|закрой\\s+(?:рот|варежку)|ненавижу|ничего\\s+не\\s+умеешь|мозгов\\s+нет|руки\\s+из\\s+жопы`;
const THREAT_SOURCE = `убью|прибью|ударю|сломаю|уничтожу|зарежу|размажу|покалечу|задушу|пожалеешь|найду\\s+тебя|тебе\\s+конец`;
const BAD_WORK_SOURCE = `ужасн${WORD_TAIL}|отвратительн${WORD_TAIL}|кошмарн${WORD_TAIL}|никч[её]мн${WORD_TAIL}|убог${WORD_TAIL}|мерзк${WORD_TAIL}`;

const CATEGORY_PATTERNS = {
  threat: bounded(THREAT_SOURCE),
  dismissal: bounded(DISMISSAL_SOURCE),
  profanity: bounded(PROFANITY_SOURCE),
  insult: bounded(INSULT_SOURCE),
  complaint: new RegExp(`${LEFT_EDGE}(?:ты|вы)${RIGHT_EDGE}.{0,70}${LEFT_EDGE}(?:${BAD_WORK_SOURCE})${RIGHT_EDGE}|${LEFT_EDGE}(?:${BAD_WORK_SOURCE})${RIGHT_EDGE}.{0,70}${LEFT_EDGE}(?:ты|вы)${RIGHT_EDGE}`, 'iu')
};

const REPLACEMENTS = [
  [/я\s+тебя\s+найду(?:\s+и\s+(?:ударю|прибью|уничтожу|покалечу))?/giu, 'предлагаю устроить дуэль мягкими подушками и затем спокойно всё обсудить'],
  [bounded(`${THREAT_SOURCE}|найду`, 'giu'), 'предлагаю устроить дуэль мягкими подушками и затем спокойно всё обсудить'],
  [bounded(DISMISSAL_SOURCE, 'giu'), 'предлагаю торжественно удалиться в закат на офисном стуле'],
  [bounded(PROFANITY_SOURCE, 'giu'), 'трёхэтажный бутерброд с хаосом'],
  [bounded(INSULT_SOURCE, 'giu'), 'почётный чемпион по спорным решениям'],
  [bounded(`ужасн${WORD_TAIL}`, 'giu'), 'так, что даже офисный кактус написал жалобу'],
  [bounded(`отвратительн${WORD_TAIL}|мерзк${WORD_TAIL}`, 'giu'), 'настолько сомнительно, что пингвин-аудитор снял очки'],
  [bounded(`кошмарн${WORD_TAIL}|никч[её]мн${WORD_TAIL}|убог${WORD_TAIL}`, 'giu'), 'достойно экстренного совета хомяков']
];

const FUNNY_WRAPPERS = [
  (text) => `Срочный выпуск новостей от говорящего кактуса: ${text}.`,
  (text) => `Хомяк дипломатии поправил галстук и передаёт: ${text}. 🐹`,
  (text) => `Даже пингвин-аудитор слегка поперхнулся чаем: ${text}.`,
  (text) => `Перевод с языка разгневанного дракона: ${text}. Дракон уже получил печенье.`,
  (text) => `Комитет серьёзных капибар постановил: ${text}.`,
  (text) => `Без запуска табуреток в космос сообщаю: ${text}.`
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

function canonicalize(text) {
  return String(text)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[0@]/g, (char) => char === '0' ? 'о' : 'а')
    .replace(/\$/g, 'с');
}

function hasObfuscatedInsult(text) {
  const compact = canonicalize(text).replace(/[^\p{L}\p{N}]/gu, '');
  return ['идиот', 'дебил', 'мудак', 'долбоеб', 'придурок', 'сука', 'урод', 'тупой', 'лох', 'чмо'].some((word) => compact.includes(word));
}

function hasAggressiveCaps(text) {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  return letters.length >= 8 && letters.every((char) => char === char.toUpperCase()) && /!{2,}/u.test(text);
}

function detectToxicity(text) {
  const normalized = canonicalize(text);
  for (const category of ['threat', 'dismissal', 'profanity', 'insult', 'complaint']) {
    if (CATEGORY_PATTERNS[category].test(normalized)) return category;
  }
  if (hasObfuscatedInsult(normalized)) return 'insult';
  if (hasAggressiveCaps(text)) return 'aggression';
  return null;
}

function normalizePunctuation(text) {
  return text.trim().replace(/!{2,}/g, '!').replace(/\?{3,}/g, '?!');
}

function rewriteLocally(text, hash) {
  let softened = normalizePunctuation(text);
  for (const [pattern, replacement] of REPLACEMENTS) softened = softened.replace(pattern, replacement);
  const threatRewrite = 'предлагаю устроить дуэль мягкими подушками и затем спокойно всё обсудить';
  softened = softened.replace(`${threatRewrite} и ${threatRewrite}`, threatRewrite);
  if (hasObfuscatedInsult(softened)) softened = 'это решение вызывает у меня вопросы размером с дирижабль';
  softened = softened.replace(/\s{2,}/g, ' ').replace(/[.!?…]+$/u, '').trim();
  if (!softened) softened = 'ситуация получилась настолько удивительной, что у калькулятора задрожали кнопки';
  const wrapper = FUNNY_WRAPPERS[parseInt(hash.slice(8, 16), 16) % FUNNY_WRAPPERS.length];
  return wrapper(softened);
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
    const isEmergency = EMERGENCY_PATTERN.test(canonicalize(analyzedText));
    const category = isEmergency ? null : detectToxicity(analyzedText);
    const isToxic = Boolean(category);
    const style = isToxic ? STYLES[parseInt(hash.slice(0, 8), 16) % STYLES.length] : 'none';
    const result = {
      isToxic,
      rewritten: isToxic ? rewriteLocally(analyzedText, hash) + untouchedTail : original,
      style,
      category,
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
  detectToxicity,
  rewriteLocally
};
