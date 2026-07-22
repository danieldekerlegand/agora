import { describeRegistry } from '@agora/registry';
import { describeResolver } from '@agora/resolver';
import { SPEC_VERSIONS } from '@agora/schemas';

/**
 * Console skeleton. The scenario runner — which discovers providers via the registry and
 * opens the same DIRECT A2A/MCP links production uses (ADR-0001 decision 7) — lands in
 * US-AG5. This shell proves the area builds, renders, and can see the other areas.
 */
export function App() {
  const registry = describeRegistry();
  const resolver = describeResolver();

  return (
    <main>
      <h1>agora — conformance console</h1>
      <p>
        An observer on real connections, not a hub. Scenarios open direct A2A/MCP links to
        providers discovered through the registry.
      </p>
      <dl>
        <dt>KCB</dt>
        <dd>{SPEC_VERSIONS.kcb}</dd>
        <dt>KINP</dt>
        <dd>{SPEC_VERSIONS.kinp}</dd>
        <dt>registry</dt>
        <dd>{registry.identity}</dd>
        <dt>resolver</dt>
        <dd>{resolver.identity}</dd>
      </dl>
    </main>
  );
}
