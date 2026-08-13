%%% @doc The HTTP route table — the Erlang mirror of the Python app's surface (`app.py').
%%%
%%% One authored list of `{Path, Handler, Opts}' is the single source of truth: {@link
%%% paths/0} projects the path set that the route-table test pins, and {@link dispatch/0}
%%% compiles the cowboy dispatch from the same list, so the two can never drift.
%%%
%%% The set is `app.py''s: six reads (`/health', `/doctor', `/v1/models', `/v1/providers', the
%%% AgentCard at `manifest.py::MANIFEST_PATH' and the permanent redirect at its pre-0.3.0
%%% `LEGACY_MANIFEST_PATH'), the two KCB §4 `invoke' transports ({@link apr_mcp}, {@link
%%% apr_a2a}) and the five generation POSTs, one per modality.
%%%
%%% The two manifest paths are the reconciliation US-1 deferred: it registered the legacy
%%% `/.well-known/kcb-manifest.json' as *the* manifest route, but `app.py' serves the card at
%%% `/.well-known/agent-card.json' and 308s the legacy path onto it (capability-bus.md §6
%%% folds the standalone document onto the AgentCard). Matching `app.py' exactly is what the
%%% byte-for-byte conformance of US-6 needs, and it is what a 0.2.0 crawler expects to find.
%%%
%%% Every route is now a real handler: `/v1/models' and `/v1/providers', the last two stubs,
%%% landed with the conformance suite (US-6) that pins their bodies against the Python
%%% router's, and the stub handler went with them.
%%%
%%% Routes carry a **kind**. `contract' routes are the ones mirrored from `app.py' — that set
%%% is the external contract and is pinned, byte-for-byte, by the route test and by US-6's
%%% conformance fixture. `bus' routes are KCB verbs the spec defines for every provider
%%% (`subscribe' and `fetch', capability-bus.md §4) which the Python router never surfaced;
%%% they are additions beside the contract, never edits to it, so adding one can never move a
%%% byte on a path a caller already depends on.
-module(apr_routes).

-export([paths/0, contract_paths/0, bus_paths/0, dispatch/0, handlers/0]).

%% @doc The `{Path, Handler, Opts, Kind}' route list, `app.py' declaration order first.
-spec handlers() -> [{binary(), module(), map(), contract | bus}].
handlers() ->
    [{<<"/health">>,                       apr_health_handler,   #{}, contract},
     {<<"/doctor">>,                       apr_doctor_handler,   #{}, contract},
     {<<"/v1/models">>,                    apr_models_handler,    #{}, contract},
     {<<"/v1/providers">>,                 apr_providers_handler, #{}, contract},
     {apr_manifest:manifest_path(),        apr_manifest_handler, #{}, contract},
     {apr_manifest:legacy_manifest_path(), apr_redirect_handler,
      #{status => 308, location => apr_manifest:manifest_path()}, contract},
     %% KCB §4 `invoke', on the two transports the manifest advertises. Both are `contract':
     %% the Python router serves them too, so their bytes are pinned by the corpus.
     {apr_mcp:path(),                      apr_jsonrpc_handler, #{surface => apr_mcp}, contract},
     {apr_a2a:path(),                      apr_jsonrpc_handler, #{surface => apr_a2a}, contract},
     {<<"/v1/chat/completions">>,          apr_generate_handler, #{modality => text}, contract},
     {<<"/v1/images/generations">>,        apr_generate_handler, #{modality => image}, contract},
     {<<"/v1/audio/speech">>,              apr_generate_handler, #{modality => speech}, contract},
     {<<"/v1/audio/music-generations">>,   apr_generate_handler, #{modality => music}, contract},
     {<<"/v1/video/generations">>,         apr_generate_handler, #{modality => video}, contract},
     %% KCB §4 verbs — the subscribe stream and the CAS fetch behind its dangling references.
     {<<"/v1/subscribe">>,                 apr_subscribe_handler, #{}, bus},
     {<<"/v1/assets/:id">>,                apr_fetch_handler,     #{}, bus}].

%% @doc Every registered path.
-spec paths() -> [binary()].
paths() ->
    [Path || {Path, _Handler, _Opts, _Kind} <- handlers()].

%% @doc The paths mirrored from `app.py' — the set the route test pins.
-spec contract_paths() -> [binary()].
contract_paths() ->
    [Path || {Path, _Handler, _Opts, contract} <- handlers()].

%% @doc The KCB bus paths this router adds beside the mirrored contract.
-spec bus_paths() -> [binary()].
bus_paths() ->
    [Path || {Path, _Handler, _Opts, bus} <- handlers()].

%% @doc Compile the cowboy dispatch table from {@link handlers/0}.
-spec dispatch() -> cowboy_router:dispatch_rules().
dispatch() ->
    Routes = [{binary_to_list(Path), Handler, Opts}
              || {Path, Handler, Opts, _Kind} <- handlers()],
    cowboy_router:compile([{'_', Routes}]).
