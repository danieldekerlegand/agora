//! Lossless tab-delimited row IO — a faithful port of `schema/tsvio.py`.
//!
//! TSV is the source of truth, so writing a field that itself contains a tab,
//! newline, or backslash must never corrupt the file. The writer applies a
//! deterministic escape that the reader reverses *exactly*:
//!
//! ```text
//! \    ->  \\
//! TAB  ->  \t
//! CR   ->  \r
//! LF   ->  \n
//! ```
//!
//! Multi-value columns (`:LABEL`, `aliases`) join their parts with `;`; a literal
//! `;` inside a part is escaped as `\;`. Decoding is a single left-to-right scan so
//! an escaped backslash is never mistaken for the start of another escape (`\\t`
//! decodes to a literal `\t`, never to a tab). The header is always the first
//! physical line, and rows are emitted in canonical sort order so the same logical
//! row set yields byte-identical output.

use crate::error::Error;
use crate::graph::{Cell, Row};
use crate::schema::{Column, DELIMITER};
use std::io::Write;

/// The multi-value delimiter that separates parts of a `:LABEL` / `aliases` cell.
const MULTI_DELIMITER: char = ';';

/// The single escape character.
const ESCAPE: char = '\\';

/// Column keys whose cell holds a `;`-separated list rather than a scalar.
pub const MULTI_VALUE_KEYS: &[&str] = &[":LABEL", "aliases"];

fn is_multi_value(key: &str) -> bool {
    MULTI_VALUE_KEYS.contains(&key)
}

/// Escape one scalar so it survives a single tab-delimited cell (`encode_value`).
pub fn encode_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        push_escaped(&mut out, ch, false);
    }
    out
}

/// Encode `values` into one `;`-separated cell, escaping a literal `;` inside a
/// part as `\;` (`encode_values`).
pub fn encode_values(values: &[String]) -> String {
    let mut out = String::new();
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(MULTI_DELIMITER);
        }
        for ch in value.chars() {
            push_escaped(&mut out, ch, true);
        }
    }
    out
}

/// Append `ch` to `out`, escaped. When `multi`, the multi-value delimiter `;` is
/// also escaped (matching Python's `_ENCODE_MULTI`).
fn push_escaped(out: &mut String, ch: char, multi: bool) {
    match ch {
        '\\' => out.push_str("\\\\"),
        '\t' => out.push_str("\\t"),
        '\r' => out.push_str("\\r"),
        '\n' => out.push_str("\\n"),
        ';' if multi => out.push_str("\\;"),
        _ => out.push(ch),
    }
}

/// Map the character *after* a `\` back to its literal, mirroring `_DECODE`.
fn decode_escape(ch: char) -> Option<char> {
    match ch {
        '\\' => Some('\\'),
        't' => Some('\t'),
        'r' => Some('\r'),
        'n' => Some('\n'),
        ';' => Some(';'),
        _ => None,
    }
}

/// Reverse [`encode_value`] via a single left-to-right scan (`_unescape`).
fn unescape(text: &[char]) -> Result<String, Error> {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let n = text.len();
    while i < n {
        let ch = text[i];
        if ch == ESCAPE {
            if i + 1 >= n {
                return Err(Error::Tsv(format!(
                    "dangling escape at end of {:?}",
                    text.iter().collect::<String>()
                )));
            }
            let nxt = text[i + 1];
            match decode_escape(nxt) {
                Some(literal) => out.push(literal),
                None => {
                    return Err(Error::Tsv(format!(
                        "invalid escape '\\{nxt}' in {:?}",
                        text.iter().collect::<String>()
                    )))
                }
            }
            i += 2;
        } else {
            out.push(ch);
            i += 1;
        }
    }
    Ok(out)
}

/// Reverse [`encode_value`], recovering the original scalar string.
pub fn decode_value(cell: &str) -> Result<String, Error> {
    let chars: Vec<char> = cell.chars().collect();
    unescape(&chars)
}

/// Reverse [`encode_values`], splitting on *unescaped* `;` only. An empty cell
/// decodes to an empty list (the canonical form of "no values").
pub fn decode_values(cell: &str) -> Result<Vec<String>, Error> {
    if cell.is_empty() {
        return Ok(Vec::new());
    }
    let chars: Vec<char> = cell.chars().collect();
    let n = chars.len();
    let mut parts: Vec<Vec<char>> = Vec::new();
    let mut buf: Vec<char> = Vec::new();
    let mut i = 0;
    while i < n {
        let ch = chars[i];
        if ch == ESCAPE && i + 1 < n {
            // Keep the escape pair intact; unescape resolves it per part.
            buf.push(ch);
            buf.push(chars[i + 1]);
            i += 2;
        } else if ch == MULTI_DELIMITER {
            parts.push(std::mem::take(&mut buf));
            i += 1;
        } else {
            buf.push(ch);
            i += 1;
        }
    }
    parts.push(buf);
    parts.iter().map(|part| unescape(part)).collect()
}

/// Encode one row `value` for `key`, honouring multi-value columns (`_encode_cell`).
fn encode_cell(key: &str, cell: &Cell) -> Result<String, Error> {
    if is_multi_value(key) {
        Ok(encode_values(cell.as_multi(key)?))
    } else {
        Ok(encode_value(cell.as_scalar(key)?))
    }
}

/// Write `rows` to `sink` under `columns`, returning the number written.
///
/// The header (`columns` rendered in order) is always the first line. Each row is a
/// map from a column key to its value; a missing key writes an empty cell. Rows are
/// consumed lazily from the iterator and emitted one at a time, so peak memory is
/// O(1) in the row count.
pub fn write_rows<'a, W, I>(sink: &mut W, columns: &[Column], rows: I) -> Result<usize, Error>
where
    W: Write,
    I: IntoIterator<Item = &'a Row>,
{
    let keys: Vec<&str> = columns.iter().map(|c| c.key()).collect();
    let header: Vec<String> = columns.iter().map(|c| c.header()).collect();
    write_line(sink, &header)?;
    let mut count = 0;
    for row in rows {
        let mut cells: Vec<String> = Vec::with_capacity(keys.len());
        for key in &keys {
            match row.get(*key) {
                Some(cell) => cells.push(encode_cell(key, cell)?),
                None => cells.push(String::new()),
            }
        }
        write_line(sink, &cells)?;
        count += 1;
    }
    Ok(count)
}

/// Join `cells` with the delimiter and terminate the physical line.
fn write_line<W: Write>(sink: &mut W, cells: &[String]) -> Result<(), Error> {
    let mut sep = String::new();
    sep.push(DELIMITER);
    sink.write_all(cells.join(&sep).as_bytes())?;
    sink.write_all(b"\n")?;
    Ok(())
}

/// The ordering tuple for `row` over the scalar `keys` (missing -> `""`).
fn sort_key(row: &Row, keys: &[&str]) -> Result<Vec<String>, Error> {
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        match row.get(*key) {
            Some(cell) => out.push(cell.as_scalar(key)?.to_string()),
            None => out.push(String::new()),
        }
    }
    Ok(out)
}

/// Sort `rows` by `keys` with a stable order, mirroring Python's `sorted`.
///
/// Shared with the datalog projection (US-2), whose fact stream must visit rows in
/// the same canonical order the TSV writers emit.
pub(crate) fn sorted_by<'a>(rows: &'a [Row], keys: &[&str]) -> Result<Vec<&'a Row>, Error> {
    let mut indexed: Vec<(Vec<String>, usize)> = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        indexed.push((sort_key(row, keys)?, i));
    }
    // Stable sort on the key; ties keep input order (index), matching `sorted`.
    indexed.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(indexed.into_iter().map(|(_, i)| &rows[i]).collect())
}

/// Write node `rows` sorted by the id column in the schema's canonical order.
///
/// Sorting makes the file a deterministic function of the logical row set: writing
/// the same rows in any order yields byte-identical output.
pub fn write_node_rows<W: Write>(
    sink: &mut W,
    node_columns: &[Column],
    id_key: &str,
    rows: &[Row],
) -> Result<usize, Error> {
    let ordered = sorted_by(rows, &[id_key])?;
    write_rows(sink, node_columns, ordered)
}

/// Write edge `rows` sorted by `(:START_ID, :END_ID, :TYPE)`.
pub fn write_edge_rows<W: Write>(
    sink: &mut W,
    edge_columns: &[Column],
    rows: &[Row],
) -> Result<usize, Error> {
    let ordered = sorted_by(rows, &[":START_ID", ":END_ID", ":TYPE"])?;
    write_rows(sink, edge_columns, ordered)
}

/// Drop the single trailing `\n` a physical line carries, if any (`_strip_eol`).
fn strip_eol(line: &str) -> &str {
    line.strip_suffix('\n').unwrap_or(line)
}

/// Read the TSV `text` written by [`write_rows`] back to columns and rows.
///
/// The header line is parsed into columns; each subsequent physical line is decoded
/// into a [`Row`]. Physical newlines separate rows and physical tabs separate
/// columns; because the writer escapes both inside values, the split is unambiguous.
pub fn read_rows(text: &str) -> Result<(Vec<Column>, Vec<Row>), Error> {
    if text.is_empty() {
        return Err(Error::Tsv("no header line".into()));
    }
    // `split('\n')` over writer output yields a trailing "" for the final newline,
    // which Python's line iteration never surfaces as a row — drop exactly that one.
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut iter = lines.into_iter();
    let header = iter
        .next()
        .ok_or_else(|| Error::Tsv("no header line".into()))?;
    let columns = header
        .split(DELIMITER)
        .map(crate::schema::parse_column)
        .collect::<Result<Vec<_>, _>>()?;
    let keys: Vec<&str> = columns.iter().map(|c| c.key()).collect();

    let mut rows = Vec::new();
    for (offset, raw) in iter.enumerate() {
        let lineno = offset + 2;
        let cells: Vec<&str> = strip_eol(raw).split(DELIMITER).collect();
        if cells.len() != keys.len() {
            return Err(Error::Tsv(format!(
                "line {lineno} has {} cells, expected {}",
                cells.len(),
                keys.len()
            )));
        }
        let mut row = Row::new();
        for (key, cell) in keys.iter().zip(cells.iter()) {
            let value = if is_multi_value(key) {
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
