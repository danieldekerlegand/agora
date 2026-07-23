%%% @doc The HTTP route table — the Erlang mirror of the Python app's surface (`app.py').
%%%
%%% One authored list of `{Path, Handler, Opts}' is the single source of truth: {@link
%%% paths/0} projects the path set that the route-table test pins, and {@link dispatch/0}
%%% compiles the cowboy dispatch from the same list, so the two can never drift.
%%%
%%% The set is `app.py''s: six reads (`/health', `/doctor', `/v1/models', `/v1/providers', the
%%% AgentCard at `manifest.py::MANIFEST_PATH' and the permanent redirect at its pre-0.3.0
%%% `LEGACY_MANIFEST_PATH') and the five generation POSTs, one per modality.
%%%
%%% The two manifest paths are the reconciliation US-1 deferred: it registered the legacy
%%% `/.well-known/kcb-manifest.json' as *the* manifest route, but `app.py' serves the card at
%%% `/.well-known/agent-card.json' and 308s the legacy path onto it (capability-bus.md §6
%%% folds the standalone document onto the AgentCard). Matching `app.py' exactly is what the
%%% byte-for-byte conformance of US-6 needs, and it is what a 0.2.0 crawler expects to find.
%%%
%%% `/v1/models' and `/v1/providers' are the last stubs, landing with the conformance suite.
-module(apr_routes).

-export([paths/0, dispatch/0, handlers/0]).

%% @doc The `{Path, Handler, Opts}' route list, in `app.py' declaration order.
-spec handlers() -> [{binary(), module(), map()}].
handlers() ->
    [{<<"/health">>,                       apr_health_handler,   #{}},
     {<<"/doctor">>,                       apr_doctor_handler,   #{}},
     {<<"/v1/models">>,                    apr_stub_handler,     #{name => models}},
     {<<"/v1/providers">>,                 apr_stub_handler,     #{name => providers}},
     {apr_manifest:manifest_path(),        apr_manifest_handler, #{}},
     {apr_manifest:legacy_manifest_path(), apr_redirect_handler,
      #{status => 308, location => apr_manifest:manifest_path()}},
     {<<"/v1/chat/completions">>,          apr_generate_handler, #{modality => text}},
     {<<"/v1/images/generations">>,        apr_generate_handler, #{modality => image}},
     {<<"/v1/audio/speech">>,              apr_generate_handler, #{modality => speech}},
     {<<"/v1/audio/music-generations">>,   apr_generate_handler, #{modality => music}},
     {<<"/v1/video/generations">>,         apr_generate_handler, #{modality => video}}].

%% @doc The set of registered paths — what the route-table test asserts against `app.py'.
-spec paths() -> [binary()].
paths() ->
    [Path || {Path, _Handler, _Opts} <- handlers()].

%% @doc Compile the cowboy dispatch table from {@link handlers/0}.
-spec dispatch() -> cowboy_router:dispatch_rules().
dispatch() ->
    Routes = [{binary_to_list(Path), Handler, Opts}
              || {Path, Handler, Opts} <- handlers()],
    cowboy_router:compile([{'_', Routes}]).
