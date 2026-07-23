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
//! This US-1 port is deliberately naive — a linear frontier scan (`take_best`) and a full edge
//! rescan per pop, exactly like the TypeScript it replaces. US-2 adds the plane-typed edge index
//! and US-3 the heap-based frontier; the golden parity harness pins behaviour byte-for-byte
//! across every refactor.

use std::collections::{BTreeMap, HashSet};
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
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStep {
    pub identity: String,
    pub capability: String,
    pub address: ProviderAddress,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub input: Port,
    pub output: Port,
    pub est_units: f64,
    pub unpriced: bool,
}

/// An ordered plan of addresses to dial, with its projected cost (`path.ts` `CapabilityPath`).
#[derive(Debug, Clone, PartialEq, Serialize)]
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

// --- Search (path.ts) ----------------------------------------------------------------------

/// The best path from `query.from` to `query.to`, or `None` if the index has none.
///
/// Best-first on `compare_paths`: the first goal-matching partial path popped from the frontier is
/// returned. Mirrors `findCapabilityPath` exactly.
pub fn search(registrations: &[Registration], query: &PathQuery) -> Option<CapabilityPath> {
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
        let last = match best.steps.last() {
            Some(step) => step.clone(),
            None => continue,
        };
        if matches_port(&last.output, &query.to) {
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
        for edge in &edges {
            if used.contains(&format!("{} {}", edge.identity, edge.capability)) {
                continue;
            }
            if !satisfies(&last.output, &edge.input) {
                continue;
            }
            let mut steps = best.steps.clone();
            steps.push(edge.clone());
            frontier.push(path_of(steps));
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

fn path_of(steps: Vec<PathStep>) -> CapabilityPath {
    let projected_units = steps.iter().map(|s| s.est_units).sum();
    let unpriced = steps.iter().any(|s| s.unpriced);
    CapabilityPath { steps, projected_units, unpriced }
}

/// Pop the most preferred partial path: priced first, then cheapest, then shortest (`path.ts`
/// takeBest). Linear scan — US-3 replaces this with a heap.
fn take_best(frontier: &mut Vec<CapabilityPath>) -> CapabilityPath {
    let mut best_at = 0;
    for i in 1..frontier.len() {
        if compare_paths(&frontier[i], &frontier[best_at]) == Ordering::Less {
            best_at = i;
        }
    }
    frontier.remove(best_at)
}

/// The KCB §3 ranking key: (count of unpriced hops, then projected units, then hop count).
fn compare_paths(a: &CapabilityPath, b: &CapabilityPath) -> Ordering {
    let unpriced_a = a.steps.iter().filter(|s| s.unpriced).count();
    let unpriced_b = b.steps.iter().filter(|s| s.unpriced).count();
    match unpriced_a.cmp(&unpriced_b) {
        Ordering::Equal => {}
        other => return other,
    }
    match a.projected_units.partial_cmp(&b.projected_units) {
        Some(Ordering::Equal) | None => {}
        Some(other) => return other,
    }
    a.steps.len().cmp(&b.steps.len())
}

#[cfg(test)]
mod tests;
