// Node harness for the translation-wasm bindings (US-4).
//
// It loads the wasm-bindgen module built by test.sh, translates the SHARED
// canonical fixture (crates/core/fixtures/graph.json — the same input the native
// crate's golden tests use), and asserts the emitted bytes are byte-identical to
// the committed US-1/US-2/US-3 goldens. Those goldens ARE the native crate's output
// (and, transitively, culture-scrape's), so a green run proves one core, two
// facades: the wasm path produces the same bytes as the native path.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wasm = require("./pkg/translation_wasm.js");
const CORE = path.resolve(__dirname, "../core");
const read = (...p) => fs.readFileSync(path.join(CORE, ...p), "utf8");

const graphJson = read("fixtures", "graph.json");

let checks = 0;
function eq(actual, expected, label) {
  assert.strictEqual(actual, expected, `wasm ${label} is not byte-identical to the golden`);
  checks += 1;
}

// --- TSV (US-1 golden; required by AC) ---
const tsv = JSON.parse(wasm.toTsv(graphJson));
eq(tsv.nodes, read("fixtures", "golden", "nodes.tsv"), "toTsv nodes");
eq(tsv.edges, read("fixtures", "golden", "edges.tsv"), "toTsv edges");

// --- Prolog / ProbLog / Soufflé (US-2 goldens; Prolog required by AC) ---
eq(wasm.toProlog(graphJson), read("fixtures", "golden", "datalog", "graph.pl"), "toProlog");
eq(wasm.toProblog(graphJson), read("fixtures", "golden", "datalog", "graph.problog.pl"), "toProblog");

const souffle = JSON.parse(wasm.toSouffle(graphJson));
eq(souffle.program, read("fixtures", "golden", "datalog", "graph.dl"), "toSouffle program");
const factsDir = path.join(CORE, "fixtures", "golden", "datalog", "facts");
for (const file of fs.readdirSync(factsDir).sort()) {
  const pred = file.replace(/\.facts$/, "");
  eq(souffle.facts[pred], read("fixtures", "golden", "datalog", "facts", file), `toSouffle facts[${pred}]`);
}

// --- CSV + Cypher: no committed golden (CSV is a new format; Cypher's full load
//     script references shard paths). Assert the facade runs and produces the
//     expected structural shape, so the whole matrix is exercised in-process. ---
const csv = JSON.parse(wasm.toCsv(graphJson));
assert.ok(csv.nodes.startsWith("csid:ID,:LABEL"), "toCsv nodes header");
assert.ok(csv.edges.startsWith(":START_ID,:END_ID,:TYPE"), "toCsv edges header");
checks += 2;

const cypher = wasm.toCypher(graphJson);
assert.ok(cypher.includes("apoc.create.addLabels") && cypher.includes("apoc.merge.relationship"),
  "toCypher emits the apoc MERGE projection");
checks += 1;

// --- an error surfaces as a thrown JS exception, not a silent bad result ---
assert.throws(() => wasm.toProlog("not json"), /./, "invalid JSON should throw");
checks += 1;

console.log(`translation-wasm: ${checks} byte-identity / shape checks passed`);
