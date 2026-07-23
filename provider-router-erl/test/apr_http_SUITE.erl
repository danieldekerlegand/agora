%%% @doc common_test: boot the real OTP application over HTTP and drive the surface.
%%%
%%% Asserts `GET /health` is byte-identical to `app.py::health` and that every registered
%%% route answers with a defined status rather than crashing the listener (US-1 AC). The
%%% *bodies* of the mirrored surface are pinned against the Python router's by
%%% `apr_conformance_SUITE'; this suite is the liveness half.
-module(apr_http_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1]).
-export([health_returns_byte_identical_body/1, every_contract_read_answers_without_crashing/1,
         doctor_answers_ok/1]).

all() ->
    [health_returns_byte_identical_body, every_contract_read_answers_without_crashing,
     doctor_answers_ok].

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

every_contract_read_answers_without_crashing(Config) ->
    %% /v1/models and /v1/providers were the last stubs; they went live with the conformance
    %% suite (US-6), so every read on the mirrored surface now answers 200.
    Reads = ["/v1/models", "/v1/providers"],
    lists:foreach(
      fun(Path) ->
              {Status, _Body} = get(Config, Path),
              200 = Status
      end, Reads),
    %% The listener is still up after every stub hit — /health answers again.
    {200, _} = get(Config, "/health"),
    ok.

doctor_answers_ok(Config) ->
    %% /doctor is live as of US-2: 200 with the resolved ladder, ending in the placeholder
    %% and reporting each tier's status. It dials nothing, so it answers on a bare node.
    {200, Body} = get(Config, "/doctor"),
    {_, _} = binary:match(Body, <<"resolves_to">>),
    {_, _} = binary:match(Body, <<"placeholder">>),
    {_, _} = binary:match(Body, <<"unconfigured">>),
    ok.

%% --- helpers ---

get(Config, Path) ->
    Port = ?config(port, Config),
    URL = "http://127.0.0.1:" ++ integer_to_list(Port) ++ Path,
    {ok, {{_Vsn, Status, _Reason}, _Headers, Body}} =
        httpc:request(get, {URL, []}, [], [{body_format, binary}]),
    {Status, Body}.
