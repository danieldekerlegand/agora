//! The one error type for the translation core.

use std::fmt;

/// A translation error. Mirrors culture-scrape's `TsvError` / `SchemaError` split,
/// collapsed to one enum so the whole matrix returns a single `Result` type.
#[derive(Debug)]
pub enum Error {
    /// A value or line could not be encoded/decoded losslessly (`TsvError`).
    Tsv(String),
    /// A header row or schema violated the data model (`SchemaError`).
    Schema(String),
    /// A fact or atom could not be projected/rendered to a logic program
    /// (`DatalogError` / `ProblogError` in culture-scrape).
    Datalog(String),
    /// Graph data could not be mapped back to canonical TSV on a Neo4j cursor
    /// export (`Neo4jExportError` in culture-scrape).
    Neo4j(String),
    /// A document on the media-timeline path is not a KMI-conformant OTIO timeline
    /// (media-interchange.md §4). Never a *conversion* failure — converting is OTIO's
    /// adapters' work, and their errors are OTIO's own.
    Media(String),
    /// An underlying IO failure while writing to a sink.
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Tsv(msg) => write!(f, "tsv error: {msg}"),
            Error::Schema(msg) => write!(f, "schema error: {msg}"),
            Error::Datalog(msg) => write!(f, "datalog error: {msg}"),
            Error::Neo4j(msg) => write!(f, "neo4j error: {msg}"),
            Error::Media(msg) => write!(f, "media error: {msg}"),
            Error::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err)
    }
}
