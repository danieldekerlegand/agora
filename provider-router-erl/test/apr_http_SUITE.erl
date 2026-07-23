%%% @doc common_test: boot the real OTP application over HTTP and drive the surface.
%%%
%%% Asserts `GET /health` is byte-identical to `app.py::health` and that the stub routes
%%% answer with a defined status (501) rather than crashing the listener (US-1 AC).
-module(apr_http_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1]).
-export([health_returns_byte_identical_body/1, stub_routes_answer_without_crashing/1]).

all() ->
    [health_returns_byte_identical_body, stub_routes_answer_without_crashing].

init_per_suite(Config) ->
    %% Port 0 → OS-assigned; read it back so the test is host-agnostic.
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    {ok, _Inets} = application:ensure_all_started(inets),
    Port = ranch:get_port(agora_provider_router_listener),
    [{port, Port} | Config].

end_per_suite(_Config) ->
    ok = application:stop(agora_provider_router),
    ok.

health_returns_byte_identical_body(Config) ->
    {Status, Body} = get(Config, "/health"),
    200 = Status,
    <<"{\"status\":\"ok\",\"identity\":\"agora:agent:provider-router\","
      "\"version\":\"0.1.0\",\"kcb_version\":\"0.2.0\"}">> = Body,
    ok.

stub_routes_answer_without_crashing(Config) ->
    Reads = ["/doctor", "/v1/models", "/v1/providers",
             "/.well-known/kcb-manifest.json"],
    lists:foreach(
      fun(Path) ->
              {Status, _Body} = get(Config, Path),
              501 = Status
      end, Reads),
    %% The listener is still up after every stub hit — /health answers again.
    {200, _} = get(Config, "/health"),
    ok.

%% --- helpers ---

get(Config, Path) ->
    Port = ?config(port, Config),
    URL = "http://127.0.0.1:" ++ integer_to_list(Port) ++ Path,
    {ok, {{_Vsn, Status, _Reason}, _Headers, Body}} =
        httpc:request(get, {URL, []}, [], [{body_format, binary}]),
    {Status, Body}.
