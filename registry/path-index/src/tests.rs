//! Unit tests for the naive US-1 port. The full golden parity harness (every fixture, byte-for-byte
//! against the retired TypeScript) lands in US-2; these pin the core behaviour the port must have
//! from the start, mirroring the cases in `registry/src/path.test.ts` and `ports.test.ts`.

use serde_json::json;

use super::*;

/// Build the registrations the registry would hold from a set of manifest-like providers, with the
/// address projected the way `addressOf` does (identity + endpoints verbatim).
fn registrations(providers: Vec<serde_json::Value>) -> Vec<Registration> {
    providers
        .into_iter()
        .map(|p| {
            let identity = p["identity"].as_str().unwrap().to_string();
            let endpoints = p["endpoints"].clone();
            serde_json::from_value(json!({
                "identity": identity,
                "manifest": p,
                "address": { "identity": identity, "endpoints": endpoints },
            }))
            .unwrap()
        })
        .collect()
}

fn composer() -> serde_json::Value {
    json!({
        "identity": "orchestrator:agent:composer",
        "endpoints": { "a2a": "https://composer.example/.well-known/agent-card.json" },
        "capabilities": [{
            "name": "compose",
            "inputs": [{ "plane": "knowledge", "shape": "mood-descriptor" }],
            "outputs": [{ "plane": "media", "media_types": ["audio/midi"] }],
            "cost": { "tier": "paid", "est_units": 1200 }
        }]
    })
}

fn narrator() -> serde_json::Value {
    json!({
        "identity": "analyzer:agent:narrator",
        "endpoints": { "mcp": "https://analyzer.example/mcp" },
        "capabilities": [{
            "name": "narrate",
            "inputs": [{ "plane": "knowledge", "shape": "prompt-text" }],
            "outputs": [{ "plane": "media", "media_types": ["audio/wav"], "world_pattern": "alderforest" }],
            "cost": { "tier": "paid", "est_units": 500 }
        }]
    })
}

fn renderer() -> serde_json::Value {
    json!({
        "identity": "composer:agent:renderer",
        "endpoints": { "mcp": "https://composer.example/mcp" },
        "capabilities": [{
            "name": "render",
            "inputs": [{ "plane": "media", "media_types": ["audio/midi"] }],
            "outputs": [{ "plane": "media", "media_types": ["audio/wav"] }],
            "cost": { "tier": "local", "est_units": 0 },
            "endpoint": "https://composer.example/mcp/render"
        }]
    })
}

fn premium_renderer() -> serde_json::Value {
    json!({
        "identity": "composer:agent:premium-renderer",
        "endpoints": { "mcp": "https://premium.composer.example/mcp" },
        "capabilities": [{
            "name": "render",
            "inputs": [{ "plane": "media", "media_types": ["audio/midi"] }],
            "outputs": [{ "plane": "media", "media_types": ["audio/wav"] }],
            "cost": { "tier": "paid", "est_units": 900 }
        }]
    })
}

fn unpriced_renderer() -> serde_json::Value {
    json!({
        "identity": "composer:agent:unpriced-renderer",
        "endpoints": { "mcp": "https://unpriced.composer.example/mcp" },
        "capabilities": [{
            "name": "render",
            "inputs": [{ "plane": "media", "media_types": ["audio/midi"] }],
            "outputs": [{ "plane": "media", "media_types": ["audio/wav"] }],
            "cost": { "est_units": 0, "unpriced": true }
        }]
    })
}

fn describer() -> serde_json::Value {
    json!({
        "identity": "pinakes:agent:describer",
        "endpoints": { "mcp": "https://pinakes.example/mcp" },
        "capabilities": [{
            "name": "describe",
            "inputs": [{ "plane": "entity", "types": ["mood", "scene"] }],
            "outputs": [{ "plane": "knowledge", "shape": "mood-descriptor" }],
            "cost": { "est_units": 0, "unpriced": false }
        }]
    })
}

fn all() -> Vec<Registration> {
    registrations(vec![describer(), composer(), renderer(), premium_renderer(), narrator()])
}

fn query(from: serde_json::Value, to: serde_json::Value) -> PathQuery {
    serde_json::from_value(json!({ "from": from, "to": to })).unwrap()
}

fn identities(path: &CapabilityPath) -> Vec<String> {
    path.steps.iter().map(|s| s.identity.clone()).collect()
}

#[test]
fn composes_a_score_from_a_mood_across_planes_and_providers() {
    let path = search(&all(), &query(json!({ "entityType": "mood" }), json!({ "mediaType": "audio/wav" })))
        .expect("a path");
    assert_eq!(
        path.steps.iter().map(|s| format!("{}/{}", s.identity, s.capability)).collect::<Vec<_>>(),
        vec![
            "pinakes:agent:describer/describe",
            "orchestrator:agent:composer/compose",
            "composer:agent:renderer/render",
        ]
    );
    assert_eq!(path.projected_units, 1200.0);
    assert!(!path.unpriced);
}

#[test]
fn prefers_the_zero_cost_route() {
    let path = search(&all(), &query(json!({ "mediaType": "audio/midi" }), json!({ "mediaType": "audio/wav" })))
        .expect("a path");
    assert_eq!(identities(&path), vec!["composer:agent:renderer"]);
    assert_eq!(path.projected_units, 0.0);
}

#[test]
fn takes_a_priced_route_over_an_unpriced_one() {
    let regs = registrations(vec![unpriced_renderer(), premium_renderer()]);
    let path = search(&regs, &query(json!({ "mediaType": "audio/midi" }), json!({ "mediaType": "audio/wav" })))
        .expect("a path");
    assert_eq!(identities(&path), vec!["composer:agent:premium-renderer"]);
    assert_eq!(path.projected_units, 900.0);
}

#[test]
fn honours_world_scoping_on_the_goal_port() {
    let path = search(
        &all(),
        &query(json!({ "shape": "prompt-text" }), json!({ "mediaType": "audio/wav", "world": "alderforest" })),
    )
    .expect("a path");
    assert_eq!(identities(&path), vec!["analyzer:agent:narrator"]);
}

#[test]
fn is_a_plan_of_addresses_to_dial() {
    let regs = registrations(vec![renderer()]);
    let path = search(&regs, &query(json!({ "mediaType": "audio/midi" }), json!({ "mediaType": "audio/wav" })))
        .expect("a path");
    let step = &path.steps[0];
    assert_eq!(step.address.endpoints.get("mcp").map(String::as_str), Some("https://composer.example/mcp"));
    assert_eq!(step.endpoint.as_deref(), Some("https://composer.example/mcp/render"));
}

#[test]
fn has_no_path_when_no_chain_reaches_the_goal() {
    let path = search(&all(), &query(json!({ "entityType": "mood" }), json!({ "mediaType": "video/mp4" })));
    assert!(path.is_none());
}

#[test]
fn is_bounded_by_max_hops() {
    let two: PathQuery = serde_json::from_value(json!({
        "from": { "entityType": "mood" }, "to": { "mediaType": "audio/wav" }, "maxHops": 2
    }))
    .unwrap();
    assert!(search(&all(), &two).is_none());
    let three: PathQuery = serde_json::from_value(json!({
        "from": { "entityType": "mood" }, "to": { "mediaType": "audio/wav" }, "maxHops": 3
    }))
    .unwrap();
    assert_eq!(search(&all(), &three).unwrap().steps.len(), 3);
}

#[test]
fn max_hops_below_one_is_undefined() {
    let zero: PathQuery =
        serde_json::from_value(json!({ "from": {}, "to": {}, "maxHops": 0 })).unwrap();
    assert!(search(&all(), &zero).is_none());
}

#[test]
fn finds_nothing_in_an_empty_index() {
    assert!(search(&[], &query(json!({}), json!({}))).is_none());
}

#[test]
fn media_glob_overlaps_in_both_directions() {
    assert!(media_types_overlap("audio/*", "audio/wav"));
    assert!(media_types_overlap("audio/wav", "audio/*"));
    assert!(!media_types_overlap("audio/wav", "audio/midi"));
}

#[test]
fn unscoped_producer_feeds_a_scoped_consumer() {
    // world_pattern undefined on either side counts as unscoped, not wrong-world (ports.ts).
    let unscoped = Port::Media { media_types: vec!["audio/wav".into()], world_pattern: None, shape: None };
    let scoped =
        Port::Media { media_types: vec!["audio/wav".into()], world_pattern: Some("alderforest".into()), shape: None };
    assert!(satisfies(&unscoped, &scoped));
    assert!(satisfies(&scoped, &unscoped));
}

// --- US-2: the ports.test.ts tables, mirrored ----------------------------------------------

fn port(v: serde_json::Value) -> Port {
    serde_json::from_value(v).unwrap()
}

fn port_query(v: serde_json::Value) -> PortQuery {
    serde_json::from_value(v).unwrap()
}

#[test]
fn matches_port_reproduces_ports_test_ts() {
    let mood = port(json!({ "plane": "knowledge", "shape": "mood-descriptor" }));
    let midi = port(json!({ "plane": "media", "media_types": ["audio/midi"] }));
    let moods = port(json!({ "plane": "entity", "types": ["mood", "scene"] }));

    // An empty query matches every port; stated clauses are a conjunction.
    assert!(matches_port(&mood, &port_query(json!({}))));
    assert!(matches_port(&mood, &port_query(json!({ "plane": "knowledge", "shape": "mood-descriptor" }))));
    assert!(!matches_port(&mood, &port_query(json!({ "plane": "knowledge", "shape": "prompt-text" }))));

    // Media types match through a glob on either side, and only from the media plane.
    assert!(matches_port(&midi, &port_query(json!({ "mediaType": "audio/midi" }))));
    assert!(matches_port(&midi, &port_query(json!({ "mediaType": "audio/*" }))));
    assert!(!matches_port(&midi, &port_query(json!({ "mediaType": "video/mp4" }))));
    assert!(!matches_port(&mood, &port_query(json!({ "mediaType": "audio/*" }))));

    // Entity-type queries answer only from the entity plane.
    assert!(matches_port(&moods, &port_query(json!({ "entityType": "mood" }))));
    assert!(!matches_port(&mood, &port_query(json!({ "entityType": "mood" }))));
}

#[test]
fn serves_world_reproduces_delta_j() {
    let wav_alder =
        port(json!({ "plane": "media", "media_types": ["audio/wav"], "world_pattern": "alderforest" }));
    assert!(serves_world(&wav_alder, "alderforest"));
    assert!(!serves_world(&wav_alder, "consensus-reality"));

    let any_world = port(json!({ "plane": "media", "media_types": ["audio/wav"], "world_pattern": "*" }));
    assert!(serves_world(&any_world, "anything"));

    // A media port with no world_pattern makes no world claim, so answers no world query.
    let midi = port(json!({ "plane": "media", "media_types": ["audio/midi"] }));
    assert!(!serves_world(&midi, "alderforest"));

    // A knowledge port's explicit world list is read directly.
    let know = port(json!({ "plane": "knowledge", "dialect": "grounding-only", "worlds": ["alderforest"] }));
    assert!(serves_world(&know, "alderforest"));
    assert!(!serves_world(&know, "elsewhere"));
}

#[test]
fn satisfies_reproduces_ports_test_ts() {
    let mood = port(json!({ "plane": "knowledge", "shape": "mood-descriptor" }));
    let midi = port(json!({ "plane": "media", "media_types": ["audio/midi"] }));
    let moods = port(json!({ "plane": "entity", "types": ["mood", "scene"] }));
    let wav_alder =
        port(json!({ "plane": "media", "media_types": ["audio/wav"], "world_pattern": "alderforest" }));

    // Never crosses planes.
    assert!(!satisfies(&mood, &midi));

    // Knowledge: holds when the consumer's stated requirements are met; a bare consumer accepts any.
    assert!(satisfies(&port(json!({ "plane": "knowledge", "shape": "mood-descriptor" })), &mood));
    assert!(!satisfies(&port(json!({ "plane": "knowledge", "shape": "prompt-text" })), &mood));
    assert!(satisfies(&mood, &port(json!({ "plane": "knowledge" }))));

    // Media: requires overlapping media types.
    assert!(satisfies(&midi, &port(json!({ "plane": "media", "media_types": ["audio/midi", "audio/wav"] }))));
    assert!(!satisfies(&midi, &port(json!({ "plane": "media", "media_types": ["video/mp4"] }))));

    // Media: worlds constrain only when both ends declare one.
    let any_world = port(json!({ "plane": "media", "media_types": ["audio/wav"], "world_pattern": "*" }));
    let other = port(json!({ "plane": "media", "media_types": ["audio/wav"], "world_pattern": "consensus-reality" }));
    assert!(satisfies(&wav_alder, &any_world));
    assert!(!satisfies(&wav_alder, &other));
    assert!(satisfies(&port(json!({ "plane": "media", "media_types": ["audio/wav"] })), &other));

    // Entity: requires overlapping types.
    assert!(satisfies(&moods, &port(json!({ "plane": "entity", "types": ["mood"] }))));
    assert!(!satisfies(&moods, &port(json!({ "plane": "entity", "types": ["plugin"] }))));
}

// --- US-2: the indexed edge layer ----------------------------------------------------------

#[test]
fn index_candidates_equal_a_full_edge_scan_in_order() {
    // The whole point of the index: for every produced port, the edges it can feed — and the order
    // they come out — must match what the old `for (const edge of edges)` rescan would keep, so the
    // frontier is built identically and the first-Less-wins tie-break stays byte-identical.
    let regs = all();
    let index = EdgeIndex::build(&regs);
    let produced_ports: Vec<Port> = index.edges.iter().map(|e| e.output.clone()).collect();
    for produced in &produced_ports {
        let via_index: Vec<usize> = index
            .candidates(produced)
            .into_iter()
            .filter(|&i| satisfies(produced, &index.edges[i].input))
            .collect();
        let via_scan: Vec<usize> = index
            .edges
            .iter()
            .enumerate()
            .filter(|(_, edge)| satisfies(produced, &edge.input))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(via_index, via_scan, "index disagrees with a full scan for {produced:?}");
    }
}

// --- US-2: golden parity against the retired TypeScript ------------------------------------

/// The pinned fixtures, single source of truth shared with the TS shim test (`path-index.test.ts`).
#[derive(serde::Deserialize)]
struct GoldenFile {
    cases: Vec<GoldenCase>,
}

#[derive(serde::Deserialize)]
struct GoldenCase {
    name: String,
    registrations: Vec<Registration>,
    query: PathQuery,
    expected: Option<CapabilityPath>,
}

#[test]
fn golden_parity_byte_for_byte() {
    // Captured from the CURRENT findCapabilityPath (registry/src/path.ts) by generate-golden.ts.
    let raw = include_str!("../../src/fixtures/golden-paths.json");
    let file: GoldenFile = serde_json::from_str(raw).expect("golden fixtures parse");
    assert!(!file.cases.is_empty(), "golden fixtures must not be empty");
    for case in &file.cases {
        let got = search(&case.registrations, &case.query);
        assert_eq!(got, case.expected, "golden case: {}", case.name);
    }
}
