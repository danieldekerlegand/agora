%%% @doc The OTP application callback: boot the embedded cowboy listener, then the
%%% supervision tree. The listener answers the full `app.py` route set (US-1); the
%%% supervision tree grows into the sacred ladder in US-2.
-module(agora_provider_router_app).
-behaviour(application).

-export([start/2, stop/1]).

%% The cowboy listener's ref — the ct suite reads its assigned port via `ranch:get_port/1`.
-define(LISTENER, agora_provider_router_listener).

-spec start(application:start_type(), term()) -> {ok, pid()} | {error, term()}.
start(_StartType, _StartArgs) ->
    Dispatch = apr_routes:dispatch(),
    {ok, _} = cowboy:start_clear(
                ?LISTENER,
                [{port, apr:port()}],
                #{env => #{dispatch => Dispatch}}),
    agora_provider_router_sup:start_link().

-spec stop(term()) -> ok.
stop(_State) ->
    _ = cowboy:stop_listener(?LISTENER),
    ok.
