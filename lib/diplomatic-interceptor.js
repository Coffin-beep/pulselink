'use strict';

const { DiplomaticTranslator } = require('./diplomatic-translator');

async function processOutgoingText({ sender, chat, text, translator, logger = console }) {
  const original = String(text ?? '');
  if (!sender?.settings?.diplomaticFilter || !DiplomaticTranslator.shouldProcess(original)) {
    return { text: original, isDiplomaticRewrite: false, rewriteStyle: null };
  }

  const startedAt = Date.now();
  const result = await translator.translate(original);
  const latencyMs = Date.now() - startedAt;
  const style = result.isToxic ? result.style : 'none';
  logger.log(`[DiplomaticFilter] sender_id=${sender.id} chat_id=${chat.id} is_toxic=${result.isToxic} style=${style} latency_ms=${latencyMs}`);
  if (result.fallback && result.reason !== 'skipped') {
    logger.warn(`[DiplomaticFilter] fallback sender_id=${sender.id} chat_id=${chat.id} reason=${result.reason}`);
  }

  return {
    text: result.rewritten,
    isDiplomaticRewrite: result.isToxic,
    rewriteStyle: result.isToxic ? result.style : null
  };
}

module.exports = { processOutgoingText };
