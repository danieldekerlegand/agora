/**
 * The example cast, as a list — **sample data, not a roster**.
 *
 * Nothing in agora holds a cast (`../../../CLAUDE.md`: capability, never caller). These four are
 * made-up peers that exist so a newcomer has something running to look at: an app and three
 * services, between them covering both transports and a non-text output shape. They are named
 * `example:` for exactly that reason, and anything that reads this list is reading a sample.
 */
import { EMBEDDINGS_SERVICE } from './embeddings.ts';
import { KEYWORDS_SERVICE } from './keywords.ts';
import { NOTES_APP } from './notes.ts';
import { SENTIMENT_SERVICE } from './sentiment.ts';
import { startApp, type LocalInferenceApp, type StartedApp } from './wire.ts';

/** Every thin example participant in this directory, in the order a reader should meet them. */
export const EXAMPLE_APPS: readonly LocalInferenceApp[] = Object.freeze([
  NOTES_APP,
  KEYWORDS_SERVICE,
  SENTIMENT_SERVICE,
  EMBEDDINGS_SERVICE,
]);

/** The one with this KINP identity, or `undefined` — the examples are looked up, never guessed. */
export function exampleApp(identity: string): LocalInferenceApp | undefined {
  return EXAMPLE_APPS.find((app) => app.identity === identity);
}

/**
 * Start several examples at once, each on its own port, and get one closer back.
 *
 * Port `0` for every app (the tests' case) binds them all ephemerally; the default binds each
 * app's own port, which is how the cast runs on a laptop.
 */
export async function startApps(
  apps: readonly LocalInferenceApp[] = EXAMPLE_APPS,
  port?: number,
): Promise<StartedApp[]> {
  const started: StartedApp[] = [];
  for (const app of apps) started.push(await startApp(app, port ?? app.port));
  return started;
}

/** Stop everything {@link startApps} started, whatever happened to any one of them. */
export async function closeApps(started: readonly StartedApp[]): Promise<void> {
  await Promise.all(started.map((one) => one.close()));
}
