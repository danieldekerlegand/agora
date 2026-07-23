//! Typed node/edge headers and the canonical schema, read as data.
//!
//! A faithful port of culture-scrape's `schema/headers.py`. The data model adopts
//! Neo4j's CSV header conventions (but tab-delimited) so `neo4j-admin import`
//! consumes the TSV directly. A header *cell* is one of:
//!
//! * a structural column — `csid:ID`, `:LABEL` (nodes) or `:START_ID`, `:END_ID`,
//!   `:TYPE` (edges);
//! * a property column — `name` (string) or `name:int` / `name:float`.
//!
//! The full canonical header, the 21 node-type labels, and the 21 edge-type tokens
//! are all loaded from `canonical-schema.json` (koine:12 —
//! pinakes/shared/canonical-schema.json v1.3.0), never hard-coded, so a schema bump
//! is a data change rather than a code change.

use crate::error::Error;
use serde::Deserialize;

/// Column delimiter for the TSV file family.
pub const DELIMITER: char = '\t';

/// Nameless structural header cells.
const STRUCTURAL: &[&str] = &[":LABEL", ":START_ID", ":END_ID", ":TYPE"];

/// A supported Neo4j property type and its header suffix.
///
/// Only the types the data model uses are supported; any other suffix (`:bool`,
/// `:datetime`, ...) is rejected as import-incompatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropertyType {
    String,
    Int,
    Float,
}

impl PropertyType {
    /// The header suffix for this type (`""` for the default string).
    pub fn suffix(self) -> &'static str {
        match self {
            PropertyType::String => "",
            PropertyType::Int => ":int",
            PropertyType::Float => ":float",
        }
    }

    fn from_tail(tail: &str) -> Option<PropertyType> {
        match tail {
            "string" => Some(PropertyType::String),
            "int" => Some(PropertyType::Int),
            "float" => Some(PropertyType::Float),
            _ => None,
        }
    }
}

/// Any single header cell: the primary key, a nameless structural column, or a
/// typed data column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Column {
    /// The primary-key column, rendered `<name>:ID` (e.g. `csid:ID`).
    Id { name: String },
    /// A nameless structural column: `:LABEL`, `:START_ID`, etc.
    Structural { field: String },
    /// A typed data column, rendered `<name>` or `<name>:<type>`.
    Property { name: String, ptype: PropertyType },
}

impl Column {
    /// This cell rendered as a header string.
    pub fn header(&self) -> String {
        match self {
            Column::Id { name } => format!("{name}:ID"),
            Column::Structural { field } => field.clone(),
            Column::Property { name, ptype } => format!("{name}{}", ptype.suffix()),
        }
    }

    /// The row key this column reads its value from (its name or structural field).
    pub fn key(&self) -> &str {
        match self {
            Column::Id { name } => name,
            Column::Structural { field } => field,
            Column::Property { name, .. } => name,
        }
    }
}

/// Parse one header *cell* into a [`Column`], mirroring `parse_column`.
pub fn parse_column(cell: &str) -> Result<Column, Error> {
    if cell.is_empty() {
        return Err(Error::Schema("empty header cell".into()));
    }
    let Some(idx) = cell.rfind(':') else {
        return Ok(Column::Property {
            name: cell.to_string(),
            ptype: PropertyType::String,
        });
    };
    let head = &cell[..idx];
    let tail = &cell[idx + 1..];
    if tail == "ID" {
        return Ok(Column::Id {
            name: head.to_string(),
        });
    }
    let structural = format!(":{tail}");
    if STRUCTURAL.contains(&structural.as_str()) {
        if !head.is_empty() {
            return Err(Error::Schema(format!(
                "structural column :{tail} must not be named"
            )));
        }
        return Ok(Column::Structural { field: structural });
    }
    match PropertyType::from_tail(tail) {
        Some(ptype) => Ok(Column::Property {
            name: head.to_string(),
            ptype,
        }),
        None => Err(Error::Schema(format!(
            "unsupported type suffix {tail:?} in {cell:?}"
        ))),
    }
}

/// A node type in the canonical vocabulary (`name` slug and `:LABEL` token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeType {
    pub name: String,
    pub label: String,
}

/// An edge type in the canonical vocabulary (`name` slug and `:TYPE` token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeType {
    pub name: String,
    pub type_token: String,
}

/// The whole canonical schema, loaded from `canonical-schema.json`.
#[derive(Debug, Clone)]
pub struct CanonicalSchema {
    pub version: String,
    pub node_columns: Vec<Column>,
    pub edge_columns: Vec<Column>,
    pub node_types: Vec<NodeType>,
    pub edge_types: Vec<EdgeType>,
}

// --- the JSON shape we deserialize (only the fields the codec needs) ---

#[derive(Deserialize)]
struct RawColumn {
    header: String,
}

#[derive(Deserialize)]
struct RawColumns {
    columns: Vec<RawColumn>,
}

#[derive(Deserialize)]
struct RawNodeType {
    name: String,
    label: String,
}

#[derive(Deserialize)]
struct RawEdgeType {
    name: String,
    #[serde(rename = "type")]
    type_token: String,
}

#[derive(Deserialize)]
struct RawSchema {
    version: String,
    node: RawColumns,
    edge: RawColumns,
    #[serde(rename = "nodeTypes")]
    node_types: Vec<RawNodeType>,
    #[serde(rename = "edgeTypes")]
    edge_types: Vec<RawEdgeType>,
}

/// The vendored canonical schema JSON (koine:12 — a data change bumps this file).
const CANONICAL_SCHEMA_JSON: &str = include_str!("../canonical-schema.json");

impl CanonicalSchema {
    /// The vendored canonical schema (koine:12, v1.3.0), parsed once.
    pub fn canonical() -> Result<CanonicalSchema, Error> {
        CanonicalSchema::from_json(CANONICAL_SCHEMA_JSON)
    }

    /// Parse a canonical schema from its JSON text.
    pub fn from_json(text: &str) -> Result<CanonicalSchema, Error> {
        let raw: RawSchema =
            serde_json::from_str(text).map_err(|e| Error::Schema(format!("bad schema JSON: {e}")))?;
        let node_columns = raw
            .node
            .columns
            .iter()
            .map(|c| parse_column(&c.header))
            .collect::<Result<Vec<_>, _>>()?;
        let edge_columns = raw
            .edge
            .columns
            .iter()
            .map(|c| parse_column(&c.header))
            .collect::<Result<Vec<_>, _>>()?;
        let schema = CanonicalSchema {
            version: raw.version,
            node_columns,
            edge_columns,
            node_types: raw
                .node_types
                .into_iter()
                .map(|t| NodeType {
                    name: t.name,
                    label: t.label,
                })
                .collect(),
            edge_types: raw
                .edge_types
                .into_iter()
                .map(|t| EdgeType {
                    name: t.name,
                    type_token: t.type_token,
                })
                .collect(),
        };
        schema.validate_node_header()?;
        schema.validate_edge_header()?;
        Ok(schema)
    }

    /// The primary-key row key (the `:ID` column's name, e.g. `csid`).
    pub fn node_id_key(&self) -> Result<&str, Error> {
        self.node_columns
            .iter()
            .find_map(|c| match c {
                Column::Id { name } => Some(name.as_str()),
                _ => None,
            })
            .ok_or_else(|| Error::Schema("node header requires an :ID column".into()))
    }

    /// Validate the node header the way `NodeSchema.__post_init__` does.
    fn validate_node_header(&self) -> Result<(), Error> {
        let cols = &self.node_columns;
        if !cols.iter().any(|c| matches!(c, Column::Id { .. })) {
            return Err(Error::Schema("node header requires an :ID column".into()));
        }
        if !cols
            .iter()
            .any(|c| matches!(c, Column::Structural { field } if field == ":LABEL"))
        {
            return Err(Error::Schema("node header requires a :LABEL column".into()));
        }
        if cols.iter().any(
            |c| matches!(c, Column::Structural { field } if matches!(field.as_str(), ":START_ID" | ":END_ID" | ":TYPE")),
        ) {
            return Err(Error::Schema(
                "node header must not contain edge columns".into(),
            ));
        }
        if !cols
            .iter()
            .any(|c| matches!(c, Column::Property { name, .. } if name == "name"))
        {
            return Err(Error::Schema("node header requires a 'name' column".into()));
        }
        check_property_types(cols, NODE_PROPERTY_TYPES)?;
        Ok(())
    }

    /// Validate the edge header the way `EdgeSchema.__post_init__` does.
    fn validate_edge_header(&self) -> Result<(), Error> {
        let cols = &self.edge_columns;
        for required in [":START_ID", ":END_ID", ":TYPE"] {
            if !cols
                .iter()
                .any(|c| matches!(c, Column::Structural { field } if field == required))
            {
                return Err(Error::Schema(format!(
                    "edge header requires a {required} column"
                )));
            }
        }
        if cols.iter().any(|c| matches!(c, Column::Id { .. })) {
            return Err(Error::Schema("edge header must not contain an :ID column".into()));
        }
        if cols
            .iter()
            .any(|c| matches!(c, Column::Structural { field } if field == ":LABEL"))
        {
            return Err(Error::Schema(
                "edge header must not contain a :LABEL column".into(),
            ));
        }
        check_property_types(cols, EDGE_PROPERTY_TYPES)?;
        Ok(())
    }
}

/// Property names the node data model types, with their required type.
const NODE_PROPERTY_TYPES: &[(&str, PropertyType)] = &[
    ("time_start", PropertyType::Int),
    ("time_end", PropertyType::Int),
    ("lat", PropertyType::Float),
    ("lon", PropertyType::Float),
    ("confidence", PropertyType::Float),
];

/// Property names the edge data model types, with their required type.
const EDGE_PROPERTY_TYPES: &[(&str, PropertyType)] = &[
    ("weight", PropertyType::Float),
    ("confidence", PropertyType::Float),
];

/// Reject property columns whose suffix conflicts with the data model.
fn check_property_types(columns: &[Column], typed: &[(&str, PropertyType)]) -> Result<(), Error> {
    for column in columns {
        if let Column::Property { name, ptype } = column {
            if let Some((_, expected)) = typed.iter().find(|(n, _)| n == name) {
                if ptype != expected {
                    return Err(Error::Schema(format!(
                        "property {name:?} must be {}, got {}",
                        type_name(*expected),
                        type_name(*ptype),
                    )));
                }
            }
        }
    }
    Ok(())
}

fn type_name(t: PropertyType) -> &'static str {
    match t {
        PropertyType::String => "string",
        PropertyType::Int => "int",
        PropertyType::Float => "float",
    }
}
