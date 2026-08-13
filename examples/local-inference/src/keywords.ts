/**
 * A sample **service**: it pulls the terms a piece of text is about, locally.
 *
 * A service is a peer with no face — something an app dials for one job. It publishes exactly
 * what the app does (an AgentCard carrying its KCB manifest) and answers over A2A.
 *
 *     node src/keywords.ts     # PORT=8792 by default
 *
 * Sample data: `example:agent:keywords` is a made-up peer, and {@link extractKeywords} stands
 * in for the local model you would actually call.
 */
import { runIfMain, type LocalInferenceApp } from './wire.ts';

/** Words too common to be what anything is *about*. A real model would not need the list. */
const STOPWORDS = new Set(
  'a an and are as at be but by for from has have in is it its of on or that the this to was were will with we you'.split(
    ' ',
  ),
);

/** The local inference: the five most frequent terms that are not stopwords. Replace this. */
export function extractKeywords(text: string): string {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.length === 0 ? 'no keywords' : ranked.slice(0, 5).map(([word]) => word).join(', ');
}

export const KEYWORDS_SERVICE: LocalInferenceApp = {
  identity: 'example:agent:keywords',
  label: 'Keywords (sample service)',
  capability: 'extract.keywords',
  description: 'Pull the terms a piece of text is about, on this machine.',
  transports: ['a2a'],
  port: 8792,
  infer: extractKeywords,
};

runIfMain(import.meta.url, KEYWORDS_SERVICE);
