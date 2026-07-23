//! Idempotent `LOAD CSV ... MERGE` Cypher — a port of `neo4j/load_csv.py`.
//!
//! Bulk-seeding a *fresh* database is `neo4j-admin import`; keeping an *existing*
//! graph current is incremental `LOAD CSV`. This turns the canonical schema into
//! parameterized Cypher that re-imports node and edge files **idempotently**:
//!
//! * nodes are `MERGE`\ d on `csid` (never `CREATE`\ d) under the shared
//!   [`ENTITY_LABEL`](super::ENTITY_LABEL) anchor, so re-running a file updates rather
//!   than duplicates and the `csid` uniqueness constraint backs the merge as an index
//!   lookup;
//! * relationships are merged on `(:START_ID, :END_ID, :TYPE)` via
//!   `apoc.merge.relationship` — core Cypher cannot `MERGE` a relationship whose type
//!   is data-driven, so APOC supplies the equivalent merge semantics.
//!
//! Each statement reads its file through a `$file` parameter and coerces every typed
//! property column to `int`/`float`/`string` per its header suffix (`LOAD CSV` reads
//! every cell as a string, unlike `neo4j-admin`, so the coercion is explicit). No live
//! database is required to generate any of this.

use super::ENTITY_LABEL;
use crate::error::Error;
use crate::graph::{Graph, Row};
use crate::schema::{CanonicalSchema, Column, PropertyType};
use crate::tsv::MULTI_VALUE_KEYS;

/// Array-element separator inside multi-value cells (matches the TSV writer).
pub const ARRAY_DELIMITER: char = ';';

/// Cypher parameter naming the CSV file URL each statement reads.
pub const FILE_PARAM: &str = "file";

/// Field separator passed to `LOAD CSV` (the literal escape `\t`).
pub const FIELD_TERMINATOR: &str = "\\t";

/// Filename of the emitted Cypher script.
pub const SCRIPT_NAME: &str = "neo4j-load-csv.cypher";

/// One `LOAD CSV` statement plus the shard file it should be run against.
///
/// The embeddable core references shards by their canonical relative path
/// (`nodes/<label>.tsv`, `edges/<type>.tsv`) rather than resolving to an absolute
/// `file://` URL, since it holds the graph in memory and materialises no dataset
/// directory; the Cypher body is identical to the reference either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CypherStatement {
    /// `"node"` or `"edge"`.
    pub kind: String,
    /// The shard file this statement re-imports (e.g. `nodes/Language.tsv`).
    pub file: String,
    /// The `LOAD CSV ... MERGE` Cypher body.
    pub cypher: String,
}

/// The Cypher expression reading `column` from `row`, type-coerced (`_property_expr`).
fn property_expr(name: &str, ptype: PropertyType, header: &str) -> String {
    let reference = format!("row.`{header}`");
    if MULTI_VALUE_KEYS.contains(&name) {
        return format!("split({reference}, '{ARRAY_DELIMITER}')");
    }
    match ptype {
        PropertyType::Int => format!("toInteger({reference})"),
        PropertyType::Float => format!("toFloat({reference})"),
        PropertyType::String => reference,
    }
}

/// Render the property `columns` as a Cypher map literal of coerced values (`_props_map`).
fn props_map(columns: &[&Column]) -> String {
    if columns.is_empty() {
        return "{}".to_string();
    }
    let items: Vec<String> = columns
        .iter()
        .filter_map(|c| match **c {
            Column::Property { ref name, ptype } => {
                Some(format!("`{name}`: {}", property_expr(name, ptype, &c.header())))
            }
            _ => None,
        })
        .collect();
    format!("{{\n  {}\n}}", items.join(",\n  "))
}

/// The property columns of a header, in schema order.
fn property_columns(columns: &[Column]) -> Vec<&Column> {
    columns
        .iter()
        .filter(|c| matches!(c, Column::Property { .. }))
        .collect()
}

/// The shared `LOAD CSV` opening line every statement starts with (`_load_csv_prelude`).
fn load_csv_prelude() -> String {
    format!("LOAD CSV WITH HEADERS FROM ${FILE_PARAM} AS row FIELDTERMINATOR '{FIELD_TERMINATOR}'")
}

/// Build idempotent `MERGE`-on-`csid` Cypher for a node header (`node_cypher`).
///
/// The node is keyed on its `:ID` column under the shared [`ENTITY_LABEL`] anchor, so
/// the `csid` uniqueness constraint backs the `MERGE` as an index lookup. Properties
/// are coerced and applied with `SET n +=`, and the `;`-separated `:LABEL` cell is
/// reattached with `apoc.create.addLabels`.
pub fn node_cypher(node_columns: &[Column]) -> Result<String, Error> {
    let id_col = node_columns
        .iter()
        .find(|c| matches!(c, Column::Id { .. }))
        .ok_or_else(|| Error::Schema("node header requires an :ID column".into()))?;
    let id_name = id_col.key();
    let props = props_map(&property_columns(node_columns));
    Ok(format!(
        "{prelude}\n\
         MERGE (n:{ENTITY_LABEL} {{`{id_name}`: row.`{id_header}`}})\n\
         SET n += {props}\n\
         WITH n, row\n\
         CALL apoc.create.addLabels(n, split(row.`:LABEL`, '{ARRAY_DELIMITER}')) YIELD node\n\
         RETURN count(node);",
        prelude = load_csv_prelude(),
        id_header = id_col.header(),
    ))
}

/// Build idempotent merge Cypher for an edge header (`edge_cypher`).
///
/// Endpoints are matched by `csid` and the relationship is merged on
/// `(:START_ID, :END_ID, :TYPE)` via `apoc.merge.relationship` — the data-driven
/// `:TYPE` rules out a core-Cypher `MERGE` — with coerced properties applied on both
/// create and match so a re-run refreshes them.
pub fn edge_cypher(edge_columns: &[Column]) -> Result<String, Error> {
    let props = props_map(&property_columns(edge_columns));
    Ok(format!(
        "{prelude}\n\
         MATCH (start {{csid: row.`:START_ID`}})\n\
         MATCH (end {{csid: row.`:END_ID`}})\n\
         CALL apoc.merge.relationship(\n\
         \x20 start, row.`:TYPE`, {{}}, {props}, end, {props}\n\
         ) YIELD rel\n\
         RETURN count(rel);",
        prelude = load_csv_prelude(),
    ))
}

/// The shard's primary label — its alphabetically-first `:LABEL` token.
fn primary_label(row: &Row) -> Result<String, Error> {
    let labels = row
        .get(":LABEL")
        .ok_or_else(|| Error::Schema("node row has no :LABEL".into()))?
        .as_multi(":LABEL")?;
    let mut labels: Vec<&String> = labels.iter().collect();
    labels.sort();
    labels
        .first()
        .map(|l| (*l).clone())
        .ok_or_else(|| Error::Schema("node row has an empty :LABEL".into()))
}

/// The distinct `:TYPE` of an edge row.
fn edge_type(row: &Row) -> Result<String, Error> {
    Ok(row
        .get(":TYPE")
        .ok_or_else(|| Error::Schema("edge row has no :TYPE".into()))?
        .as_scalar(":TYPE")?
        .to_string())
}

/// Build one `LOAD CSV` statement per node shard then per edge shard (`build_statements`).
///
/// Node statements come first so that, run in order, relationship statements find
/// their endpoints already present. Shard files are derived from the graph the same
/// way [`export`](super::export) shards it — one `nodes/<label>.tsv` per primary
/// label, one `edges/<type>.tsv` per `:TYPE` — both sorted.
pub fn build_statements(
    schema: &CanonicalSchema,
    graph: &Graph,
) -> Result<Vec<CypherStatement>, Error> {
    let node_cy = node_cypher(&schema.node_columns)?;
    let edge_cy = edge_cypher(&schema.edge_columns)?;

    let mut node_labels: Vec<String> = Vec::new();
    for row in &graph.nodes {
        let label = primary_label(row)?;
        if !node_labels.contains(&label) {
            node_labels.push(label);
        }
    }
    node_labels.sort();

    let mut edge_types: Vec<String> = Vec::new();
    for row in &graph.edges {
        let ty = edge_type(row)?;
        if !edge_types.contains(&ty) {
            edge_types.push(ty);
        }
    }
    edge_types.sort();

    let mut statements: Vec<CypherStatement> = node_labels
        .into_iter()
        .map(|label| CypherStatement {
            kind: "node".to_string(),
            file: format!("nodes/{label}.tsv"),
            cypher: node_cy.clone(),
        })
        .collect();
    statements.extend(edge_types.into_iter().map(|ty| CypherStatement {
        kind: "edge".to_string(),
        file: format!("edges/{ty}.tsv"),
        cypher: edge_cy.clone(),
    }));
    Ok(statements)
}

/// Render `statements` as a runnable `cypher-shell` script (`render_script`).
///
/// Each statement is preceded by a `:param` line binding `$file` to its shard path,
/// so the whole script can be piped to `cypher-shell -f`.
pub fn render_load_script(statements: &[CypherStatement]) -> String {
    let blocks: Vec<String> = statements
        .iter()
        .map(|stmt| {
            format!(
                "// {kind}: {file}\n:param {FILE_PARAM} => '{file}';\n{cypher}",
                kind = stmt.kind,
                file = stmt.file,
                cypher = stmt.cypher,
            )
        })
        .collect();
    format!(
        "// Generated by agora translation engine: incrementally MERGE canonical data \
into Neo4j.\n\
         // Idempotent — re-running does not duplicate nodes or relationships.\n\
         // Requires the APOC plugin. Run with: cypher-shell -f {SCRIPT_NAME}\n\n\
         {}\n",
        blocks.join("\n\n"),
    )
}

/// Convenience: build the statements for `graph` and render the load script.
pub fn graph_to_load_script(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    Ok(render_load_script(&build_statements(schema, graph)?))
}
