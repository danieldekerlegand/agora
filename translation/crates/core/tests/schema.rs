//! The canonical schema is read as data from `canonical-schema.json`: the node/edge
//! type vocabularies and the typed column headers all come from the JSON, so a schema
//! bump is a data change. These assertions pin *what the JSON says*, not a hard-coded
//! count, so bumping the schema file updates the expectation with no code change.

use translation_core::{CanonicalSchema, Column, PropertyType};

/// The counts the vendored v1.3.0 file declares, derived from the JSON itself so this
/// stays a data change. (The runtime PRD's "23 node types" predates this pin; the
/// vendored v1.3.0 schema declares 21.)
fn declared_counts() -> (usize, usize) {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../canonical-schema.json")).unwrap();
    (
        json["nodeTypes"].as_array().unwrap().len(),
        json["edgeTypes"].as_array().unwrap().len(),
    )
}

#[test]
fn node_and_edge_type_vocabularies_come_from_the_json() {
    let schema = CanonicalSchema::canonical().unwrap();
    let (nodes, edges) = declared_counts();
    assert_eq!(schema.node_types.len(), nodes);
    assert_eq!(schema.edge_types.len(), edges);
    assert_eq!(schema.version, "1.3.0");

    // A representative slug -> label / :TYPE token mapping, read from the JSON.
    let language = schema
        .node_types
        .iter()
        .find(|t| t.name == "language")
        .unwrap();
    assert_eq!(language.label, "Language");
    let descends = schema
        .edge_types
        .iter()
        .find(|t| t.name == "descended-from")
        .unwrap();
    assert_eq!(descends.type_token, "DESCENDS_FROM");
}

#[test]
fn node_header_types_and_provenance_are_present() {
    let schema = CanonicalSchema::canonical().unwrap();
    let by_name = |name: &str| {
        schema.node_columns.iter().find_map(|c| match c {
            Column::Property { name: n, ptype } if n == name => Some(*ptype),
            _ => None,
        })
    };
    assert_eq!(by_name("time_start"), Some(PropertyType::Int));
    assert_eq!(by_name("lat"), Some(PropertyType::Float));
    assert_eq!(by_name("confidence"), Some(PropertyType::Float));
    for prov in ["source", "source_url", "retrieved_at", "confidence", "license"] {
        assert!(
            schema.node_columns.iter().any(|c| c.key() == prov),
            "missing provenance column {prov}"
        );
    }
    // csid is the primary key.
    assert_eq!(schema.node_id_key().unwrap(), "csid");
}

#[test]
fn a_bad_type_suffix_is_rejected() {
    // confidence must be :float; :int is import-incompatible and must be refused.
    let mut broken: serde_json::Value =
        serde_json::from_str(include_str!("../canonical-schema.json")).unwrap();
    for col in broken["node"]["columns"].as_array_mut().unwrap() {
        if col["field"] == "confidence" {
            col["header"] = serde_json::Value::String("confidence:int".into());
        }
    }
    let text = serde_json::to_string(&broken).unwrap();
    assert!(CanonicalSchema::from_json(&text).is_err());
}
