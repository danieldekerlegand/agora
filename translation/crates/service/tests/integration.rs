//! Integration surface for the transform leaf (US-6): dial the *running* service over
//! HTTP and prove three things.
//!
//! 1. `POST /transform` returns bytes byte-identical to the native crate for the same
//!    input — the service adds transport, not a second implementation.
//! 2. The served KCB manifest validates against the KCB manifest shape (capability-bus.md
//!    §2 / §2.1) — the same rules `schemas/src/manifest.ts` `parseManifest` enforces,
//!    mirrored here so the test is self-contained.
//! 3. The leaf never becomes a traffic hub: `proxiesTraffic` is `false` over the wire and
//!    there is no `invoke`/`proxy`/`forward` route (ADR-0001 decisions 1–2).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};

use serde_json::Value;
use translation_core as core;
use translation_service::{translate, Format, TranslationService, TRANSFORM_IDENTITY};

/// The shared canonical fixture — the same graph the US-1..5 goldens are captured from.
const FIXTURE: &str = include_str!("../../core/fixtures/graph.json");

fn boot() -> TranslationService {
    TranslationService::bind("127.0.0.1:0").expect("bind ephemeral port")
}

/// A minimal HTTP/1.1 client over raw TCP — enough to exercise the service without
/// pulling in an HTTP client crate. The server sends `Connection: close`, so
/// read-to-end yields the whole response.
fn request(addr: SocketAddr, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).expect("connect");
    let body = body.unwrap_or("");
    let raw = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(raw.as_bytes()).expect("write request");
    stream.flush().expect("flush");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).expect("read response");
    let text = String::from_utf8(buf).expect("utf-8 response");
    let (head, body) = text.split_once("\r\n\r\n").expect("headers/body split");
    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("status code");
    (status, body.to_string())
}

fn post_transform(addr: SocketAddr, format: &str) -> (u16, String) {
    let graph: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
    let body = serde_json::json!({ "format": format, "graph": graph }).to_string();
    request(addr, "POST", "/transform", Some(&body))
}

#[test]
fn transform_over_http_is_byte_identical_to_the_native_crate() {
    let service = boot();
    let addr = service.local_addr();

    // Every format the matrix offers comes back exactly as the in-process facade renders
    // it — the transport is transparent.
    for format in ["tsv", "csv", "cypher", "prolog", "souffle", "problog"] {
        let (status, body) = post_transform(addr, format);
        assert_eq!(status, 200, "{format} should translate");
        let expected = translate(Format::parse(format).unwrap(), FIXTURE).expect("native translate");
        assert_eq!(body, expected, "{format} bytes differ from the native facade");
    }

    // And, crisply, straight against `translation_core` — no second codec hides in the
    // service. A single-file dialect (Prolog) and a multi-file one (TSV) pin it.
    let schema = core::CanonicalSchema::canonical().unwrap();
    let graph = core::Graph::from_json(FIXTURE).unwrap();

    let (_, prolog) = post_transform(addr, "prolog");
    assert_eq!(prolog, core::graph_to_prolog(&schema, &graph).unwrap());

    let (_, tsv) = post_transform(addr, "tsv");
    let tsv: Value = serde_json::from_str(&tsv).unwrap();
    assert_eq!(tsv["nodes"], core::nodes_to_tsv(&schema, &graph).unwrap());
    assert_eq!(tsv["edges"], core::edges_to_tsv(&schema, &graph).unwrap());

    // A bad request is a 4xx, not a crash or a silent empty body.
    let (status, _) = request(addr, "POST", "/transform", Some(r#"{"format":"yaml","graph":{}}"#));
    assert_eq!(status, 400);
}

#[test]
fn served_manifest_validates_against_the_kcb_manifest_shape() {
    let service = boot();
    let (status, body) = request(service.local_addr(), "GET", "/.well-known/kcb-manifest.json", None);
    assert_eq!(status, 200);
    let manifest: Value = serde_json::from_str(&body).expect("manifest is JSON");

    assert_valid_kcb_manifest(&manifest);

    // The transform capability is present, plane-typed, and gated on invoke:transform.
    let capability = manifest["capabilities"]
        .as_array()
        .and_then(|caps| caps.iter().find(|c| c["name"] == "transform"))
        .expect("a transform capability");
    assert_plane_typed_ports(&capability["inputs"]);
    assert_plane_typed_ports(&capability["outputs"]);
    // The input is the knowledge-plane canonical graph (KCB §2.1 / KMI §6).
    assert_eq!(capability["inputs"][0]["plane"], "knowledge");
    let grants = manifest["auth"]["grants_required"]
        .as_array()
        .expect("grants_required array");
    assert!(grants.iter().any(|g| g == "invoke:transform"));
}

/// Mirror of the core rules `parseManifest` (schemas/src/manifest.ts) enforces: a
/// non-empty `kcb_version`, a KINP `identity`, an `endpoints` object, and plane-typed
/// ports on `produces`/`consumes`/`capabilities`.
fn assert_valid_kcb_manifest(manifest: &Value) {
    assert!(manifest["kcb_version"].as_str().is_some_and(|v| !v.is_empty()));
    // identity is a KINP id: <namespace>:<kind>:<local>, and it is this leaf.
    let identity = manifest["identity"].as_str().expect("identity string");
    assert_eq!(identity, TRANSFORM_IDENTITY);
    assert_eq!(identity.split(':').count(), 3);
    assert!(manifest["endpoints"].is_object());
    assert_plane_typed_ports(&manifest["produces"]);
    assert_plane_typed_ports(&manifest["consumes"]);
}

/// Every entry is a port on a known KCB plane, with the plane's required typing present.
fn assert_plane_typed_ports(ports: &Value) {
    for port in ports.as_array().expect("ports is an array") {
        match port["plane"].as_str() {
            Some("knowledge") => {}
            Some("media") => assert!(port["media_types"].is_array(), "media port needs media_types"),
            Some("entity") => assert!(port["types"].is_array(), "entity port needs types"),
            other => panic!("port on an unknown plane: {other:?}"),
        }
    }
}

#[test]
fn describes_itself_as_a_non_proxying_leaf_with_no_traffic_hub_routes() {
    let service = boot();
    let addr = service.local_addr();

    let (status, body) = request(addr, "GET", "/", None);
    assert_eq!(status, 200);
    let description: Value = serde_json::from_str(&body).expect("description is JSON");
    // ADR-0001 decisions 1–2, asserted over the wire.
    assert_eq!(description["proxiesTraffic"], false);
    assert_eq!(description["capabilities"], serde_json::json!(["transform"]));
    assert_eq!(description["peers"], serde_json::json!([]));

    // The traffic-hub verbs simply do not exist on this leaf — a data-plane relay route
    // is a 404, so it can never accrete an ESB shape by accident.
    for (method, path) in [("POST", "/invoke"), ("POST", "/proxy"), ("GET", "/forward")] {
        let (status, _) = request(addr, method, path, Some("{}"));
        assert_eq!(status, 404, "{method} {path} must not exist");
    }
}
