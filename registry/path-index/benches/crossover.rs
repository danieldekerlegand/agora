//! Crossover benchmark (US-5) — how much the US-2 edge index + US-3 heap frontier save over the
//! retired O(n)-per-pop TypeScript frontier (`takeBest` + a full `edgesOf` rescan on every pop),
//! which `agora_path_index::search_linear` reproduces in Rust as the baseline.
//!
//! Both engines return byte-identical paths (a unit test pins this on the golden fixtures), so the
//! only thing that differs is how the frontier is popped and how edges are scanned. The synthetic
//! graph is a fixed branching "signal" DAG (a seed, then [`BRANCH`] providers per layer over four
//! layers) so best-first must pop *many* partial paths before the goal — the regime where the
//! per-pop scan cost dominates — buried in a growing pile of "noise" providers on unique,
//! unreachable knowledge shapes. Those noise edges are exactly what the linear frontier rescans on
//! every pop but the plane-typed index buckets away by `(shape, dialect)` and never touches.
//!
//! Run with `cargo bench`. `harness = false`: this `main` times both engines over each graph size
//! and prints the crossover — no criterion, so the gate (`cargo clippy --all-targets`) stays light.

use std::hint::black_box;
use std::time::Instant;

use agora_path_index::{search, search_linear, PathQuery, Registration};
use serde_json::{json, Value};

/// Graph sizes to sweep, as the count of noise providers padding the branching signal DAG.
const NOISE_SIZES: &[usize] = &[0, 100, 500, 1_500, 5_000];
/// Providers per signal layer — the branch factor. Higher ⇒ more partial paths popped before the
/// goal (≈ 1 + BRANCH + BRANCH² pops), which is what makes the per-pop scan cost visible.
const BRANCH: usize = 12;
/// Searches per measurement — enough to average out per-op timing jitter.
const ITERS: u32 = 50;

fn main() {
    println!("agora-path-index crossover benchmark (US-5)");
    println!(
        "branching signal DAG (branch {BRANCH}, 4 layers) + N noise providers; \
         {ITERS} searches per measurement\n",
    );
    println!(
        "{:>8}  {:>8}  {:>14}  {:>14}  {:>9}",
        "noise", "providers", "linear ns/op", "indexed ns/op", "speedup",
    );
    println!("{}", "-".repeat(64));

    let query = path_query();
    let mut crossover: Option<usize> = None;

    for &noise in NOISE_SIZES {
        let regs = graph(noise);

        // The benchmark is only honest if both engines answer identically at this size.
        assert_eq!(
            search_linear(&regs, &query),
            search(&regs, &query),
            "linear and indexed disagree at noise={noise}",
        );

        let linear_ns = time(|| {
            black_box(search_linear(black_box(&regs), black_box(&query)));
        });
        let indexed_ns = time(|| {
            black_box(search(black_box(&regs), black_box(&query)));
        });

        let speedup = linear_ns / indexed_ns;
        if crossover.is_none() && indexed_ns < linear_ns {
            crossover = Some(regs.len());
        }
        println!(
            "{:>8}  {:>9}  {:>14.0}  {:>14.0}  {:>8.2}x",
            noise,
            regs.len(),
            linear_ns,
            indexed_ns,
            speedup,
        );
    }

    println!();
    match crossover {
        Some(providers) => println!(
            "crossover: the indexed engine overtakes the linear frontier at ~{providers} providers.",
        ),
        None => println!("no crossover in the swept range — indexed never overtook linear."),
    }
}

/// Mean nanoseconds per search over [`ITERS`] runs of `op`.
fn time(mut op: impl FnMut()) -> f64 {
    // A warm-up run so the first measured iteration isn't paying cold-cache costs.
    op();
    let start = Instant::now();
    for _ in 0..ITERS {
        op();
    }
    start.elapsed().as_nanos() as f64 / f64::from(ITERS)
}

/// From entity `seed` to knowledge shape `goal` — the signal DAG's endpoints. `maxHops` = 4 is the
/// exact depth of the goal, so the search pops every shallower partial (cost = depth, uniform) before
/// the first goal path — the many-pops regime the per-pop scan cost shows up in.
fn path_query() -> PathQuery {
    serde_json::from_value(json!({
        "from": { "entityType": "seed" },
        "to": { "plane": "knowledge", "shape": "goal" },
        "maxHops": 4,
    }))
    .expect("valid PathQuery")
}

/// The branching signal DAG plus `noise` dead-end providers on unique knowledge shapes.
///
/// Signal: `seed` (entity) → `s1`, then [`BRANCH`] providers `s1` → `s2`, [`BRANCH`] more
/// `s2` → `s3`, and [`BRANCH`] more `s3` → `goal`. Every hop costs 1.0, so best-first pops the
/// whole depth-≤3 frontier (≈ 1 + BRANCH + BRANCH² partials) before the first depth-4 goal path —
/// each pop a candidate lookup the index answers by bucket and the linear baseline answers by a
/// full edge rescan. Noise providers sit on unique `noise-in-k` shapes: they inflate the edge count
/// (and the linear rescan) but land in their own `(shape, dialect)` buckets the index never visits.
fn graph(noise: usize) -> Vec<Registration> {
    let mut providers: Vec<Value> =
        vec![provider("sig:seed", entity(&["seed"]), knowledge("s1"), 1.0)];
    for (from, to) in [("s1", "s2"), ("s2", "s3"), ("s3", "goal")] {
        for b in 0..BRANCH {
            providers.push(provider(
                &format!("sig:{from}-{to}-{b}"),
                knowledge(from),
                knowledge(to),
                1.0,
            ));
        }
    }
    for k in 0..noise {
        providers.push(provider(
            &format!("noise:agent:{k}"),
            knowledge(&format!("noise-in-{k}")),
            knowledge(&format!("noise-out-{k}")),
            1.0,
        ));
    }
    serde_json::from_value(Value::Array(providers.into_iter().map(registration).collect()))
        .expect("valid registrations")
}

/// A one-capability provider manifest with a single priced in→out edge.
fn provider(identity: &str, input: Value, output: Value, est_units: f64) -> Value {
    json!({
        "identity": identity,
        "endpoints": { "mcp": format!("https://{identity}.example/mcp") },
        "capabilities": [{
            "name": "step",
            "inputs": [input],
            "outputs": [output],
            "cost": { "tier": "paid", "est_units": est_units },
        }],
    })
}

/// Wrap a provider manifest as the registry's `Registration` (identity + manifest + address).
fn registration(manifest: Value) -> Value {
    json!({
        "identity": manifest["identity"],
        "manifest": manifest,
        "address": { "identity": manifest["identity"], "endpoints": manifest["endpoints"] },
    })
}

fn knowledge(shape: &str) -> Value {
    json!({ "plane": "knowledge", "shape": shape })
}

fn entity(types: &[&str]) -> Value {
    json!({ "plane": "entity", "types": types })
}
