// napi-build wires the platform linker flags the N-API cdylib needs (on macOS, dynamic-lookup
// for the `napi_*` symbols Node resolves at load). It is harmless for a default (non-`binding`)
// build: the pure cdylib exports nothing, so the extra link args go unused.
fn main() {
    napi_build::setup();
}
