/**
 * A sample **service on MCP**: it calls text positive, negative or neutral, locally.
 *
 * Same participant, different transport. It publishes an `mcp` endpoint instead of an `a2a` one
 * and serves the KCB §4 tool call — one tool, named after the capability, which is what a peer
 * that only read the manifest already knows to ask for.
 *
 *     node src/sentiment.ts     # PORT=8793 by default
 *
 * Sample data: `example:agent:sentiment` is a made-up peer, and {@link classifySentiment}
 * stands in for the local model you would actually call.
 */
import { runIfMain, type LocalInferenceApp } from './wire.ts';

/** A toy lexicon, standing in for a classifier's weights. */
const LEXICON: Record<string, number> = {
  good: 1, great: 1, works: 1, clear: 1, fast: 1, love: 1, green: 1, agreed: 1,
  bad: -1, broken: -1, slow: -1, unclear: -1, blocked: -1, fails: -1, regression: -1, red: -1,
};

/** The local inference: sum the lexicon over the words, report the sign. Replace this. */
export function classifySentiment(text: string): string {
  let score = 0;
  for (const word of text.toLowerCase().match(/[\p{L}']+/gu) ?? []) score += LEXICON[word] ?? 0;
  const label = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return `${label} (score ${score})`;
}

export const SENTIMENT_SERVICE: LocalInferenceApp = {
  identity: 'example:agent:sentiment',
  label: 'Sentiment (sample service)',
  capability: 'classify.sentiment',
  description: 'Call text positive, negative or neutral, on this machine.',
  transports: ['mcp'],
  port: 8793,
  infer: classifySentiment,
};

runIfMain(import.meta.url, SENTIMENT_SERVICE);
