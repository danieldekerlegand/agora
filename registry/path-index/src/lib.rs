//! Indexed capability-path search — the Rust engine behind `@agora/registry`'s
//! `CapabilityRegistry.path()` (KCB §3 "Composition").
//!
//! This crate is a faithful port of `registry/src/path.ts` + `ports.ts` + `cost.ts`. The single
//! entry point [`search`] mirrors `findCapabilityPath`: given the registry's registrations and a
//! [`PathQuery`], it returns the best [`CapabilityPath`] from a start port to a goal port, or
//! `None`. Search is best-first on the KCB §3 ranking — priced routes before unpriced, then
//! cheapest projected units, then fewest hops — and a capability appears at most once per path.
//!
//! ADR-0001 decision 3 (route-by-lookup, never proxy) is a property of the *types* here: the
//! engine sees only manifest / port / cost data and returns addresses + capability names. There
//! is no payload, transport, or `invoke` anywhere in this crate; a [`CapabilityPath`] is a plan
//! the caller then dials directly, never a route through the registry.
//!
//! US-2 replaced the per-pop full edge rescan with a plane-typed [`EdgeIndex`]: expanding a partial
//! path enumerates feed-compatible edges by bucket lookup instead of scanning every edge. US-3
//! replaced the linear `take_best` frontier scan with a [`BinaryHeap`] of [`FrontierEntry`]: each
//! partial path carries its unpriced-hop count and projected units incrementally, so popping the
//! best route is O(log n) and the KCB §3 ranking never re-derives `.filter(…).count()` /
//! `.reduce(…)` on a comparison. The golden parity harness pins behaviour byte-for-byte across
//! every refactor.

use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};
use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

#[cfg(feature = "binding")]
mod binding;

/// Default 4 — long chains are a smell, not a feature (`path.ts` DEFAULT_MAX_HOPS).
const DEFAULT_MAX_HOPS: i64 = 4;

// --- Wire types (deserialized from the registry's registrations) ---------------------------

/// A KCB port: a plane-typed connection point (`schemas` `Port`). Wire keys are snake_case,
/// exactly as the manifest publishes them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "plane", rename_all = "lowercase")]
pub enum Port {
    Knowledge {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dialect: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worlds: Option<Vec<String>>,
    },
    Media {
        media_types: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        world_pattern: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<String>,
    },
    Entity {
        types: Vec<String>,
    },
}

impl Port {
    fn plane_name(&self) -> &'static str {
        match self {
            Port::Knowledge { .. } => "knowledge",
            Port::Media { .. } => "media",
            Port::Entity { .. } => "entity",
        }
    }

    /// The payload shape a port names, if its plane has one (`ports.ts` shapeOf).
    fn shape_of(&self) -> Option<&str> {
        match self {
            Port::Knowledge { shape, .. } | Port::Media { shape, .. } => shape.as_deref(),
            Port::Entity { .. } => None,
        }
    }
}

/// What a capability costs to invoke (`schemas` `CapabilityCost`). Only the fields the ranking
/// reads are modelled; the rest of the block survives being ignored.
#[derive(Debug, Clone, Deserialize)]
struct Cost {
    est_units: f64,
    #[serde(default)]
    unpriced: Option<bool>,
}

/// A named, invocable unit (`schemas` `Capability`).
#[derive(Debug, Clone, Deserialize)]
struct Capability {
    name: String,
    #[serde(default)]
    inputs: Vec<Port>,
    #[serde(default)]
    outputs: Vec<Port>,
    #[serde(default)]
    cost: Option<Cost>,
    #[serde(default)]
    endpoint: Option<String>,
}

/// Only the capabilities are needed to build the graph — the registration carries identity and
/// address separately, and unknown manifest fields survive deserialization.
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    #[serde(default)]
    capabilities: Vec<Capability>,
}

/// Where to dial a provider (`@agora/kcb-client` `ProviderAddress`). A BTreeMap keeps the
/// endpoint set order-stable; the registry owns this address and the engine never re-derives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderAddress {
    pub identity: String,
    pub endpoints: BTreeMap<String, String>,
}

/// One indexed provider (`registry.ts` `Registration`). `source`/`sequence` are ignored — search
/// consumes registrations in the order given, which is `list()`'s registration order.
#[derive(Debug, Clone, Deserialize)]
pub struct Registration {
    identity: String,
    manifest: Manifest,
    address: ProviderAddress,
}

/// What a caller is looking for (`ports.ts` `PortQuery`). Every stated field must hold; an empty
/// query matches every port. Keys are camelCase — this is a TS-internal type, not a wire port.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortQuery {
    #[serde(default)]
    plane: Option<String>,
    #[serde(default)]
    shape: Option<String>,
    #[serde(default)]
    dialect: Option<String>,
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    world: Option<String>,
    #[serde(default)]
    entity_type: Option<String>,
}

/// From a start port to a goal port, across providers (`path.ts` `PathQuery`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathQuery {
    from: PortQuery,
    to: PortQuery,
    #[serde(default)]
    max_hops: Option<i64>,
}

// --- Result types (serialized back to the TS shim, byte-compatible with path.ts) -----------

/// One hop: who to dial, what to invoke, and what it costs (`path.ts` `PathStep`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStep {
    pub identity: String,
    pub capability: String,
    pub address: ProviderAddress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub input: Port,
    pub output: Port,
    pub est_units: f64,
    pub unpriced: bool,
}

/// An ordered plan of addresses to dial, with its projected cost (`path.ts` `CapabilityPath`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityPath {
    pub steps: Vec<PathStep>,
    pub projected_units: f64,
    pub unpriced: bool,
}

// --- Cost (cost.ts) ------------------------------------------------------------------------

/// What a capability costs, read defensively: absent price ≠ free (`cost.ts` costOf). A
/// capability with no cost block is `{units: 0, unpriced: true}`.
fn cost_of(capability: &Capability) -> (f64, bool) {
    match &capability.cost {
        None => (0.0, true),
        Some(cost) => (cost.est_units, cost.unpriced.unwrap_or(false)),
    }
}

// --- Port matching (ports.ts) --------------------------------------------------------------

/// True when `port` answers `query` (`ports.ts` matchesPort).
fn matches_port(port: &Port, query: &PortQuery) -> bool {
    if let Some(plane) = &query.plane {
        if port.plane_name() != plane {
            return false;
        }
    }
    if let Some(shape) = &query.shape {
        if port.shape_of() != Some(shape.as_str()) {
            return false;
        }
    }
    if let Some(dialect) = &query.dialect {
        match port {
            Port::Knowledge { dialect: Some(d), .. } if d == dialect => {}
            _ => return false,
        }
    }
    if let Some(media_type) = &query.media_type {
        match port {
            Port::Media { media_types, .. } => {
                if !media_types.iter().any(|declared| media_types_overlap(declared, media_type)) {
                    return false;
                }
            }
            _ => return false,
        }
    }
    if let Some(world) = &query.world {
        if !serves_world(port, world) {
            return false;
        }
    }
    if let Some(entity_type) = &query.entity_type {
        match port {
            Port::Entity { types } if types.iter().any(|t| t == entity_type) => {}
            _ => return false,
        }
    }
    true
}

/// True when a port serves a concrete world (`ports.ts` servesWorld). A media port with no
/// `world_pattern` makes no claim about worlds, so it does not answer a world-scoped query.
fn serves_world(port: &Port, world: &str) -> bool {
    match port {
        Port::Media { world_pattern, .. } => world_matches(world_pattern.as_deref(), world),
        Port::Knowledge { worlds, .. } => {
            worlds.as_ref().is_some_and(|w| w.iter().any(|x| x == world))
        }
        Port::Entity { .. } => false,
    }
}

/// Glob match with `*` as the only wildcard, as `world_pattern` uses (`ports.ts` worldMatches).
fn world_matches(pattern: Option<&str>, world: &str) -> bool {
    match pattern {
        None => false,
        Some(pattern) => glob_match(pattern, world),
    }
}

/// True when `produced` can feed `consumed` — the path-search edge test (`ports.ts` satisfies).
/// Asymmetric: the consumer states requirements, the producer must meet the ones it states.
fn satisfies(produced: &Port, consumed: &Port) -> bool {
    match (produced, consumed) {
        (
            Port::Knowledge { shape: pshape, dialect: pdialect, .. },
            Port::Knowledge { shape: cshape, dialect: cdialect, .. },
        ) => {
            if cshape.is_some() && cshape != pshape {
                return false;
            }
            if cdialect.is_some() && cdialect != pdialect {
                return false;
            }
            true
        }
        (
            Port::Media { media_types: produced_types, .. },
            Port::Media { media_types: wanted_types, .. },
        ) => {
            let overlap = wanted_types.iter().any(|wanted| {
                produced_types.iter().any(|declared| media_types_overlap(declared, wanted))
            });
            overlap && worlds_overlap(produced, consumed)
        }
        (Port::Entity { types: produced_types }, Port::Entity { types: wanted_types }) => {
            wanted_types.iter().any(|t| produced_types.contains(t))
        }
        _ => false,
    }
}

/// Media types overlap if either side's glob covers the other (`audio/*` vs `audio/wav`).
fn media_types_overlap(a: &str, b: &str) -> bool {
    glob_match(a, b) || glob_match(b, a)
}

/// World scoping only constrains a hop when *both* ends declare it: a producer that says nothing
/// about worlds is unscoped material, not material from the wrong world (`ports.ts` worldsOverlap).
fn worlds_overlap(produced: &Port, consumed: &Port) -> bool {
    let from = match produced {
        Port::Media { world_pattern, .. } => world_pattern.as_deref(),
        _ => None,
    };
    let to = match consumed {
        Port::Media { world_pattern, .. } => world_pattern.as_deref(),
        _ => None,
    };
    match (from, to) {
        (None, _) | (_, None) => true,
        (Some(from), Some(to)) => glob_match(from, to) || glob_match(to, from),
    }
}

/// Glob match with `*` as the only wildcard (the escaping `ports.ts` globToRegExp performs leaves
/// every other regex metacharacter literal, so this is a plain `*`-only matcher, anchored).
fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ti < text.len() {
        if pi < pattern.len() && pattern[pi] == text[ti] {
            pi += 1;
            ti += 1;
        } else if pi < pattern.len() && pattern[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == '*' {
        pi += 1;
    }
    pi == pattern.len()
}

// --- Address projection (kcb-client) -------------------------------------------------------

/// Where to dial one capability (`@agora/kcb-client` endpointFor): its own `endpoint`, else the
/// provider's preferred transport (`mcp`, then `a2a`). The engine reads the address the registry
/// holds; it never invents one.
fn endpoint_for(address: &ProviderAddress, capability_endpoint: Option<&str>) -> Option<String> {
    if let Some(endpoint) = capability_endpoint {
        return Some(endpoint.to_string());
    }
    if let Some(endpoint) = address.endpoints.get("mcp") {
        return Some(endpoint.clone());
    }
    address.endpoints.get("a2a").cloned()
}

// --- Edge index (US-2) ---------------------------------------------------------------------

/// The plane-typed edge index behind the search. Every (capability, input, output) triple is an
/// edge (`edges_of`, faithful to `path.ts` edgesOf + step); edges are additionally bucketed by
/// their *consumed* (input) port so expanding a partial path enumerates feed-compatible edges by
/// lookup, replacing the TypeScript's `for (const edge of edges)` rescan over every edge per pop.
///
/// Bucketing is by plane first — the cheap discriminant `satisfies` requires to match — then
/// refined *losslessly* within the two planes whose edge test is by-equality: knowledge by
/// `(shape, dialect)` and entity by each declared type. The media plane stays plane-scoped: its
/// test is a bidirectional glob over `media_types` **and** `world_pattern` (`audio/*` vs
/// `audio/wav`, `*` worlds), which a hash bucket cannot narrow without dropping a true match, so
/// media candidates are the whole media bucket, each still filtered by `satisfies`.
///
/// Candidate lists are returned in global edge order, so the frontier is built in exactly the
/// order the linear rescan produced — the first-`Less`-wins tie-break in `take_best`/`compare_paths`
/// stays byte-identical, which the golden parity harness pins.
struct EdgeIndex {
    edges: Vec<PathStep>,
    /// Entity input type → edge indices declaring it (an edge with N types appears in N buckets).
    entity_by_type: HashMap<String, Vec<usize>>,
    /// Knowledge input `(shape, dialect)` → edge indices (each edge in exactly one bucket).
    knowledge_by_shape_dialect: HashMap<(Option<String>, Option<String>), Vec<usize>>,
    /// Media input edge indices, in global order — globs defeat finer bucketing.
    media: Vec<usize>,
}

impl EdgeIndex {
    /// Build the index once per search from the registry's registrations.
    fn build(registrations: &[Registration]) -> Self {
        let edges = edges_of(registrations);
        let mut entity_by_type: HashMap<String, Vec<usize>> = HashMap::new();
        let mut knowledge_by_shape_dialect: HashMap<(Option<String>, Option<String>), Vec<usize>> =
            HashMap::new();
        let mut media: Vec<usize> = Vec::new();
        for (i, edge) in edges.iter().enumerate() {
            match &edge.input {
                Port::Entity { types } => {
                    for t in types {
                        entity_by_type.entry(t.clone()).or_default().push(i);
                    }
                }
                Port::Knowledge { shape, dialect, .. } => {
                    knowledge_by_shape_dialect
                        .entry((shape.clone(), dialect.clone()))
                        .or_default()
                        .push(i);
                }
                Port::Media { .. } => media.push(i),
            }
        }
        Self { edges, entity_by_type, knowledge_by_shape_dialect, media }
    }

    /// Edge indices whose consumed input `produced` could feed, in global edge order. A superset
    /// filter for media (the caller still applies `satisfies`); exact for knowledge and entity.
    fn candidates(&self, produced: &Port) -> Vec<usize> {
        match produced {
            Port::Entity { types } => {
                // satisfies: some consumer-wanted type is in `types` ⟺ the edge sits in a bucket
                // keyed by one of `types`. An edge can list several, so dedupe after gathering.
                let mut out: Vec<usize> = types
                    .iter()
                    .filter_map(|t| self.entity_by_type.get(t))
                    .flatten()
                    .copied()
                    .collect();
                out.sort_unstable();
                out.dedup();
                out
            }
            Port::Knowledge { shape, dialect, .. } => {
                // satisfies: consumer shape/dialect must each be unset or equal to the producer's,
                // so only these ≤4 buckets can match. Each edge is in one bucket — no dedupe needed.
                let mut shapes: Vec<Option<String>> = vec![None];
                if shape.is_some() {
                    shapes.push(shape.clone());
                }
                let mut dialects: Vec<Option<String>> = vec![None];
                if dialect.is_some() {
                    dialects.push(dialect.clone());
                }
                let mut out: Vec<usize> = Vec::new();
                for s in &shapes {
                    for d in &dialects {
                        if let Some(bucket) = self.knowledge_by_shape_dialect.get(&(s.clone(), d.clone())) {
                            out.extend_from_slice(bucket);
                        }
                    }
                }
                out.sort_unstable();
                out
            }
            Port::Media { .. } => self.media.clone(),
        }
    }
}

// --- Search (path.ts) ----------------------------------------------------------------------

/// The best path from `query.from` to `query.to`, or `None` if the index has none.
///
/// Best-first on the KCB §3 ranking (see [`FrontierEntry`]): the first goal-matching partial path
/// popped from the [`BinaryHeap`] frontier is returned. Mirrors `findCapabilityPath` exactly — the
/// heap replaces `takeBest`'s O(n) full-frontier scan with an O(log n) pop, and an insertion
/// sequence breaks ties so the earliest-inserted of equal-ranked paths wins, exactly as the linear
/// scan's first-`Less`-wins did.
pub fn search(registrations: &[Registration], query: &PathQuery) -> Option<CapabilityPath> {
    let max_hops = query.max_hops.unwrap_or(DEFAULT_MAX_HOPS);
    if max_hops < 1 {
        return None;
    }
    let index = EdgeIndex::build(registrations);

    let mut frontier: BinaryHeap<FrontierEntry> = BinaryHeap::new();
    let mut seq: u64 = 0;
    for edge in &index.edges {
        if matches_port(&edge.input, &query.from) {
            frontier.push(FrontierEntry::single(edge.clone(), seq));
            seq += 1;
        }
    }

    while let Some(best) = frontier.pop() {
        let last_output = match best.path.steps.last() {
            Some(step) => step.output.clone(),
            None => continue,
        };
        if matches_port(&last_output, &query.to) {
            return Some(best.path);
        }
        if best.path.steps.len() >= max_hops as usize {
            continue;
        }
        let used: HashSet<String> = best
            .path
            .steps
            .iter()
            .map(|s| format!("{} {}", s.identity, s.capability))
            .collect();
        for &i in &index.candidates(&last_output) {
            let edge = &index.edges[i];
            if used.contains(&format!("{} {}", edge.identity, edge.capability)) {
                continue;
            }
            if !satisfies(&last_output, &edge.input) {
                continue;
            }
            frontier.push(best.extended(edge.clone(), seq));
            seq += 1;
        }
    }
    None
}

/// Every (capability, input, output) triple, pre-projected into a [`PathStep`] — the graph's
/// edges (`path.ts` edgesOf + step).
fn edges_of(registrations: &[Registration]) -> Vec<PathStep> {
    let mut edges = Vec::new();
    for registration in registrations {
        for capability in &registration.manifest.capabilities {
            let (units, unpriced) = cost_of(capability);
            let endpoint = endpoint_for(&registration.address, capability.endpoint.as_deref());
            for input in &capability.inputs {
                for output in &capability.outputs {
                    edges.push(PathStep {
                        identity: registration.identity.clone(),
                        capability: capability.name.clone(),
                        address: registration.address.clone(),
                        endpoint: endpoint.clone(),
                        input: input.clone(),
                        output: output.clone(),
                        est_units: units,
                        unpriced,
                    });
                }
            }
        }
    }
    edges
}

// --- Retired baseline for the crossover benchmark (US-5) ------------------------------------

/// The retired O(n)-per-pop frontier, kept **only** as the crossover benchmark's baseline
/// (`benches/crossover.rs`) — never used in production, where [`search`] is the sole live engine.
///
/// A faithful port of the pre-US-2/US-3 `findCapabilityPath` (`registry/src/path.ts`): a `Vec`
/// frontier scanned linearly by [`take_best`], a full edge rescan on every pop, and
/// [`compare_paths`] recomputing the unpriced-hop count and projected units on each comparison
/// (`.filter(…).count()` / `.map().sum()`). It returns byte-identical results to [`search`] — a
/// unit test pins that on every golden fixture — so the benchmark times two equivalent searches
/// and isolates exactly what the US-2 edge index and US-3 heap frontier bought.
pub fn search_linear(
    registrations: &[Registration],
    query: &PathQuery,
) -> Option<CapabilityPath> {
    let max_hops = query.max_hops.unwrap_or(DEFAULT_MAX_HOPS);
    if max_hops < 1 {
        return None;
    }
    let edges = edges_of(registrations);

    let mut frontier: Vec<CapabilityPath> = Vec::new();
    for edge in &edges {
        if matches_port(&edge.input, &query.from) {
            frontier.push(path_of(vec![edge.clone()]));
        }
    }

    while !frontier.is_empty() {
        let best = take_best(&mut frontier);
        let last_output = match best.steps.last() {
            Some(step) => step.output.clone(),
            None => continue,
        };
        if matches_port(&last_output, &query.to) {
            return Some(best);
        }
        if best.steps.len() >= max_hops as usize {
            continue;
        }
        let used: HashSet<String> = best
            .steps
            .iter()
            .map(|s| format!("{} {}", s.identity, s.capability))
            .collect();
        // The O(edges) rescan the index replaced: every edge, every pop.
        for edge in &edges {
            if used.contains(&format!("{} {}", edge.identity, edge.capability)) {
                continue;
            }
            if !satisfies(&last_output, &edge.input) {
                continue;
            }
            let mut steps = best.steps.clone();
            steps.push(edge.clone());
            frontier.push(path_of(steps));
        }
    }
    None
}

/// A `CapabilityPath` with its projected units and unpriced flag recomputed from the steps
/// (`path.ts` pathOf) — the per-extension recompute the incremental [`FrontierEntry`] avoids.
fn path_of(steps: Vec<PathStep>) -> CapabilityPath {
    let projected_units = steps.iter().map(|s| s.est_units).sum();
    let unpriced = steps.iter().any(|s| s.unpriced);
    CapabilityPath { steps, projected_units, unpriced }
}

/// Pop the most preferred partial path by a linear scan (`path.ts` takeBest): first-`Less`-wins, so
/// the earliest-inserted of equal-ranked paths is kept — the O(n)-per-pop scan the heap replaced.
fn take_best(frontier: &mut Vec<CapabilityPath>) -> CapabilityPath {
    let mut best_at = 0usize;
    for i in 1..frontier.len() {
        if compare_paths(&frontier[i], &frontier[best_at]) == Ordering::Less {
            best_at = i;
        }
    }
    frontier.remove(best_at)
}

/// `comparePaths` (`path.ts`) recomputed on every comparison: unpriced-hop count, then projected
/// units, then hop count. Projected-unit equality/`NaN` falls through to hops, as the original did.
fn compare_paths(a: &CapabilityPath, b: &CapabilityPath) -> Ordering {
    let unpriced_a = a.steps.iter().filter(|s| s.unpriced).count();
    let unpriced_b = b.steps.iter().filter(|s| s.unpriced).count();
    unpriced_a
        .cmp(&unpriced_b)
        .then_with(|| {
            a.projected_units
                .partial_cmp(&b.projected_units)
                .unwrap_or(Ordering::Equal)
        })
        .then_with(|| a.steps.len().cmp(&b.steps.len()))
}

// --- Frontier priority queue (US-3) --------------------------------------------------------

/// A partial path on the frontier, wrapped so a [`BinaryHeap`] pops the most preferred route
/// first — the KCB §3 ranking `comparePaths` (`path.ts`) encodes: fewest unpriced hops, then
/// cheapest projected units, then fewest hops. Two fields are carried *incrementally* rather than
/// recomputed on every comparison the way `comparePaths` did with `.filter(…).length` /
/// `.reduce(…)`:
///
/// - `unpriced_count` — the count of unpriced hops, bumped as each hop is appended;
/// - `path.projected_units` — the running unit total, summed once per extension.
///
/// `seq` is the insertion order. It is the final tie-breaker so the heap pops the *earliest*
/// inserted of two equal-ranked paths — reproducing the linear `take_best`'s first-`Less`-wins
/// behaviour, which the golden parity harness pins. A `BinaryHeap` is otherwise unordered among
/// equal elements, so without `seq` two ties could swap and diverge from the retired TS path.
struct FrontierEntry {
    /// Count of unpriced hops — the primary ranking key, carried forward, never recomputed.
    unpriced_count: usize,
    /// Insertion order; the final tie-breaker after the `comparePaths` keys.
    seq: u64,
    path: CapabilityPath,
}

impl FrontierEntry {
    /// A one-hop partial path from a start edge.
    fn single(step: PathStep, seq: u64) -> Self {
        Self {
            unpriced_count: usize::from(step.unpriced),
            seq,
            path: CapabilityPath {
                projected_units: step.est_units,
                unpriced: step.unpriced,
                steps: vec![step],
            },
        }
    }

    /// This path with one more hop, carrying the ranking fields forward incrementally.
    fn extended(&self, step: PathStep, seq: u64) -> Self {
        let unpriced_count = self.unpriced_count + usize::from(step.unpriced);
        let projected_units = self.path.projected_units + step.est_units;
        let unpriced = self.path.unpriced || step.unpriced;
        let mut steps = self.path.steps.clone();
        steps.push(step);
        Self { unpriced_count, seq, path: CapabilityPath { steps, projected_units, unpriced } }
    }

    /// The KCB §3 preference order (`comparePaths`): `Less` = more preferred. Fewest unpriced hops,
    /// then cheapest projected units, then fewest hops, then earliest inserted. Projected-unit
    /// equality/`NaN` falls through to hop count exactly as `comparePaths` does.
    fn preference(&self, other: &Self) -> Ordering {
        self.unpriced_count
            .cmp(&other.unpriced_count)
            .then_with(|| {
                self.path
                    .projected_units
                    .partial_cmp(&other.path.projected_units)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| self.path.steps.len().cmp(&other.path.steps.len()))
            .then_with(|| self.seq.cmp(&other.seq))
    }
}

impl PartialEq for FrontierEntry {
    fn eq(&self, other: &Self) -> bool {
        self.seq == other.seq
    }
}
impl Eq for FrontierEntry {}
impl PartialOrd for FrontierEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for FrontierEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap is a max-heap; reverse `preference` so the most preferred (`Less`) sits on top.
        other.preference(self)
    }
}

#[cfg(test)]
mod tests;
