//! A thin HTTP transform service over agora's translation core.
//!
//! This crate is the **network facade of last resort**. The embeddable-first path
//! (WASM for TS, PyO3 for Python) lets a peer translate a canonical graph *in-process*
//! with zero network hop; this service exists only for the boundary an embed cannot
//! cross — a caller in a language or process that cannot link the crate. It adds
//! *transport*, not a second implementation: every route calls straight into
//! [`translation_core`], so its bytes are identical to the native crate's.
//!
//! It is a **directly-dialed KCB leaf** in the ADR-0001 sense: it publishes one KCB
//! capability manifest naming a single `transform` capability (a knowledge-plane
//! canonical-graph input → the target dialect output, KCB §2.1 / KMI §6), is dialed on
//! demand, and returns the translation to the caller. It **never** relays or transforms
//! another service's inter-platform traffic — it holds no peer routing table and
//! advertises only its own transform. `describe_transform().proxies_traffic` is always
//! `false`, asserted in the tests (the ADR-0001-style assertion already used across
//! agora for the registry), and there is deliberately no `invoke`/`proxy`/`forward`
//! route, so the traffic-hub shape ADR-0001 decisions 1–2 reject cannot be added by
//! accident: an unknown path is a 404.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use translation_core as core;

/// KINP identity of the transform service itself — a capability provider is a fabric
/// entity too (KCB §2).
pub const TRANSFORM_IDENTITY: &str = "agora:agent:translation";

/// The KCB spec version this service publishes. Pinned to `schemas/src/versions.ts`
/// (`SPEC_VERSIONS.kcb`) and `provider-router`'s `KCB_VERSION` — bump all together.
pub const KCB_VERSION: &str = "0.2.0";

/// The one capability this leaf advertises.
pub const TRANSFORM_CAPABILITY: &str = "transform";

/// A target format in the translation matrix — the `format` field a `/transform`
/// request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Canonical TSV (`{nodes, edges}`).
    Tsv,
    /// Neo4j-import CSV (`{nodes, edges}`).
    Csv,
    /// Incremental `LOAD CSV ... MERGE` Cypher load script.
    Cypher,
    /// A loadable SWI-Prolog program (`graph.pl`).
    Prolog,
    /// A Soufflé program (`{program, facts}`).
    Souffle,
    /// A ProbLog program (`graph.problog.pl`).
    Problog,
}

impl Format {
    /// Parse the wire spelling of a target format (the `format` field), if known.
    pub fn parse(value: &str) -> Option<Format> {
        match value {
            "tsv" => Some(Format::Tsv),
            "csv" => Some(Format::Csv),
            "cypher" => Some(Format::Cypher),
            "prolog" => Some(Format::Prolog),
            "souffle" => Some(Format::Souffle),
            "problog" => Some(Format::Problog),
            _ => None,
        }
    }
}

/// Translate a canonical graph (JSON text) to `format`, returning the same bytes the
/// native crate and the WASM/PyO3 facades produce for that input. Single-file formats
/// (Cypher, Prolog, ProbLog) return the raw document; multi-file formats return a JSON
/// object — `{nodes, edges}` for TSV/CSV, `{program, facts}` for Soufflé.
pub fn translate(format: Format, graph_json: &str) -> Result<String, core::Error> {
    let schema = core::CanonicalSchema::canonical()?;
    let graph = core::Graph::from_json(graph_json)?;
    match format {
        Format::Tsv => {
            let nodes = core::nodes_to_tsv(&schema, &graph)?;
            let edges = core::edges_to_tsv(&schema, &graph)?;
            Ok(to_json(&NodesEdges { nodes, edges }))
        }
        Format::Csv => {
            let nodes = core::nodes_to_csv(&schema, &graph)?;
            let edges = core::edges_to_csv(&schema, &graph)?;
            Ok(to_json(&NodesEdges { nodes, edges }))
        }
        Format::Cypher => core::graph_to_load_script(&schema, &graph),
        Format::Prolog => core::graph_to_prolog(&schema, &graph),
        Format::Souffle => {
            let program = core::graph_to_souffle(&schema, &graph)?;
            Ok(to_json(&SouffleOut {
                program: program.program,
                facts: program.facts,
            }))
        }
        Format::Problog => core::graph_to_problog(&schema, &graph),
    }
}

/// The `{nodes, edges}` shape shared by the sharded TSV and CSV facades (mirrors the
/// WASM facade exactly, so the two facades' bytes match).
#[derive(Serialize)]
struct NodesEdges {
    nodes: String,
    edges: String,
}

/// The `{program, facts}` shape of a rendered Soufflé program.
#[derive(Serialize)]
struct SouffleOut {
    program: String,
    facts: BTreeMap<String, String>,
}

/// What this service *is* — the ADR-0001 self-description, the same shape the registry
/// serves at `/`. `proxies_traffic` is always `false` and `peers` is always empty: a
/// transform leaf holds no peer routing table and relays nothing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransformDescription {
    /// KINP identity of the leaf.
    pub identity: String,
    /// The KCB version it speaks.
    pub kcb_version: String,
    /// Always `false` — ADR-0001 decisions 1–2: no central server relays or transforms
    /// inter-service traffic. Asserted in the tests, not merely stated in prose.
    pub proxies_traffic: bool,
    /// The named capabilities it advertises — only its own `transform`, nothing else.
    pub capabilities: Vec<String>,
    /// Peer routing table. Always empty: this leaf routes for no one.
    pub peers: Vec<String>,
}

/// The ADR-0001 self-description of this leaf. A transform leaf advertises only its own
/// `transform` capability, proxies no traffic, and holds no peer routing table.
pub fn describe_transform() -> TransformDescription {
    TransformDescription {
        identity: TRANSFORM_IDENTITY.to_string(),
        kcb_version: KCB_VERSION.to_string(),
        proxies_traffic: false,
        capabilities: vec![TRANSFORM_CAPABILITY.to_string()],
        peers: Vec::new(),
    }
}

/// Build this service's KCB capability manifest (capability-bus.md §2, 0.2.0 standalone
/// form — the shape the provider-router publishes and the registry indexes).
///
/// The `transform` capability's ports are plane-typed (KCB §2.1 / KMI §6): a
/// knowledge-plane canonical-graph input to the target-dialect output (knowledge for the
/// logic programs, media for the tabular text exports). `auth.grants_required` carries
/// `invoke:transform`. `base_url` is the live address this instance serves, so a peer can
/// dial the returned `endpoints`/`capabilities[].endpoint` directly.
pub fn manifest(base_url: &str) -> Value {
    let output_ports = json!([
        { "plane": "knowledge", "shape": "logic-program",
          "dialect": "prolog|souffle-datalog|problog" },
        { "plane": "media",
          "media_types": ["text/tab-separated-values", "text/csv", "application/x-cypher"],
          "world_pattern": "*" }
    ]);
    json!({
        "kcb_version": KCB_VERSION,
        "identity": TRANSFORM_IDENTITY,
        "version": env!("CARGO_PKG_VERSION"),
        "endpoints": {
            "a2a": base_url,
            "transform": format!("{base_url}/transform"),
            "manifest": format!("{base_url}/.well-known/kcb-manifest.json"),
        },
        "produces": output_ports,
        "consumes": [
            { "plane": "knowledge", "shape": "canonical-graph" }
        ],
        "capabilities": [
            {
                "name": TRANSFORM_CAPABILITY,
                "inputs": [ { "plane": "knowledge", "shape": "canonical-graph" } ],
                "outputs": output_ports,
                "cost": {
                    "tier": "local",
                    "est_units": 0.0,
                    "unit": "graph",
                    "quantity": 1.0,
                    "basis": "one canonical graph translated in-process",
                    "unpriced": false
                },
                "endpoint": format!("{base_url}/transform")
            }
        ],
        "auth": {
            "scheme": "capability-token",
            "grants_required": ["invoke:transform"]
        }
    })
}

/// A running transform service. Owns the accept thread; dropping (or [`shutdown`]) stops
/// it and joins.
///
/// [`shutdown`]: TranslationService::shutdown
pub struct TranslationService {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl TranslationService {
    /// Bind the service to `addr` and start serving. Pass a port of `0` for an ephemeral
    /// port (read it back with [`local_addr`](Self::local_addr)).
    pub fn bind(addr: impl ToSocketAddrs) -> std::io::Result<TranslationService> {
        let listener = TcpListener::bind(addr)?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&shutdown);
        let base = format!("http://{addr}");
        let handle = thread::spawn(move || serve_loop(&listener, &flag, &base));
        Ok(TranslationService {
            addr,
            shutdown,
            handle: Some(handle),
        })
    }

    /// The address the service is bound to.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The base URL a peer dials — `http://<host>:<port>`.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Stop serving and join the accept thread.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for TranslationService {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Accept loop: poll the non-blocking listener, handing each connection to its own
/// thread, until the shutdown flag is set.
fn serve_loop(listener: &TcpListener, shutdown: &AtomicBool, base: &str) {
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let base = base.to_string();
                thread::spawn(move || {
                    let _ = handle_conn(stream, &base);
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
}

/// A parsed HTTP request — only what routing needs.
struct Request {
    method: String,
    path: String,
    body: String,
}

/// A response to write back.
struct Response {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: String,
}

fn handle_conn(mut stream: TcpStream, base: &str) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    let Some(request) = read_request(&mut stream)? else {
        return Ok(());
    };
    let response = route(&request, base);
    write_response(&mut stream, &response)
}

/// Read one HTTP/1.1 request: the request line, headers (only `Content-Length` matters),
/// then exactly that many body bytes.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    Ok(Some(Request {
        method,
        path,
        body: String::from_utf8_lossy(&body).into_owned(),
    }))
}

/// Route a request. The whole surface is: describe (`/`), the manifest, and the one
/// `POST /transform`. There is deliberately no `invoke`/`proxy`/`forward` route — an
/// unknown path is a 404, so the traffic-hub shape ADR-0001 rejects cannot creep in.
fn route(request: &Request, base: &str) -> Response {
    let path = request.path.split('?').next().unwrap_or(&request.path);
    match (request.method.as_str(), path) {
        ("GET", "/") => json_ok(&describe_transform()),
        ("GET", "/.well-known/kcb-manifest.json") => json_ok(&manifest(base)),
        ("POST", "/transform") => handle_transform(&request.body),
        _ => Response {
            status: 404,
            reason: "Not Found",
            content_type: "text/plain",
            body: "not found\n".to_string(),
        },
    }
}

/// The `POST /transform` body: a target `format` plus the canonical `graph`.
#[derive(Deserialize)]
struct TransformRequest {
    format: String,
    graph: Value,
}

fn handle_transform(body: &str) -> Response {
    let request: TransformRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(err) => return bad_request(&format!("invalid transform request: {err}")),
    };
    let Some(format) = Format::parse(&request.format) else {
        return bad_request(&format!("unknown format: {}", request.format));
    };
    match translate(format, &request.graph.to_string()) {
        Ok(output) => Response {
            status: 200,
            reason: "OK",
            content_type: content_type_for(format),
            body: output,
        },
        Err(err) => bad_request(&err.to_string()),
    }
}

/// Single-file dialects come back as their raw document; the multi-file formats come
/// back as a JSON object. (Content type is metadata only — it never alters the bytes.)
fn content_type_for(format: Format) -> &'static str {
    match format {
        Format::Tsv | Format::Csv | Format::Souffle => "application/json",
        Format::Cypher | Format::Prolog | Format::Problog => "text/plain; charset=utf-8",
    }
}

fn json_ok<T: Serialize>(value: &T) -> Response {
    Response {
        status: 200,
        reason: "OK",
        content_type: "application/json",
        body: to_json(value),
    }
}

fn bad_request(message: &str) -> Response {
    Response {
        status: 400,
        reason: "Bad Request",
        content_type: "text/plain",
        body: format!("{message}\n"),
    }
}

fn write_response(stream: &mut TcpStream, response: &Response) -> std::io::Result<()> {
    let body = response.body.as_bytes();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        response.reason,
        response.content_type,
        body.len(),
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// Serialize a value to compact JSON. Our payloads are plain strings/maps, so this never
/// fails in practice.
fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("service payloads are serializable")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ADR-0001 invariant, encoded as an assertion (decisions 1–2): a transform leaf
    /// never proxies, advertises only its own `transform`, and holds no peer routing
    /// table. If `capabilities` or `peers` ever grew a routing entry, this fails.
    #[test]
    fn never_proxies_and_holds_no_peer_routing_table() {
        let description = describe_transform();
        assert!(!description.proxies_traffic);
        assert_eq!(description.capabilities, vec![TRANSFORM_CAPABILITY.to_string()]);
        assert!(description.peers.is_empty());
    }

    #[test]
    fn format_wire_spellings_round_trip() {
        for (spelling, format) in [
            ("tsv", Format::Tsv),
            ("csv", Format::Csv),
            ("cypher", Format::Cypher),
            ("prolog", Format::Prolog),
            ("souffle", Format::Souffle),
            ("problog", Format::Problog),
        ] {
            assert_eq!(Format::parse(spelling), Some(format));
        }
        assert_eq!(Format::parse("yaml"), None);
    }
}
