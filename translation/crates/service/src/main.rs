//! Standalone entry point for the transform service — boot the HTTP surface from the
//! process environment, the zero-config pattern the registry's `main.ts` uses.
//!
//! With nothing set it binds `127.0.0.1:8790`, a working transform leaf the moment it
//! listens. A deployment overrides the address with two env vars, no code change:
//!
//!   AGORA_TRANSLATION_HOST   bind host   (default 127.0.0.1)
//!   AGORA_TRANSLATION_PORT   bind port   (default 8790)
//!
//! Remember the embed-first rule (see `translation/README.md`): reach for this HTTP
//! service only across a language/process boundary that cannot link the crate. TS embeds
//! the WASM facade, Python embeds the PyO3 facade — both translate in-process, zero hop.

use std::env;

use translation_service::TranslationService;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8790;

fn main() {
    let host = env::var("AGORA_TRANSLATION_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_HOST.to_string());
    let port = env::var("AGORA_TRANSLATION_PORT")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let service = TranslationService::bind((host.as_str(), port))
        .unwrap_or_else(|err| panic!("failed to bind {host}:{port}: {err}"));
    eprintln!("translation-service listening on {}", service.base_url());

    // Hold the service alive; the accept loop runs on its own thread.
    loop {
        std::thread::park();
    }
}
