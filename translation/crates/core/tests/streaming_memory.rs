//! The logic-program emitters stream: peak memory is O(1) in the corpus size (the
//! whole program string is never built, and only a bounded predicate vocabulary plus
//! one row is held at a time). This proves it directly with a tracking global
//! allocator — the transient peak the *writer* adds is measured across growing
//! corpus sizes and asserted flat.
//!
//! The file holds a single `#[test]` so it runs as its own process: the global
//! allocator's counters are per-process, so no concurrently-running test pollutes the
//! measurement.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io;
use std::sync::atomic::{AtomicIsize, Ordering};

use translation_core::{
    write_problog_program, write_program, write_souffle_facts, AnnotatedFact, Atom, Fact,
};

/// A pass-through allocator that tracks the currently-allocated byte count and its
/// high-water mark, so a test can measure the transient peak a code section adds.
struct Tracking;

static CURRENT: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Tracking {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let now = CURRENT.fetch_add(layout.size() as isize, Ordering::Relaxed)
                + layout.size() as isize;
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        CURRENT.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: Tracking = Tracking;

/// One synthetic edge fact group of `rel/3`, typed `t/2`, `rel_conf/4`.
fn edge_facts_at(i: usize) -> Vec<Fact> {
    let start = Atom::Sym(format!("cs:x:{i}"));
    let end = Atom::Sym(format!("cs:y:{i}"));
    vec![
        Fact::new("rel", vec![Atom::Sym("located_in".into()), start.clone(), end.clone()], None),
        Fact::new("located_in", vec![start.clone(), end.clone()], None),
        Fact::new(
            "rel_conf",
            vec![Atom::Sym("located_in".into()), start, end, Atom::Float(0.5)],
            None,
        ),
    ]
}

fn facts(n: usize) -> Vec<Fact> {
    (0..n).flat_map(edge_facts_at).collect()
}

fn annotated(n: usize) -> Vec<AnnotatedFact> {
    facts(n).into_iter().map(AnnotatedFact::certain).collect()
}

/// The transient peak (bytes) a `write` closure adds, over an already-allocated
/// input. Baseline is the live bytes at entry; the input Vec is built *before* the
/// snapshot so only the writer's own allocation is measured.
fn transient_peak(run: impl FnOnce()) -> isize {
    let start = CURRENT.load(Ordering::Relaxed);
    PEAK.store(start, Ordering::Relaxed);
    run();
    PEAK.load(Ordering::Relaxed) - start
}

#[test]
fn emitters_hold_flat_peak_memory_across_growing_corpus_sizes() {
    // A generous, corpus-independent cap: the writer's transient never approaches the
    // O(N) size of the output it streams (hundreds of KiB even at 50k facts).
    const CAP: isize = 256 * 1024;

    for &n in &[500usize, 5_000, 50_000] {
        let prolog_facts = facts(n);
        let prolog_peak = transient_peak(|| {
            write_program(&mut io::sink(), &prolog_facts).unwrap();
        });

        let problog_facts = annotated(n);
        let problog_peak = transient_peak(|| {
            write_problog_program(&mut io::sink(), &problog_facts).unwrap();
        });

        let souffle_input = facts(n);
        let souffle_peak = transient_peak(|| {
            write_souffle_facts(&souffle_input, |_| Ok(io::sink())).unwrap();
        });

        assert!(
            prolog_peak < CAP && problog_peak < CAP && souffle_peak < CAP,
            "emit peak grew with corpus size at n={n}: \
             prolog={prolog_peak} problog={problog_peak} souffle={souffle_peak} (cap {CAP})"
        );
    }
}
