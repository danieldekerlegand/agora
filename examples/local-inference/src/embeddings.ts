/**
 * A sample **service on both transports**: it turns text into a vector, locally.
 *
 * An app that speaks A2A and a tool-caller that speaks MCP can both use it, so it publishes both
 * endpoints and answers on both. It also answers with a shape that is not prose — the manifest
 * says so (`shape: 'vector'`), which is how a peer knows what it is getting before it dials.
 *
 *     node src/embeddings.ts     # PORT=8794 by default
 *
 * Sample data: `example:agent:embeddings` is a made-up peer, and {@link embedText} stands in
 * for the local embedding model you would actually call.
 */
import { runIfMain, type LocalInferenceApp } from './wire.ts';

/** How many dimensions this stand-in "model" produces. A real one has hundreds. */
export const DIMENSIONS = 8;

/** The local inference: a deterministic hashed bag-of-words vector, unit-scaled. Replace this. */
export function embedText(text: string): string {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
    const slot = hash % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return JSON.stringify(vector.map((value) => Number((value / magnitude).toFixed(4))));
}

export const EMBEDDINGS_SERVICE: LocalInferenceApp = {
  identity: 'example:agent:embeddings',
  label: 'Embeddings (sample service)',
  capability: 'embed.text',
  description: 'Turn text into a vector, on this machine.',
  transports: ['a2a', 'mcp'],
  port: 8794,
  shape: 'vector',
  infer: embedText,
};

runIfMain(import.meta.url, EMBEDDINGS_SERVICE);
