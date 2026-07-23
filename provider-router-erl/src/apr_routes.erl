%%% @doc The HTTP route table — the Erlang mirror of the Python app's surface (`app.py`).
%%%
%%% One authored list of `{Path, Handler, Opts}` is the single source of truth: {@link
%%% paths/0} projects the path set that the route-table test pins, and {@link dispatch/0}
%%% compiles the cowboy dispatch from the same list, so the two can never drift.
%%%
%%% The set is the ten paths of `app.py`: five reads (`/health`, `/doctor`, `/v1/models`,
%%% `/v1/providers`, the KCB manifest) and the five generation POSTs, one per modality.
%%% Everything but `/health` is a stub returning a defined status (US-1); the real
%%% handlers land in US-2..US-5.
-module(apr_routes).

-export([paths/0, dispatch/0, handlers/0]).

%% @doc The `{Path, Handler, Opts}` route list, in `app.py` declaration order.
-spec handlers() -> [{binary(), module(), map()}].
handlers() ->
    [{<<"/health">>,                          apr_health_handler, #{}},
     {<<"/doctor">>,                          apr_stub_handler,   #{name => doctor}},
     {<<"/v1/models">>,                       apr_stub_handler,   #{name => models}},
     {<<"/v1/providers">>,                    apr_stub_handler,   #{name => providers}},
     {<<"/.well-known/kcb-manifest.json">>,   apr_stub_handler,   #{name => manifest}},
     {<<"/v1/chat/completions">>,             apr_stub_handler,   #{name => text}},
     {<<"/v1/images/generations">>,           apr_stub_handler,   #{name => image}},
     {<<"/v1/audio/speech">>,                 apr_stub_handler,   #{name => speech}},
     {<<"/v1/audio/music-generations">>,      apr_stub_handler,   #{name => music}},
     {<<"/v1/video/generations">>,            apr_stub_handler,   #{name => video}}].

%% @doc The set of registered paths — what the route-table test asserts against `app.py`.
-spec paths() -> [binary()].
paths() ->
    [Path || {Path, _Handler, _Opts} <- handlers()].

%% @doc Compile the cowboy dispatch table from {@link handlers/0}.
-spec dispatch() -> cowboy_router:dispatch_rules().
dispatch() ->
    Routes = [{binary_to_list(Path), Handler, Opts}
              || {Path, Handler, Opts} <- handlers()],
    cowboy_router:compile([{'_', Routes}]).
