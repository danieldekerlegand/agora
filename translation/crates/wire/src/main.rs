//! `agora-translation-port` — the Erlang port program over [`translation_wire`].
//!
//! The provider-router (agora:80) is an OTP application; this is how it reaches the Rust
//! translator on a request's hot path. A **port**, not a NIF, and deliberately: the router's
//! whole design is that no rung can take down the node, and an OS process cannot. A panic, a
//! segfault or a hang here costs one pipe and one restart; the router records the attempt and
//! walks to the next rung exactly as it would for an unreachable vendor. A NIF would put this
//! code inside the BEAM's address space, where "fail-safe" would be a claim rather than a
//! structural fact.
//!
//! # Protocol
//!
//! One length-prefixed JSON frame in, one out — Erlang's `{packet, 4}` framing (a 4-byte
//! big-endian length, then that many bytes). Requests are answered strictly in order:
//!
//! ```text
//! {"op":"to_native",  "provider":"anthropic","modality":"text","model":"…","body":{…}}
//!   -> {"ok":true,"path":"/messages","body":{…}}
//! {"op":"from_native","provider":"anthropic","modality":"text","model":"…",
//!  "created":1700000000,"body":{…}}
//!   -> {"ok":true,"body":{…}}
//! anything unconvertible
//!   -> {"ok":false,"error":"…"}
//! ```
//!
//! `created` is supplied by the caller rather than read from a clock here, so the whole
//! program is a pure function of its input and a conformance run is reproducible.
//!
//! An `{"ok":false}` frame is a *reply*, not a failure: the router turns it into a recorded
//! attempt. The process only exits when its stdin closes, which is how the BEAM says the
//! router is done with it.

use std::io::{self, Read, Write};
use translation_wire::{from_native, to_native};

fn main() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    while let Some(frame) = read_frame(&mut stdin) {
        // A panic in a conversion must cost one frame, not the pipe: the router would see a
        // dead port, and a dead port is a fallthrough it could otherwise have avoided.
        let reply = std::panic::catch_unwind(|| answer(&frame))
            .unwrap_or_else(|_| error_frame("the translator panicked converting this request"));
        if write_frame(&mut stdout, reply.as_bytes()).is_err() {
            return;
        }
    }
}

/// Answer one request frame. Never panics on input it can read; a malformed frame is an
/// `{"ok":false}` reply like any other refusal.
fn answer(frame: &[u8]) -> String {
    let request: serde_json::Value = match serde_json::from_slice(frame) {
        Ok(value) => value,
        Err(err) => return error_frame(&format!("unreadable request frame: {err}")),
    };
    let op = string_at(&request, "op");
    let provider = string_at(&request, "provider");
    let modality = string_at(&request, "modality");
    let model = string_at(&request, "model");
    let empty = serde_json::Value::Null;
    let body = request.get("body").unwrap_or(&empty);

    match op {
        "to_native" => match to_native(provider, modality, model, body) {
            Ok(native) => format!(
                "{{\"ok\":true,\"path\":{},\"body\":{}}}",
                quote(&native.path),
                native.body
            ),
            Err(err) => error_frame(&err.to_string()),
        },
        "from_native" => {
            let created = request.get("created").and_then(|c| c.as_i64()).unwrap_or(0);
            match from_native(provider, modality, model, created, body) {
                Ok(rendered) => format!("{{\"ok\":true,\"body\":{rendered}}}"),
                Err(err) => error_frame(&err.to_string()),
            }
        }
        other => error_frame(&format!("unknown op `{other}`")),
    }
}

fn error_frame(message: &str) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", quote(message))
}

/// A JSON string literal. `serde_json` owns the escaping so a vendor's own error text — which
/// may carry quotes, newlines or non-ASCII — cannot break the frame.
fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

fn string_at<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// Read one `{packet, 4}` frame. `None` at end of stdin — a clean shutdown, not an error.
fn read_frame(input: &mut impl Read) -> Option<Vec<u8>> {
    let mut header = [0u8; 4];
    input.read_exact(&mut header).ok()?;
    let length = u32::from_be_bytes(header) as usize;
    let mut frame = vec![0u8; length];
    input.read_exact(&mut frame).ok()?;
    Some(frame)
}

fn write_frame(output: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "reply exceeds a 4-byte length"))?;
    output.write_all(&length.to_be_bytes())?;
    output.write_all(payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> serde_json::Value {
        serde_json::from_str(text).expect("a reply frame is JSON")
    }

    #[test]
    fn a_conversion_out_reports_the_path_beside_the_body() {
        let reply = answer(
            br#"{"op":"to_native","provider":"anthropic","modality":"text","model":"m",
                 "body":{"prompt":"hi"}}"#,
        );
        let value = parsed(&reply);
        assert_eq!(value["ok"], serde_json::json!(true));
        assert_eq!(value["path"], serde_json::json!("/messages"));
        assert_eq!(value["body"]["messages"][0]["content"], serde_json::json!("hi"));
    }

    #[test]
    fn a_conversion_back_keeps_the_openai_envelope_order() {
        let reply = answer(
            br#"{"op":"from_native","provider":"anthropic","modality":"text","model":"m",
                 "created":42,"body":{"id":"msg_1","content":[{"type":"text","text":"hi"}]}}"#,
        );
        assert!(reply.starts_with(r#"{"ok":true,"body":{"id":"msg_1","object":"chat.completion""#));
        assert_eq!(parsed(&reply)["body"]["created"], serde_json::json!(42));
    }

    #[test]
    fn every_refusal_is_a_reply_rather_than_a_dead_pipe() {
        for frame in [
            &br#"not json at all"#[..],
            &br#"{"op":"sideways","provider":"anthropic","modality":"text"}"#[..],
            &br#"{"op":"to_native","provider":"openai","modality":"text","body":{}}"#[..],
            &br#"{"op":"to_native","provider":"anthropic","modality":"text","body":{}}"#[..],
        ] {
            let value = parsed(&answer(frame));
            assert_eq!(value["ok"], serde_json::json!(false), "frame: {frame:?}");
            assert!(value["error"].as_str().is_some_and(|e| !e.is_empty()));
        }
    }

    #[test]
    fn a_vendor_error_survives_quoting_intact() {
        let reply = answer(
            br#"{"op":"from_native","provider":"replicate","modality":"image","model":"m",
                 "body":{"error":"bad \"prompt\"\nline two"}}"#,
        );
        let value = parsed(&reply);
        assert_eq!(value["ok"], serde_json::json!(false));
        assert_eq!(value["error"], serde_json::json!("bad \"prompt\"\nline two"));
    }

    #[test]
    fn frames_round_trip_through_the_packet_4_framing() {
        let mut written: Vec<u8> = Vec::new();
        write_frame(&mut written, b"hello").unwrap();
        assert_eq!(&written[..4], &[0, 0, 0, 5]);
        let mut cursor = io::Cursor::new(written);
        assert_eq!(read_frame(&mut cursor).unwrap(), b"hello");
        assert_eq!(read_frame(&mut cursor), None);
    }
}
