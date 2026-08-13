/**
 * A sample AI **app**: it turns a meeting transcript into notes, locally.
 *
 * The app is the thing a person sits in front of; in the example topologies it is the peer that
 * dials the services beside it. Being on the fabric costs it the same three lines as everything
 * else — declare who you are, declare what you do, serve it.
 *
 *     node src/notes.ts     # PORT=8791 by default
 *
 * Sample data: `example:agent:notes-app` is a made-up peer, and {@link composeNotes} stands in for the
 * local model you would actually call.
 */
import { runIfMain, type LocalInferenceApp } from './wire.ts';

/** The local inference: one bullet per sentence, in the order they were said. Replace this. */
export function composeNotes(transcript: string): string {
  const sentences = transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length === 0 ? 'nothing to note' : sentences.map((s) => `- ${s}`).join('\n');
}

export const NOTES_APP: LocalInferenceApp = {
  identity: 'example:agent:notes-app',
  label: 'Notes (sample app)',
  capability: 'notes.compose',
  description: 'Turn a transcript into bulleted notes, on this machine.',
  transports: ['a2a'],
  port: 8791,
  infer: composeNotes,
};

runIfMain(import.meta.url, NOTES_APP);
