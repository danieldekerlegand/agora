%%% @doc common_test: a local backend's failure modes leave the always-completes ladder
%%% intact. The Erlang half of `tests/test_local_failure_modes.py'.
%%%
%%% The local tier is the one rung whose *server* is the operator's own: nobody runs an SLA on
%%% the Ollama on somebody's laptop, so every way it can go wrong is an ordinary state rather
%%% than an exception. Absent, refusing connections, accepting them and never answering,
%%% crashing, or answering with something that is not a completion — each is one more rung
%%% that did not answer, and the walk continues to the deterministic zero-spend placeholder.
%%%
%%% The failures arrive here as an *injected transport*, which is the whole live dial this
%%% router has: the canonical side's OpenAI-wire HTTP transport is wired in a later story
%%% (`apr_router:default_transport/0'), so what a socket would raise on the Python side is what
%%% a transport returns or raises here. The failure the ladder sees — and the attempt it
%%% records — is the same either way, which is the point.
%%%
%%% `docs/router-hand-built-behaviours.md' §2.3 asks any change to a dispatch path to re-prove
%%% the ladder's guards on it. This tasklist touched {@link apr_backends:dispatch_url/1},
%%% {@link apr_backends:dispatch_headers/1} and {@link apr_rung_worker} `dial/6', so the last
%%% cases re-assert the two that matter most: an `unpriced' rung never passes a ceiling, and
%%% `resolve_all' never raises.
-module(apr_local_failure_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1, init_per_testcase/2, end_per_testcase/2]).
-export([an_absent_local_rung_is_never_dialed/1,
         an_absent_local_rung_says_it_was_configuration/1,
         a_refusing_local_backend_falls_through/1,
         a_timing_out_local_backend_falls_through/1,
         a_crashing_local_backend_falls_through/1,
         a_malformed_local_answer_falls_through/1,
         every_non_object_answer_is_named_in_the_attempt/1,
         an_object_is_still_an_answer/1,
         an_unpriced_rung_never_passes_a_ceiling/1,
         a_free_local_rung_still_serves_a_ceiling_of_zero/1,
         resolve_all_never_raises_on_a_hostile_local_configuration/1,
         no_local_failure_mode_raises_out_of_complete/1]).

%% Deliberately not loopback-looking: a test that passed by accident of something listening on
%% the box would be visible as such. Nothing is dialed here in any case — the transport is.
-define(OLLAMA, "http://ollama.test:11434/v1").
-define(MLX, "http://mlx.test:8080/v1").

-define(LADDER, "AGORA_TEXT_LADDER").
-define(OLLAMA_VAR, "OLLAMA_BASE_URL").
-define(MLX_VAR, "MLX_SERVE_BASE_URL").
-define(KEY_VAR, "AGORA_PROVIDER_OPENAI_API_KEY").

-define(VARS, [?LADDER, ?OLLAMA_VAR, ?MLX_VAR, ?KEY_VAR, "OLLAMA_HOST", "OPENAI_API_KEY",
               "AGORA_PREFER_LOCAL"]).

-define(PROMPT, #{<<"prompt">> => <<"hello">>, <<"messages">> => []}).

all() ->
    [an_absent_local_rung_is_never_dialed,
     an_absent_local_rung_says_it_was_configuration,
     a_refusing_local_backend_falls_through,
     a_timing_out_local_backend_falls_through,
     a_crashing_local_backend_falls_through,
     a_malformed_local_answer_falls_through,
     every_non_object_answer_is_named_in_the_attempt,
     an_object_is_still_an_answer,
     an_unpriced_rung_never_passes_a_ceiling,
     a_free_local_rung_still_serves_a_ceiling_of_zero,
     resolve_all_never_raises_on_a_hostile_local_configuration,
     no_local_failure_mode_raises_out_of_complete].

init_per_suite(Config) ->
    clear(),
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    Config.

end_per_suite(_Config) ->
    ok = application:stop(agora_provider_router),
    ok.

%% Every case states its whole configuration: a variable left set by the case before it would
%% configure a rung nobody asked for, which is the state this whole file exists to deny.
init_per_testcase(_Case, Config) -> clear(), Config.
end_per_testcase(_Case, _Config) -> clear(), ok.

clear() -> lists:foreach(fun os:unsetenv/1, ?VARS).

%% A transport that records what it was handed and answers `Answer'.
recording(Answer) ->
    Self = self(),
    fun(Backend, _Payload) ->
            Self ! {dialed, maps:get(tier, Backend)},
            Answer
    end.

dialed_tiers() ->
    receive
        {dialed, Tier} -> [Tier | dialed_tiers()]
    after 0 ->
        []
    end.

complete(Payload, Options) -> apr_router:complete(text, Payload, Options).

attempt(Tier, Completion) ->
    [Attempt] = [A || A <- maps:get(attempts, Completion), maps:get(tier, A) =:= Tier],
    Attempt.

%% --- (a) absent -------------------------------------------------------------

an_absent_local_rung_is_never_dialed(_Config) ->
    %% Both keyless tiers named in the ladder and neither one configured: the request lands on
    %% the placeholder having contacted nothing at all.
    os:putenv(?LADDER, "local,mlx"),
    Completion = complete(?PROMPT, #{transport => recording({ok, {obj, []}})}),
    placeholder = apr_router:completion_tier(Completion),
    [] = dialed_tiers(),
    [false, false] = [maps:get(dialed, A) || A <- maps:get(attempts, Completion),
                                             maps:get(tier, A) =/= placeholder],
    ok.

an_absent_local_rung_says_it_was_configuration(_Config) ->
    %% Absent is not unreachable: nothing was contacted, so nothing could have been spent, and
    %% the reason names the configuration rather than the network.
    lists:foreach(
      fun({Tier, Provider}) ->
              os:putenv(?LADDER, atom_to_list(Tier)),
              Completion = complete(?PROMPT, #{transport => recording({ok, {obj, []}})}),
              placeholder = apr_router:completion_tier(Completion),
              Attempt = attempt(Tier, Completion),
              false = maps:get(dialed, Attempt),
              false = maps:get(ok, Attempt),
              <<"-">> = maps:get(provider, Attempt),
              Expected = <<Provider/binary, " base URL not set">>,
              Expected = maps:get(reason, Attempt)
      end,
      [{local, apr_backends:local_provider()}, {mlx, apr_backends:mlx_provider()}]),
    ok.

%% --- (b) refusing connections ----------------------------------------------

a_refusing_local_backend_falls_through(_Config) ->
    %% The address is configured and the server is not running.
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    Completion = complete(?PROMPT, #{transport => recording({error, <<"econnrefused">>})}),
    placeholder = apr_router:completion_tier(Completion),
    [local] = dialed_tiers(),
    Attempt = attempt(local, Completion),
    %% Contacted and silent, not skipped: a budget audit must tell the two apart.
    true = maps:get(dialed, Attempt),
    false = maps:get(ok, Attempt),
    <<"econnrefused">> = maps:get(reason, Attempt),
    %% The caller still gets an answer, and it cost nothing.
    true = apr_cost:units(maps:get(actual, Completion)) == 0.0,
    ok.

%% --- (c) never answering ----------------------------------------------------

a_timing_out_local_backend_falls_through(_Config) ->
    %% Accepted the connection and went away — the failure a model server loading a 20GB
    %% checkpoint actually presents. The per-rung deadline fires and the walk continues.
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    Slow = fun(_Backend, _Payload) -> timer:sleep(1000), {ok, {obj, []}} end,
    Completion = complete(?PROMPT, #{transport => Slow, call_timeout => 100}),
    placeholder = apr_router:completion_tier(Completion),
    <<"timeout">> = maps:get(reason, attempt(local, Completion)),
    ok.

%% --- the tree's own failure mode -------------------------------------------

a_crashing_local_backend_falls_through(_Config) ->
    %% A transport that raises takes down only this rung's worker; its supervisor restarts it
    %% and the request completes on the placeholder.
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    Boom = fun(_Backend, _Payload) -> error(boom) end,
    Completion = complete(?PROMPT, #{transport => Boom}),
    placeholder = apr_router:completion_tier(Completion),
    _ = attempt(local, Completion),
    timer:sleep(150),
    true = is_pid(whereis(apr_rung_worker:name(text, local))),
    ok.

%% --- (d) answering with garbage --------------------------------------------

a_malformed_local_answer_falls_through(_Config) ->
    %% Decodable and still not an answer: the object is the shape every modality's response is
    %% read out of, so a bare array would be settled and relayed as though it were a completion.
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    Garbage = {ok, [<<"not">>, <<"a">>, <<"completion">>]},
    Completion = complete(?PROMPT, #{transport => recording(Garbage)}),
    placeholder = apr_router:completion_tier(Completion),
    [local] = dialed_tiers(),
    Attempt = attempt(local, Completion),
    <<"malformed response: expected a JSON object, got array">> = maps:get(reason, Attempt),
    %% Dialed, so it may well have billed — the audit must not read it as a skip.
    true = maps:get(dialed, Attempt),
    false = maps:get(ok, Attempt),
    ok.

every_non_object_answer_is_named_in_the_attempt(_Config) ->
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    lists:foreach(
      fun({Answer, Named}) ->
              Completion = complete(?PROMPT, #{transport => recording({ok, Answer})}),
              placeholder = apr_router:completion_tier(Completion),
              Expected = <<"malformed response: expected a JSON object, got ", Named/binary>>,
              Expected = maps:get(reason, attempt(local, Completion))
      end,
      [{[<<"a">>], <<"array">>},
       {<<"a string">>, <<"string">>},
       {7, <<"number">>},
       {7.5, <<"number">>},
       {true, <<"boolean">>},
       {null, <<"null">>},
       {{a, tuple}, <<"a non-JSON value">>}]),
    _ = dialed_tiers(),
    ok.

an_object_is_still_an_answer(_Config) ->
    %% The guard refuses a shape, not a body: an empty object is a legal completion, and a map
    %% is the other spelling {@link apr_json} accepts for one.
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    lists:foreach(
      fun(Answer) ->
              Completion = complete(?PROMPT, #{transport => recording({ok, Answer})}),
              local = apr_router:completion_tier(Completion),
              Answer = apr_router:response(Completion),
              true = maps:get(ok, attempt(local, Completion))
      end,
      [{obj, []}, #{}, {obj, [{<<"id">>, <<"upstream">>}]}]),
    _ = dialed_tiers(),
    ok.

%% --- §2.3: the guards on the dispatch paths this tasklist touched -----------

an_unpriced_rung_never_passes_a_ceiling(_Config) ->
    %% The rule the ceiling rests on, restated where the local tier is the fall-through: "we
    %% don't know what this costs" must never route around a ceiling the way "free"
    %% legitimately does. `within/2' is what {@link apr_rung_worker} consults before it dials,
    %% so a rung it refuses is one the transport is never handed.
    Unpriced = apr_cost:project(text, <<"some-new-vendor">>, {obj, []}, #{}),
    true = maps:get(unpriced, Unpriced),
    true = apr_cost:units(Unpriced) == 0.0,
    false = apr_cost:within(Unpriced, 0.0),
    false = apr_cost:within(Unpriced, 1000000.0),
    %% And the skip-without-dialing path itself, with a configured local rung under it: the
    %% paid rung is priced over the ceiling, refused undialed, and the free local one serves.
    os:putenv(?LADDER, "paid,local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    os:putenv(?KEY_VAR, "sk-secret-should-not-leak"),
    Completion = complete(?PROMPT, #{transport => recording({ok, {obj, []}}),
                                     budget_units => 0.0}),
    local = apr_router:completion_tier(Completion),
    [local] = dialed_tiers(),
    false = maps:get(dialed, attempt(paid, Completion)),
    ok.

a_free_local_rung_still_serves_a_ceiling_of_zero(_Config) ->
    %% The other half of the same rule: free is *priced*, so it passes every ceiling — and the
    %% local rung it is dialed on is the one whose headers and address this tasklist moved.
    os:putenv(?LADDER, "local"),
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    Completion = complete(?PROMPT, #{transport => recording({ok, {obj, []}}),
                                     budget_units => 0.0}),
    local = apr_router:completion_tier(Completion),
    [local] = dialed_tiers(),
    Projected = maps:get(projected, Completion),
    false = maps:get(unpriced, Projected),
    true = apr_cost:units(Projected) == 0.0,
    ok.

resolve_all_never_raises_on_a_hostile_local_configuration(_Config) ->
    %% `/doctor' answers whatever the operator put in the environment, including an address
    %% no parser can make sense of — which `local_bind/1' reads as `remote', because "I could
    %% not tell" must not read as "it stays on the box".
    os:putenv(?LADDER, "local,not-a-tier"),
    os:putenv(?OLLAMA_VAR, "://:::"),
    os:putenv(?MLX_VAR, "   "),
    os:putenv("AGORA_PREFER_LOCAL", "maybe"),
    Config = apr_config:from_env(),
    Ladders = apr_ladder:resolve_all(apr_config:ladder_env(Config)),
    Text = apr_json:get(<<"text">>, Ladders),
    true = apr_json:get(<<"error">>, Text) =/= undefined,
    %% And the same configuration through the whole doctor path, which resolves rungs.
    Doctor = apr_router:doctor(),
    Modalities = apr_json:get(<<"modalities">>, Doctor),
    ResolvesTo = apr_json:get(<<"resolves_to">>, apr_json:get(<<"text">>, Modalities)),
    <<"local">> = apr_json:get(<<"tier">>, ResolvesTo),
    <<"remote">> = apr_json:get(<<"bind">>, ResolvesTo),
    %% Encodable, so the report is servable rather than merely computable.
    true = byte_size(apr_json:encode(Doctor)) > 0,
    ok.

no_local_failure_mode_raises_out_of_complete(_Config) ->
    %% The invariant in one line, over every failure this file names, for every modality.
    os:putenv(?OLLAMA_VAR, ?OLLAMA),
    os:putenv(?MLX_VAR, ?MLX),
    Broken = [fun(_B, _P) -> {error, <<"econnrefused">>} end,
              fun(_B, _P) -> {ok, [<<"garbage">>]} end,
              fun(_B, _P) -> {ok, null} end,
              fun(_B, _P) -> error(boom) end],
    lists:foreach(
      fun(Transport) ->
              lists:foreach(
                fun(Modality) ->
                        Completion = apr_router:complete(Modality, ?PROMPT,
                                                         #{transport => Transport}),
                        placeholder = apr_router:completion_tier(Completion)
                end, apr_ladder:modalities())
      end, Broken),
    ok.
