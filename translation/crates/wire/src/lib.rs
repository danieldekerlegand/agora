//! OpenAI wire <-> native vendor wire, for the provider-router's hot path.
//!
//! agora's provider-router speaks one dialect — OpenAI's — down every rung of the sacred
//! ladder, because one dispatch path is what makes "always completes" auditable. Seven paid
//! vendors do not answer in that dialect: `anthropic`, `gemini`, `replicate`, `elevenlabs`,
//! `runway`, `luma` and `minimax` each publish their own request and response shapes. Before
//! this crate the router recognised them and *fell through* — `pending-adapter`, a rung it
//! would not dial with a wire format the vendor does not speak.
//!
//! This is that adapter, and it lives in Rust for the reason the whole translation engine
//! does: it is CPU-bound serde on a request path, called once out and once back per
//! generation. It is a **pure function of the payload** — no clock, no filesystem, no
//! network. The caller supplies `created` so the same inputs always render the same bytes.
//!
//! # Key order is part of the output
//!
//! Every rendered document goes out as an ordered JSON *string*, serialized from a typed
//! struct so serde emits fields in declaration order. `serde_json::Value` sorts its keys, and
//! a response the router relays to its caller verbatim must keep the envelope order an
//! OpenAI client sees from OpenAI itself. So: `Value` on the way in (reads are
//! order-insensitive), a `Serialize` struct on the way out.
//!
//! # The two directions
//!
//! * [`to_native`] takes an OpenAI-shaped request and returns a [`NativeRequest`] — the body
//!   *and* the vendor-relative path it must be POSTed to, since where a request goes is as
//!   much a part of a vendor's wire format as what it looks like.
//! * [`from_native`] takes the vendor's response and returns the OpenAI envelope for the
//!   modality: a `chat.completion` for text, a `<modality>.generation` for media — the same
//!   shapes the router's own placeholder tier emits, so a caller cannot tell the tier from
//!   the envelope.
//!
//! An unsupported pair, a malformed request or an unreadable vendor response is an `Err`,
//! never a panic and never a partial document. The router treats one exactly as it treats an
//! unreachable rung: it records the attempt and walks on.

#![deny(clippy::all)]

use serde::Serialize;
use serde_json::Value;
use std::fmt;

/// The vendors whose HTTP surface is not OpenAI-shaped (`backends.py`'s `wire = "native"`).
pub const NATIVE_PROVIDERS: [&str; 7] = [
    "anthropic",
    "gemini",
    "replicate",
    "elevenlabs",
    "runway",
    "luma",
    "minimax",
];

/// The ElevenLabs voice a speech request is addressed to when it names none. ElevenLabs
/// routes by voice in the *path*, so there is no such thing as an unaddressed request.
const DEFAULT_ELEVENLABS_VOICE: &str = "21m00Tcm4TlvDq8ikWAM";

/// What Anthropic requires and OpenAI leaves optional: a completion budget.
const DEFAULT_MAX_TOKENS: u64 = 1024;

/// A request in a vendor's own wire format: the path it is POSTed to, relative to the
/// vendor's base URL, and the serialized body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRequest {
    /// Vendor-relative path, e.g. `/messages`. Always begins with `/`.
    pub path: String,
    /// The serialized native body, in vendor key order.
    pub body: String,
}

/// A conversion that could not be completed. Carries a reason the router can put on an
/// attempt record verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    message: String,
}

impl WireError {
    fn new(message: impl Into<String>) -> Self {
        WireError {
            message: message.into(),
        }
    }

    /// The reason, as it will be reported.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WireError {}

/// The crate's result type.
pub type Result<T> = std::result::Result<T, WireError>;

/// Whether `(provider, modality)` has an adapter. The router asks before it resolves a rung:
/// a native vendor with no adapter for the modality stays `pending-adapter`.
pub fn supports(provider: &str, modality: &str) -> bool {
    matches!(
        (provider, modality),
        ("anthropic", "text")
            | ("gemini", "text")
            | ("replicate", "image")
            | ("replicate", "music")
            | ("elevenlabs", "speech")
            | ("runway", "video")
            | ("luma", "video")
            | ("minimax", "video")
    )
}

/// Translate an OpenAI-shaped request out to `provider`'s native wire.
pub fn to_native(provider: &str, modality: &str, model: &str, body: &Value) -> Result<NativeRequest> {
    match (provider, modality) {
        ("anthropic", "text") => anthropic_request(model, body),
        ("gemini", "text") => gemini_request(model, body),
        ("replicate", "image") | ("replicate", "music") => replicate_request(model, body),
        ("elevenlabs", "speech") => elevenlabs_request(model, body),
        ("runway", "video") => runway_request(model, body),
        ("luma", "video") => luma_request(model, body),
        ("minimax", "video") => minimax_request(model, body),
        _ => Err(unsupported(provider, modality)),
    }
}

/// Translate `provider`'s native response back into the OpenAI envelope for `modality`.
///
/// `created` is the Unix timestamp the envelope reports; the caller supplies it so this stays
/// a pure function.
pub fn from_native(
    provider: &str,
    modality: &str,
    model: &str,
    created: i64,
    body: &Value,
) -> Result<String> {
    match (provider, modality) {
        ("anthropic", "text") => anthropic_response(model, created, body),
        ("gemini", "text") => gemini_response(model, created, body),
        ("replicate", "image") | ("replicate", "music") => {
            replicate_response(modality, model, created, body)
        }
        ("elevenlabs", "speech") => elevenlabs_response(model, created, body),
        ("runway", "video") => runway_response(model, created, body),
        ("luma", "video") => luma_response(model, created, body),
        ("minimax", "video") => minimax_response(model, created, body),
        _ => Err(unsupported(provider, modality)),
    }
}

fn unsupported(provider: &str, modality: &str) -> WireError {
    WireError::new(format!("no {modality} adapter for {provider}'s native wire format"))
}

// --- the OpenAI envelopes ----------------------------------------------------
//
// Declaration order IS the emitted key order, and it mirrors `placeholder.py` — the router's
// two ends of the ladder must be indistinguishable from the outside.

#[derive(Serialize)]
struct ChatCompletion<'a> {
    id: String,
    object: &'static str,
    created: i64,
    model: &'a str,
    choices: Vec<ChatChoice>,
    usage: Usage,
}

#[derive(Serialize)]
struct ChatChoice {
    index: u32,
    message: ChatMessage,
    finish_reason: String,
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Serialize)]
struct Usage {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}

#[derive(Serialize)]
struct MediaResponse<'a> {
    id: String,
    object: String,
    created: i64,
    model: &'a str,
    data: Vec<MediaItem>,
}

#[derive(Serialize)]
struct MediaItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    b64_json: Option<String>,
    media_type: &'static str,
}

fn chat_completion(
    id: String,
    model: &str,
    created: i64,
    content: String,
    finish_reason: String,
    usage: Usage,
) -> Result<String> {
    render(&ChatCompletion {
        id,
        object: "chat.completion",
        created,
        model,
        choices: vec![ChatChoice {
            index: 0,
            message: ChatMessage {
                role: "assistant",
                content,
            },
            finish_reason,
        }],
        usage,
    })
}

fn media_response(
    modality: &str,
    id: String,
    model: &str,
    created: i64,
    items: Vec<MediaItem>,
) -> Result<String> {
    if items.is_empty() {
        return Err(WireError::new(format!(
            "the vendor's {modality} response carried no artifact"
        )));
    }
    render(&MediaResponse {
        id,
        object: format!("{modality}.generation"),
        created,
        model,
        data: items,
    })
}

fn media_type(modality: &str) -> &'static str {
    match modality {
        "image" => "image/png",
        "speech" => "audio/mpeg",
        "music" => "audio/wav",
        "video" => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn url_item(modality: &str, url: String) -> MediaItem {
    MediaItem {
        url: Some(url),
        b64_json: None,
        media_type: media_type(modality),
    }
}

// --- anthropic (text) --------------------------------------------------------

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

#[derive(Serialize)]
struct AnthropicMessage {
    role: &'static str,
    content: String,
}

fn anthropic_request(model: &str, body: &Value) -> Result<NativeRequest> {
    let chat = read_chat(body)?;
    let messages = chat
        .turns
        .iter()
        .map(|turn| AnthropicMessage {
            role: assistant_or_user(&turn.role),
            content: turn.text.clone(),
        })
        .collect();
    Ok(NativeRequest {
        path: "/messages".to_string(),
        body: render(&AnthropicRequest {
            model,
            max_tokens: chat.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            system: chat.system,
            messages,
            temperature: chat.temperature,
        })?,
    })
}

fn anthropic_response(model: &str, created: i64, body: &Value) -> Result<String> {
    let content = text_parts(body.get("content"), "text", "text")
        .ok_or_else(|| vendor_error(body, "anthropic returned no content block"))?;
    let usage = body.get("usage");
    let prompt = u64_at(usage, "input_tokens").unwrap_or(0);
    let completion = u64_at(usage, "output_tokens").unwrap_or(0);
    chat_completion(
        str_at(body, "id").unwrap_or("chatcmpl-anthropic").to_string(),
        model,
        created,
        content,
        finish_reason(str_at(body, "stop_reason")),
        Usage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
        },
    )
}

/// Anthropic's `stop_reason` and Gemini's `finishReason`, spelled the way an OpenAI client
/// reads them. Anything unrecognised is `stop`: a completion that arrived did finish.
fn finish_reason(raw: Option<&str>) -> String {
    match raw.unwrap_or("") {
        "max_tokens" | "MAX_TOKENS" | "length" => "length",
        "tool_use" | "TOOL_CALLS" => "tool_calls",
        "SAFETY" | "RECITATION" | "content_filter" => "content_filter",
        _ => "stop",
    }
    .to_string()
}

// --- gemini (text) -----------------------------------------------------------

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "systemInstruction", skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GeminiConfig,
}

#[derive(Serialize)]
struct GeminiContent {
    role: &'static str,
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiConfig {
    #[serde(rename = "maxOutputTokens", skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

fn gemini_request(model: &str, body: &Value) -> Result<NativeRequest> {
    let chat = read_chat(body)?;
    let contents = chat
        .turns
        .iter()
        .map(|turn| GeminiContent {
            // Gemini calls the assistant "model"; every other role is the user's side.
            role: if turn.role == "assistant" { "model" } else { "user" },
            parts: vec![GeminiPart {
                text: turn.text.clone(),
            }],
        })
        .collect();
    Ok(NativeRequest {
        path: format!("/models/{model}:generateContent"),
        body: render(&GeminiRequest {
            contents,
            system_instruction: chat.system.map(|text| GeminiContent {
                role: "user",
                parts: vec![GeminiPart { text }],
            }),
            generation_config: GeminiConfig {
                max_output_tokens: chat.max_tokens,
                temperature: chat.temperature,
            },
        })?,
    })
}

fn gemini_response(model: &str, created: i64, body: &Value) -> Result<String> {
    let candidate = body
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .ok_or_else(|| vendor_error(body, "gemini returned no candidate"))?;
    let content = candidate
        .get("content")
        .and_then(|c| text_parts(c.get("parts"), "text", ""))
        .ok_or_else(|| vendor_error(body, "gemini's candidate carried no text part"))?;
    let usage = body.get("usageMetadata");
    let prompt = u64_at(usage, "promptTokenCount").unwrap_or(0);
    let completion = u64_at(usage, "candidatesTokenCount").unwrap_or(0);
    chat_completion(
        str_at(body, "responseId").unwrap_or("chatcmpl-gemini").to_string(),
        model,
        created,
        content,
        finish_reason(str_at(candidate, "finishReason")),
        Usage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: u64_at(usage, "totalTokenCount").unwrap_or(prompt + completion),
        },
    )
}

// --- replicate (image, music) ------------------------------------------------

#[derive(Serialize)]
struct ReplicateRequest {
    input: ReplicateInput,
}

#[derive(Serialize)]
struct ReplicateInput {
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_outputs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<u64>,
}

fn replicate_request(model: &str, body: &Value) -> Result<NativeRequest> {
    Ok(NativeRequest {
        path: format!("/models/{model}/predictions"),
        body: render(&ReplicateRequest {
            input: ReplicateInput {
                prompt: read_prompt(body)?,
                num_outputs: u64_at(Some(body), "n"),
                duration: u64_at(Some(body), "duration_seconds"),
            },
        })?,
    })
}

fn replicate_response(modality: &str, model: &str, created: i64, body: &Value) -> Result<String> {
    reject_vendor_error(body)?;
    let items = urls(body.get("output"))
        .into_iter()
        .map(|url| url_item(modality, url))
        .collect();
    media_response(
        modality,
        str_at(body, "id").unwrap_or("gen-replicate").to_string(),
        model,
        created,
        items,
    )
}

// --- elevenlabs (speech) -----------------------------------------------------

#[derive(Serialize)]
struct ElevenLabsRequest<'a> {
    text: String,
    model_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<&'static str>,
}

fn elevenlabs_request(model: &str, body: &Value) -> Result<NativeRequest> {
    let voice = str_at(body, "voice").unwrap_or(DEFAULT_ELEVENLABS_VOICE);
    Ok(NativeRequest {
        // ElevenLabs routes by voice in the path — the JSON body alone cannot address it.
        path: format!("/text-to-speech/{voice}/with-timestamps"),
        body: render(&ElevenLabsRequest {
            text: read_prompt(body)?,
            model_id: model,
            output_format: match str_at(body, "response_format") {
                Some("wav") | Some("pcm") => Some("pcm_44100"),
                Some("mp3") => Some("mp3_44100_128"),
                _ => None,
            },
        })?,
    })
}

fn elevenlabs_response(model: &str, created: i64, body: &Value) -> Result<String> {
    let audio = str_at(body, "audio_base64")
        .or_else(|| str_at(body, "audio"))
        .ok_or_else(|| vendor_error(body, "elevenlabs returned no audio"))?;
    media_response(
        "speech",
        str_at(body, "request_id").unwrap_or("gen-elevenlabs").to_string(),
        model,
        created,
        vec![MediaItem {
            url: None,
            b64_json: Some(audio.to_string()),
            media_type: media_type("speech"),
        }],
    )
}

// --- the video vendors -------------------------------------------------------

#[derive(Serialize)]
struct RunwayRequest<'a> {
    model: &'a str,
    #[serde(rename = "promptText")]
    prompt_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<u64>,
}

fn runway_request(model: &str, body: &Value) -> Result<NativeRequest> {
    Ok(NativeRequest {
        path: "/text_to_video".to_string(),
        body: render(&RunwayRequest {
            model,
            prompt_text: read_prompt(body)?,
            duration: u64_at(Some(body), "duration_seconds"),
        })?,
    })
}

fn runway_response(model: &str, created: i64, body: &Value) -> Result<String> {
    reject_vendor_error(body)?;
    let items = urls(body.get("output"))
        .into_iter()
        .map(|url| url_item("video", url))
        .collect();
    media_response(
        "video",
        str_at(body, "id").unwrap_or("gen-runway").to_string(),
        model,
        created,
        items,
    )
}

#[derive(Serialize)]
struct LumaRequest<'a> {
    model: &'a str,
    prompt: String,
}

fn luma_request(model: &str, body: &Value) -> Result<NativeRequest> {
    Ok(NativeRequest {
        path: "/generations".to_string(),
        body: render(&LumaRequest {
            model,
            prompt: read_prompt(body)?,
        })?,
    })
}

fn luma_response(model: &str, created: i64, body: &Value) -> Result<String> {
    reject_vendor_error(body)?;
    let items = body
        .get("assets")
        .and_then(|assets| str_at(assets, "video"))
        .map(|url| vec![url_item("video", url.to_string())])
        .unwrap_or_default();
    media_response(
        "video",
        str_at(body, "id").unwrap_or("gen-luma").to_string(),
        model,
        created,
        items,
    )
}

#[derive(Serialize)]
struct MinimaxRequest<'a> {
    model: &'a str,
    prompt: String,
}

fn minimax_request(model: &str, body: &Value) -> Result<NativeRequest> {
    Ok(NativeRequest {
        path: "/video_generation".to_string(),
        body: render(&MinimaxRequest {
            model,
            prompt: read_prompt(body)?,
        })?,
    })
}

fn minimax_response(model: &str, created: i64, body: &Value) -> Result<String> {
    // MiniMax reports its status in a nested envelope rather than a top-level `error`.
    if let Some(status) = body.get("base_resp") {
        let code = u64_at(Some(status), "status_code").unwrap_or(0);
        if code != 0 {
            let message = str_at(status, "status_msg").unwrap_or("minimax refused the request");
            return Err(WireError::new(format!("minimax: {message} ({code})")));
        }
    }
    let items = str_at(body, "video_url")
        .or_else(|| str_at(body, "download_url"))
        .map(|url| vec![url_item("video", url.to_string())])
        .unwrap_or_default();
    media_response(
        "video",
        str_at(body, "task_id").unwrap_or("gen-minimax").to_string(),
        model,
        created,
        items,
    )
}

// --- reading the OpenAI side -------------------------------------------------

/// One turn of a conversation, flattened to text. Multi-part content is joined, because
/// every native text vendor here takes a single string per turn.
struct Turn {
    role: String,
    text: String,
}

struct Chat {
    system: Option<String>,
    turns: Vec<Turn>,
    max_tokens: Option<u64>,
    temperature: Option<f64>,
}

/// Read an OpenAI chat request. `system` turns are lifted out, because both Anthropic and
/// Gemini carry the system prompt beside the conversation rather than inside it.
///
/// A bare `{"prompt": ...}` is accepted as a single user turn: the router's own media routes
/// spell a request that way, and a caller who sends one to a text rung means the obvious
/// thing.
fn read_chat(body: &Value) -> Result<Chat> {
    let mut system: Vec<String> = Vec::new();
    let mut turns: Vec<Turn> = Vec::new();
    match body.get("messages").and_then(|m| m.as_array()) {
        Some(messages) => {
            for message in messages {
                let role = str_at(message, "role").unwrap_or("user").to_string();
                let text = message_text(message.get("content"));
                if role == "system" || role == "developer" {
                    system.push(text);
                } else {
                    turns.push(Turn { role, text });
                }
            }
        }
        None => {
            let prompt = str_at(body, "prompt").ok_or_else(|| {
                WireError::new("the request carries neither `messages` nor `prompt`")
            })?;
            turns.push(Turn {
                role: "user".to_string(),
                text: prompt.to_string(),
            });
        }
    }
    if turns.is_empty() {
        return Err(WireError::new(
            "the request carries no message a vendor could answer",
        ));
    }
    Ok(Chat {
        system: if system.is_empty() {
            None
        } else {
            Some(system.join("\n\n"))
        },
        turns,
        max_tokens: u64_at(Some(body), "max_tokens")
            .or_else(|| u64_at(Some(body), "max_completion_tokens")),
        temperature: body.get("temperature").and_then(|t| t.as_f64()),
    })
}

/// The prompt a media request is generating from: the explicit `prompt`, OpenAI's `input`
/// (`/v1/audio/speech`), or the last user turn of a chat-shaped body.
fn read_prompt(body: &Value) -> Result<String> {
    if let Some(prompt) = str_at(body, "prompt") {
        return Ok(prompt.to_string());
    }
    if let Some(input) = str_at(body, "input") {
        return Ok(input.to_string());
    }
    if let Some(text) = str_at(body, "text") {
        return Ok(text.to_string());
    }
    let chat = read_chat(body)?;
    chat.turns
        .last()
        .map(|turn| turn.text.clone())
        .ok_or_else(|| WireError::new("the request carries no prompt"))
}

/// OpenAI message content is a string, or an array of typed parts. Anything else reads as
/// empty rather than failing: an unanswerable request is the vendor's judgement to make.
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => text_parts(content, "text", "text").unwrap_or_default(),
        _ => String::new(),
    }
}

fn assistant_or_user(role: &str) -> &'static str {
    if role == "assistant" {
        "assistant"
    } else {
        "user"
    }
}

// --- reading the vendor side -------------------------------------------------

/// Concatenate the `text` of every part in an array. When `want_type` is non-empty only the
/// parts declaring `"type": want_type` count, which is how Anthropic marks its text blocks
/// apart from tool use. `None` when the value is not an array.
fn text_parts(value: Option<&Value>, key: &str, want_type: &str) -> Option<String> {
    let parts = value?.as_array()?;
    let mut out = String::new();
    for part in parts {
        if !want_type.is_empty() && str_at(part, "type") != Some(want_type) {
            continue;
        }
        if let Some(text) = str_at(part, key) {
            out.push_str(text);
        }
    }
    Some(out)
}

/// A vendor's artifact field is a URL, or a list of them. Anything else contributes nothing.
fn urls(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(url)) => vec![url.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|url| url.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

/// A vendor that reports a failure in-band gets its own words on the attempt record — a
/// refusal is more useful to a caller than "no artifact".
fn reject_vendor_error(body: &Value) -> Result<()> {
    match body.get("error") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(message)) => Err(WireError::new(message.clone())),
        Some(other) => Err(WireError::new(other.to_string())),
    }
}

fn vendor_error(body: &Value, fallback: &str) -> WireError {
    match body.get("error") {
        None | Some(Value::Null) => WireError::new(fallback),
        Some(Value::String(message)) => WireError::new(message.clone()),
        Some(other) => WireError::new(other.to_string()),
    }
}

fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

fn u64_at(value: Option<&Value>, key: &str) -> Option<u64> {
    value?.get(key)?.as_u64()
}

fn render<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|err| WireError::new(format!("serialize: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).expect("rendered output is JSON")
    }

    #[test]
    fn every_native_vendor_has_at_least_one_adapter() {
        for provider in NATIVE_PROVIDERS {
            let covered = ["text", "image", "speech", "music", "video"]
                .iter()
                .any(|modality| supports(provider, modality));
            assert!(covered, "{provider} has no adapter at all");
        }
    }

    #[test]
    fn an_unsupported_pair_is_an_error_not_a_panic() {
        assert!(!supports("anthropic", "video"));
        let err = to_native("anthropic", "video", "m", &json!({"prompt": "hi"})).unwrap_err();
        assert!(err.message().contains("anthropic"));
        assert!(from_native("openai", "text", "m", 0, &json!({})).is_err());
    }

    #[test]
    fn anthropic_lifts_the_system_prompt_out_of_the_conversation() {
        let request = to_native(
            "anthropic",
            "text",
            "claude-haiku-4-5",
            &json!({
                "messages": [
                    {"role": "system", "content": "be terse"},
                    {"role": "user", "content": "hi"}
                ],
                "max_tokens": 64,
                "temperature": 0.5
            }),
        )
        .unwrap();
        assert_eq!(request.path, "/messages");
        let body = parsed(&request.body);
        assert_eq!(body["system"], json!("be terse"));
        assert_eq!(body["max_tokens"], json!(64));
        assert_eq!(body["messages"], json!([{"role": "user", "content": "hi"}]));
    }

    #[test]
    fn anthropic_supplies_the_max_tokens_openai_leaves_optional() {
        let request =
            to_native("anthropic", "text", "m", &json!({"prompt": "hi"})).unwrap();
        assert_eq!(parsed(&request.body)["max_tokens"], json!(DEFAULT_MAX_TOKENS));
    }

    #[test]
    fn an_anthropic_response_comes_back_as_a_chat_completion() {
        let rendered = from_native(
            "anthropic",
            "text",
            "claude-haiku-4-5",
            1700,
            &json!({
                "id": "msg_01",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "tool_use", "name": "ignored"},
                    {"type": "text", "text": " there"}
                ],
                "stop_reason": "max_tokens",
                "usage": {"input_tokens": 3, "output_tokens": 4}
            }),
        )
        .unwrap();
        // Declaration order, not alphabetical — the envelope is relayed verbatim.
        assert!(rendered.starts_with(r#"{"id":"msg_01","object":"chat.completion","created":1700"#));
        let body = parsed(&rendered);
        assert_eq!(body["choices"][0]["message"]["content"], json!("hello there"));
        assert_eq!(body["choices"][0]["finish_reason"], json!("length"));
        assert_eq!(body["usage"]["total_tokens"], json!(7));
    }

    #[test]
    fn gemini_addresses_the_model_in_the_path_and_renames_the_assistant() {
        let request = to_native(
            "gemini",
            "text",
            "gemini-2.5-flash",
            &json!({"messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"}
            ]}),
        )
        .unwrap();
        assert_eq!(request.path, "/models/gemini-2.5-flash:generateContent");
        let body = parsed(&request.body);
        assert_eq!(body["contents"][1]["role"], json!("model"));
        assert_eq!(body["contents"][0]["parts"][0]["text"], json!("hi"));
    }

    #[test]
    fn a_gemini_candidate_comes_back_as_a_chat_completion() {
        let body = parsed(
            &from_native(
                "gemini",
                "text",
                "gemini-2.5-flash",
                7,
                &json!({
                    "candidates": [{
                        "content": {"role": "model", "parts": [{"text": "hi"}]},
                        "finishReason": "STOP"
                    }],
                    "usageMetadata": {
                        "promptTokenCount": 2, "candidatesTokenCount": 1, "totalTokenCount": 3
                    }
                }),
            )
            .unwrap(),
        );
        assert_eq!(body["choices"][0]["message"]["content"], json!("hi"));
        assert_eq!(body["usage"]["total_tokens"], json!(3));
    }

    #[test]
    fn replicate_wraps_the_prompt_in_an_input_object() {
        let request = to_native(
            "replicate",
            "image",
            "black-forest-labs/flux-schnell",
            &json!({"prompt": "a cat", "n": 2}),
        )
        .unwrap();
        assert_eq!(request.path, "/models/black-forest-labs/flux-schnell/predictions");
        let body = parsed(&request.body);
        assert_eq!(body["input"]["prompt"], json!("a cat"));
        assert_eq!(body["input"]["num_outputs"], json!(2));
    }

    #[test]
    fn a_replicate_output_becomes_the_media_envelope() {
        let body = parsed(
            &from_native(
                "replicate",
                "image",
                "flux",
                9,
                &json!({"id": "pred_1", "output": ["https://cdn/a.png"]}),
            )
            .unwrap(),
        );
        assert_eq!(body["object"], json!("image.generation"));
        assert_eq!(body["data"][0]["url"], json!("https://cdn/a.png"));
        assert_eq!(body["data"][0]["media_type"], json!("image/png"));
    }

    #[test]
    fn a_vendor_that_reports_an_error_is_refused_in_its_own_words() {
        let err = from_native(
            "replicate",
            "music",
            "musicgen",
            0,
            &json!({"id": "pred_2", "error": "NSFW content detected"}),
        )
        .unwrap_err();
        assert_eq!(err.message(), "NSFW content detected");
    }

    #[test]
    fn a_vendor_response_with_no_artifact_is_an_error() {
        let err =
            from_native("runway", "video", "gen3a_turbo", 0, &json!({"id": "t_1"})).unwrap_err();
        assert!(err.message().contains("no artifact"));
    }

    #[test]
    fn elevenlabs_addresses_the_voice_in_the_path() {
        let request = to_native(
            "elevenlabs",
            "speech",
            "eleven_multilingual_v2",
            &json!({"input": "hello", "voice": "abc123", "response_format": "mp3"}),
        )
        .unwrap();
        assert_eq!(request.path, "/text-to-speech/abc123/with-timestamps");
        let body = parsed(&request.body);
        assert_eq!(body["text"], json!("hello"));
        assert_eq!(body["output_format"], json!("mp3_44100_128"));

        let defaulted =
            to_native("elevenlabs", "speech", "m", &json!({"input": "hi"})).unwrap();
        assert!(defaulted.path.contains(DEFAULT_ELEVENLABS_VOICE));
        assert_eq!(parsed(&defaulted.body).get("output_format"), None);
    }

    #[test]
    fn elevenlabs_audio_comes_back_base64_in_the_media_envelope() {
        let body = parsed(
            &from_native(
                "elevenlabs",
                "speech",
                "eleven_multilingual_v2",
                3,
                &json!({"audio_base64": "QUJD"}),
            )
            .unwrap(),
        );
        assert_eq!(body["object"], json!("speech.generation"));
        assert_eq!(body["data"][0]["b64_json"], json!("QUJD"));
        assert_eq!(body["data"][0].get("url"), None);
    }

    #[test]
    fn each_video_vendor_reads_its_own_artifact_field() {
        let runway = parsed(
            &from_native("runway", "video", "m", 0, &json!({"output": ["https://r/v.mp4"]}))
                .unwrap(),
        );
        assert_eq!(runway["data"][0]["url"], json!("https://r/v.mp4"));

        let luma = parsed(
            &from_native(
                "luma",
                "video",
                "m",
                0,
                &json!({"id": "g1", "assets": {"video": "https://l/v.mp4"}}),
            )
            .unwrap(),
        );
        assert_eq!(luma["data"][0]["url"], json!("https://l/v.mp4"));
        assert_eq!(luma["id"], json!("g1"));

        let minimax = parsed(
            &from_native(
                "minimax",
                "video",
                "m",
                0,
                &json!({"task_id": "t1", "video_url": "https://m/v.mp4",
                        "base_resp": {"status_code": 0, "status_msg": "success"}}),
            )
            .unwrap(),
        );
        assert_eq!(minimax["data"][0]["url"], json!("https://m/v.mp4"));

        let refused = from_native(
            "minimax",
            "video",
            "m",
            0,
            &json!({"base_resp": {"status_code": 1004, "status_msg": "auth failed"}}),
        )
        .unwrap_err();
        assert!(refused.message().contains("auth failed"));
    }

    #[test]
    fn the_video_vendors_each_have_their_own_path() {
        let prompt = json!({"prompt": "a wave"});
        assert_eq!(
            to_native("runway", "video", "gen3a_turbo", &prompt).unwrap().path,
            "/text_to_video"
        );
        assert_eq!(
            to_native("luma", "video", "ray-2", &prompt).unwrap().path,
            "/generations"
        );
        assert_eq!(
            to_native("minimax", "video", "video-01", &prompt).unwrap().path,
            "/video_generation"
        );
    }

    #[test]
    fn a_request_with_nothing_to_say_is_refused_rather_than_sent() {
        let err = to_native("anthropic", "text", "m", &json!({"messages": []})).unwrap_err();
        assert!(err.message().contains("no message"));
        assert!(to_native("luma", "video", "m", &json!({})).is_err());
    }

    #[test]
    fn multi_part_openai_content_is_flattened_for_the_vendor() {
        let request = to_native(
            "anthropic",
            "text",
            "m",
            &json!({"messages": [{"role": "user", "content": [
                {"type": "text", "text": "one "},
                {"type": "image_url", "image_url": {"url": "ignored"}},
                {"type": "text", "text": "two"}
            ]}]}),
        )
        .unwrap();
        assert_eq!(parsed(&request.body)["messages"][0]["content"], json!("one two"));
    }
}
