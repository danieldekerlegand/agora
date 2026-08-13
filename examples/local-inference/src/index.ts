/**
 * `@agora/example-local-inference` — thin example participants, as a module.
 *
 * The examples are meant to be *read and run* (`node src/notes.ts`), not imported; this surface
 * exists so the tests here — and the topology runner beside them (`topologies.ts`) — can start
 * the same processes in one line. It depends on the published `@agora/sdk` and nothing else in this repo, and nothing
 * in this repo depends on it: examples consume the SDK, the SDK never consumes an example.
 */
export { closeApps, EXAMPLE_APPS, exampleApp, startApps } from './apps.ts';
export {
  EXAMPLE_TOPOLOGIES,
  exampleTopology,
  SAMPLE_NOTE,
  STUDIO_CONFIG_FORMAT,
  studioConfigOf,
  urlsOf,
  type ExampleOutsider,
  type ExampleTopology,
  type StudioConfig,
  type StudioConfigConnection,
  type StudioConfigParticipant,
} from './topologies.ts';
export { composeNotes, NOTES_APP } from './notes.ts';
export { extractKeywords, KEYWORDS_SERVICE } from './keywords.ts';
export { classifySentiment, SENTIMENT_SERVICE } from './sentiment.ts';
export { DIMENSIONS, EMBEDDINGS_SERVICE, embedText } from './embeddings.ts';
export {
  a2aAnswer,
  appCard,
  appManifest,
  A2A_PATH,
  CARD_PATH,
  MANIFEST_PATH,
  MCP_PATH,
  MCP_PROTOCOL_VERSION,
  mcpAnswer,
  runIfMain,
  startApp,
  toolDescriptor,
  type ExampleTransport,
  type LocalInferenceApp,
  type StartedApp,
} from './wire.ts';
