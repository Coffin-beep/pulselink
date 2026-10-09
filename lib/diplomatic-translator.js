'use strict';

const crypto = require('crypto');

const SYSTEM_PROMPT = `Ты — модуль автоматического перефразирования в мессенджере. 
Твоя задача — обрабатывать сообщение и возвращать СТРОГО JSON 
без комментариев, markdown и пояснений.

ПРАВИЛА:
1. Определи, содержит ли сообщение оскорбления, мат, угрозы 
   или явную агрессию.
2. Если НЕТ — верни оригинал без изменений.
3. Если ДА — перефразируй в забавную, абсурдную или чрезмерно 
   вежливую форму. Сохрани СМЫСЛ претензии, но убери обиду и яд.
4. Если сообщение касается экстренных ситуаций (здоровье, деньги, 
   срочная помощь, ЧП) — НЕ шути, верни как есть.
5. Не добавляй префиксы вроде "Дипломатический перевод:".

ФОРМАТ ОТВЕТА (строго JSON):
{
  "is_toxic": true/false,
  "rewritten": "перефразированный текст (или оригинал, если is_toxic=false)",
  "style": "absurd | polite | cute | zen | none"
}

СООБЩЕНИЕ:`;

const ALLOWED_STYLES = new Set(['absurd', 'polite', 'cute', 'zen', 'none']);
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_SIZE = 1000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const LLM_INPUT_LIMIT = 500;

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
    while (this.entries.size > this.maxSize) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }
}

class DiplomaticTranslator {
  constructor(options = {}) {
    this.url = options.url || process.env.DIPLOMATIC_LLM_URL || 'https://api.openai.com/v1/chat/completions';
    this.apiKey = options.apiKey ?? process.env.DIPLOMATIC_LLM_API_KEY ?? '';
    this.model = options.model || process.env.DIPLOMATIC_LLM_MODEL || 'gpt-4o-mini';
    this.timeoutMs = Number(options.timeoutMs ?? process.env.DIPLOMATIC_LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.llmCall = options.llmCall || this.callOpenAiCompatible.bind(this);
    this.configured = options.llmCall ? true : Boolean(this.url && this.apiKey && this.model);
    this.cache = options.cache || new LruTtlCache({ maxSize: DEFAULT_CACHE_SIZE, ttlMs: DEFAULT_CACHE_TTL_MS });
  }

  static shouldProcess(text) {
    return typeof text === 'string' && text.trim().length > 0 && /[\p{L}\p{N}]/u.test(text);
  }

  fallback(original, reason = 'fallback') {
    return { isToxic: false, rewritten: original, style: 'none', fallback: true, reason, cached: false };
  }

  async translate(text) {
    const original = String(text ?? '');
    if (!DiplomaticTranslator.shouldProcess(original)) return this.fallback(original, 'skipped');
    if (!this.configured) return this.fallback(original, 'not_configured');

    const hash = crypto.createHash('sha256').update(original).digest('hex');
    const cached = this.cache.get(hash);
    if (cached) return { ...cached, cached: true };

    const llmText = original.slice(0, LLM_INPUT_LIMIT);
    const untouchedTail = original.slice(LLM_INPUT_LIMIT);
    const controller = new AbortController();
    let timer;

    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Diplomatic LLM timeout'), { code: 'DIPLOMATIC_TIMEOUT' }));
        }, Math.max(1, this.timeoutMs || DEFAULT_TIMEOUT_MS));
      });
      const raw = await Promise.race([
        this.llmCall({ systemPrompt: SYSTEM_PROMPT, text: llmText, signal: controller.signal }),
        timeout
      ]);
      const parsed = JSON.parse(String(raw));
      if (typeof parsed.is_toxic !== 'boolean' || typeof parsed.rewritten !== 'string') {
        return this.fallback(original, 'invalid_schema');
      }
      const style = ALLOWED_STYLES.has(parsed.style) ? parsed.style : null;
      if (parsed.is_toxic && (!parsed.rewritten.trim() || !style || style === 'none')) {
        return this.fallback(original, 'invalid_rewrite');
      }
      const result = parsed.is_toxic
        ? { isToxic: true, rewritten: parsed.rewritten + untouchedTail, style, fallback: false, reason: null, cached: false }
        : { isToxic: false, rewritten: original, style: 'none', fallback: false, reason: null, cached: false };
      this.cache.set(hash, result);
      return result;
    } catch (error) {
      return this.fallback(original, error?.code === 'DIPLOMATIC_TIMEOUT' || error?.name === 'AbortError' ? 'timeout' : 'llm_error');
    } finally {
      clearTimeout(timer);
    }
  }

  async callOpenAiCompatible({ systemPrompt, text, signal }) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      }),
      signal
    });
    if (!response.ok) throw new Error(`Diplomatic LLM HTTP ${response.status}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Diplomatic LLM response has no content');
    return content;
  }
}

module.exports = {
  DiplomaticTranslator,
  LruTtlCache,
  SYSTEM_PROMPT,
  LLM_INPUT_LIMIT
};
