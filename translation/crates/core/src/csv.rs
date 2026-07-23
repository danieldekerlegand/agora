//! The Neo4j-import CSV codec — the tabular form as comma-separated values.
//!
//! Neo4j's bulk importer speaks CSV; culture-scrape pins the *field* separator to a
//! tab (`schema/tsvio.py`, `admin_import.py`'s `--delimiter='\t'`) so a value's
//! commas never fight the delimiter, but the header conventions are Neo4j's CSV
//! conventions verbatim (`csid:ID` / `:LABEL` for nodes, `:START_ID` / `:END_ID` /
//! `:TYPE` for edges). This module is the comma-delimited sibling of [`crate::tsv`]:
//! the same canonical header, the same multi-value `;` join, the same lossless value
//! escape — but written with the `,` field separator and RFC-4180 field quoting so a
//! canonical graph round-trips through standard CSV losslessly.
//!
//! Losslessness is layered: a cell is first passed through the TSV value escape
//! (backslash / TAB / CR / LF → `\\` / `\t` / `\r` / `\n`, and `\;` for a literal
//! `;` inside a multi-value part), which leaves a single physical line with no raw
//! control characters; RFC-4180 quoting then wraps only the fields that still carry
//! a `,` or a `"`. Reading reverses both layers exactly, so `read(write(x)) == x`
//! and a corpus seeded from CSV re-exports byte-for-byte — closing the
//! `admin_import.py` / `load_csv.py` round trip in Rust.

use crate::error::Error;
use crate::graph::{Cell, Graph, Row};
use crate::schema::{CanonicalSchema, Column};
use crate::tsv::{decode_value, decode_values, encode_value, encode_values, sorted_by, MULTI_VALUE_KEYS};
use std::io::Write;

/// The CSV field separator (Neo4j's default import delimiter).
const CSV_DELIMITER: char = ',';

/// Quote `field` per RFC 4180 when it carries a separator, a quote, or a line break.
///
/// `field` has already been through the TSV value escape, so it holds no raw TAB /
/// CR / LF; only a literal `,` or `"` can still need quoting. A quoted field doubles
/// every embedded `"`.
fn quote_field(field: &str) -> String {
    if field.contains(CSV_DELIMITER)
        || field.contains('"')
        || field.contains('\n')
        || field.contains('\r')
    {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// Encode one row `cell` for `key`, honouring multi-value columns, then CSV-quote it.
fn encode_csv_cell(key: &str, cell: &Cell) -> Result<String, Error> {
    let escaped = if MULTI_VALUE_KEYS.contains(&key) {
        encode_values(cell.as_multi(key)?)
    } else {
        encode_value(cell.as_scalar(key)?)
    };
    Ok(quote_field(&escaped))
}

/// Join `cells` with the CSV delimiter and terminate the physical line.
fn write_csv_line<W: Write>(sink: &mut W, cells: &[String]) -> Result<(), Error> {
    sink.write_all(cells.join(",").as_bytes())?;
    sink.write_all(b"\n")?;
    Ok(())
}

/// Write `rows` to `sink` under `columns` as CSV, returning the number written.
///
/// The header (`columns` rendered in order) is the first physical line; each row is a
/// map from a column key to its value, a missing key writing an empty cell. Rows are
/// consumed lazily and emitted one at a time, so peak memory is O(1) in the row count.
pub fn write_csv_rows<'a, W, I>(sink: &mut W, columns: &[Column], rows: I) -> Result<usize, Error>
where
    W: Write,
    I: IntoIterator<Item = &'a Row>,
{
    let keys: Vec<&str> = columns.iter().map(|c| c.key()).collect();
    let header: Vec<String> = columns.iter().map(|c| quote_field(&c.header())).collect();
    write_csv_line(sink, &header)?;
    let mut count = 0;
    for row in rows {
        let mut cells: Vec<String> = Vec::with_capacity(keys.len());
        for key in &keys {
            match row.get(*key) {
                Some(cell) => cells.push(encode_csv_cell(key, cell)?),
                None => cells.push(String::new()),
            }
        }
        write_csv_line(sink, &cells)?;
        count += 1;
    }
    Ok(count)
}

/// Write node `rows` sorted by the id column in canonical order (see [`write_csv_rows`]).
pub fn write_csv_node_rows<W: Write>(
    sink: &mut W,
    node_columns: &[Column],
    id_key: &str,
    rows: &[Row],
) -> Result<usize, Error> {
    let ordered = sorted_by(rows, &[id_key])?;
    write_csv_rows(sink, node_columns, ordered)
}

/// Write edge `rows` sorted by `(:START_ID, :END_ID, :TYPE)`.
pub fn write_csv_edge_rows<W: Write>(
    sink: &mut W,
    edge_columns: &[Column],
    rows: &[Row],
) -> Result<usize, Error> {
    let ordered = sorted_by(rows, &[":START_ID", ":END_ID", ":TYPE"])?;
    write_csv_rows(sink, edge_columns, ordered)
}

/// Parse one physical CSV line into its raw (unquoted) fields.
///
/// A quoted field runs to the next lone `"` (a doubled `""` being one literal quote);
/// an unquoted field runs to the next delimiter. A trailing delimiter yields a final
/// empty field, matching the writer's empty-cell handling.
fn parse_csv_line(line: &str) -> Result<Vec<String>, Error> {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut fields: Vec<String> = Vec::new();
    let mut i = 0;
    loop {
        let mut buf = String::new();
        if i < n && chars[i] == '"' {
            i += 1;
            loop {
                match chars.get(i) {
                    None => {
                        return Err(Error::Tsv(format!("unterminated quoted field in {line:?}")))
                    }
                    Some('"') => {
                        if chars.get(i + 1) == Some(&'"') {
                            buf.push('"');
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    }
                    Some(&c) => {
                        buf.push(c);
                        i += 1;
                    }
                }
            }
            if i < n && chars[i] != CSV_DELIMITER {
                return Err(Error::Tsv(format!(
                    "unexpected {:?} after quoted field in {line:?}",
                    chars[i]
                )));
            }
        } else {
            while i < n && chars[i] != CSV_DELIMITER {
                buf.push(chars[i]);
                i += 1;
            }
        }
        fields.push(buf);
        if i < n && chars[i] == CSV_DELIMITER {
            i += 1;
        } else {
            break;
        }
    }
    Ok(fields)
}

/// Read CSV `text` written by [`write_csv_rows`] back to columns and rows.
///
/// The first physical line is parsed into columns; each subsequent line is unquoted
/// field by field and each field decoded back through the TSV value escape.
pub fn read_csv(text: &str) -> Result<(Vec<Column>, Vec<Row>), Error> {
    if text.is_empty() {
        return Err(Error::Tsv("no header line".into()));
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut iter = lines.into_iter();
    let header = iter
        .next()
        .ok_or_else(|| Error::Tsv("no header line".into()))?;
    let columns = parse_csv_line(header)?
        .iter()
        .map(|cell| crate::schema::parse_column(cell))
        .collect::<Result<Vec<_>, _>>()?;
    let keys: Vec<&str> = columns.iter().map(|c| c.key()).collect();

    let mut rows = Vec::new();
    for (offset, raw) in iter.enumerate() {
        let lineno = offset + 2;
        let cells = parse_csv_line(raw)?;
        if cells.len() != keys.len() {
            return Err(Error::Tsv(format!(
                "line {lineno} has {} cells, expected {}",
                cells.len(),
                keys.len()
            )));
        }
        let mut row = Row::new();
        for (key, cell) in keys.iter().zip(cells.iter()) {
            let value = if MULTI_VALUE_KEYS.contains(key) {
                Cell::Multi(decode_values(cell)?)
            } else {
                Cell::Scalar(decode_value(cell)?)
            };
            row.insert((*key).to_string(), value);
        }
        rows.push(row);
    }
    Ok((columns, rows))
}

/// Render a graph's nodes to canonical CSV (sorted by the id column).
pub fn nodes_to_csv(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    let id_key = schema.node_id_key()?;
    let mut buf: Vec<u8> = Vec::new();
    write_csv_node_rows(&mut buf, &schema.node_columns, id_key, &graph.nodes)?;
    Ok(String::from_utf8(buf).expect("CSV output is UTF-8"))
}

/// Render a graph's edges to canonical CSV (sorted by `(:START_ID, :END_ID, :TYPE)`).
pub fn edges_to_csv(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    let mut buf: Vec<u8> = Vec::new();
    write_csv_edge_rows(&mut buf, &schema.edge_columns, &graph.edges)?;
    Ok(String::from_utf8(buf).expect("CSV output is UTF-8"))
}

/// Load a graph from its node and edge CSV files (the inverse of [`nodes_to_csv`] /
/// [`edges_to_csv`]).
pub fn graph_from_csv(nodes_csv: &str, edges_csv: &str) -> Result<Graph, Error> {
    let (_, nodes) = read_csv(nodes_csv)?;
    let (_, edges) = read_csv(edges_csv)?;
    Ok(Graph { nodes, edges })
}
