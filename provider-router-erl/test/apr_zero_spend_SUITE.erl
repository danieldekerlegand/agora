%%% @doc common_test: the ZERO-SPEND / always-completes invariant, ported from
%%% `tests/test_zero_spend.py' onto the supervision tree.
%%%
%%% The contract the whole ladder exists to keep: with no keys and no local servers, every
%%% modality resolves to the deterministic placeholder, no call raises, and nothing is
%%% dialed. The last two cases exercise the tree itself — a crashing rung and a timing-out
%%% rung both fall through to the placeholder without taking the request (or the node) down,
%%% the OTP expression of `router.py''s "record an attempt and walk on".
-module(apr_zero_spend_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1]).
-export([bare_env_resolves_every_modality_to_placeholder/1,
         nothing_is_dialed/1,
         broken_ladder_variable_still_completes/1,
         placeholder_is_deterministic_and_free/1,
         a_reordered_payload_yields_the_same_stand_in/1,
         placeholder_artifact_declares_itself/1,
         a_crashing_rung_falls_through_to_placeholder/1,
         a_timing_out_rung_falls_through_to_placeholder/1]).

-define(KEY_VAR, "AGORA_PROVIDER_OPENAI_API_KEY").

all() ->
    [bare_env_resolves_every_modality_to_placeholder,
     nothing_is_dialed,
     broken_ladder_variable_still_completes,
     placeholder_is_deterministic_and_free,
     a_reordered_payload_yields_the_same_stand_in,
     placeholder_artifact_declares_itself,
     a_crashing_rung_falls_through_to_placeholder,
     a_timing_out_rung_falls_through_to_placeholder].

init_per_suite(Config) ->
    %% Start from a genuinely bare environment — clear anything that could configure a rung.
    lists:foreach(fun os:unsetenv/1,
                  [?KEY_VAR, "OPENAI_API_KEY", "AGORA_TEXT_LADDER", "AGORA_PREFER_LOCAL"]),
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    Config.

end_per_suite(_Config) ->
    ok = application:stop(agora_provider_router),
    ok.

bare_env_resolves_every_modality_to_placeholder(_Config) ->
    Cfg = apr_config:from_env(),
    lists:foreach(
      fun(Modality) ->
              placeholder = maps:get(tier, apr_router:resolve(Modality, Cfg)),
              %% The placeholder is the ONLY ready rung — nothing else claims to be usable.
              [placeholder] = [maps:get(tier, B) || B <- apr_router:candidates(Modality, Cfg)]
      end, apr_ladder:modalities()),
    ok.

nothing_is_dialed(_Config) ->
    Self = self(),
    Recorder = fun(Backend, _Payload) ->
                       Self ! {dialed, Backend},
                       {ok, {obj, [{<<"id">>, <<"upstream">>}]}}
               end,
    lists:foreach(
      fun(Modality) ->
              Completion = apr_router:complete(Modality, #{<<"prompt">> => <<"hello">>},
                                               #{transport => Recorder}),
              placeholder = apr_router:completion_tier(Completion),
              true = apr_json:keys(apr_router:response(Completion)) =/= [],
              %% Nothing was spent, and the report says so rather than leaving it implied.
              %% Compared, not matched: a `0.0' pattern is a warning in OTP 27+ (`-0.0').
              true = apr_cost:units(maps:get(actual, Completion)) == 0.0
      end, apr_ladder:modalities()),
    receive
        {dialed, B} -> ct:fail({dialed_a_backend, B})
    after 50 ->
        ok
    end.

broken_ladder_variable_still_completes(_Config) ->
    os:putenv("AGORA_TEXT_LADDER", "not-a-tier"),
    try
        Completion = apr_router:complete(text, #{<<"messages">> => []}),
        placeholder = apr_router:completion_tier(Completion),
        Doctor = apr_router:doctor(),
        Body = apr_json:encode(Doctor),
        {_, _} = binary:match(Body, <<"not-a-tier">>)
    after
        os:unsetenv("AGORA_TEXT_LADDER")
    end,
    ok.

placeholder_is_deterministic_and_free(_Config) ->
    Payload = #{<<"messages">> => [#{<<"role">> => <<"user">>, <<"content">> => <<"same">>}],
               <<"temperature">> => 1},
    First = apr_router:complete(text, Payload),
    Second = apr_router:complete(text, Payload),
    Response = apr_router:response(First),
    Response = apr_router:response(Second),
    %% Byte-identical, not merely equal: the response is relayed verbatim, so its key order
    %% is part of what a conformance scenario pins.
    Encoded = apr_json:encode(Response),
    Encoded = apr_json:encode(apr_router:response(Second)),
    Usage = apr_json:get(<<"usage">>, Response),
    0 = apr_json:get(<<"total_tokens">>, Usage),
    [Choice | _] = apr_json:get(<<"choices">>, Response),
    Content = apr_json:get(<<"content">>, apr_json:get(<<"message">>, Choice)),
    {_, _} = binary:match(Content, <<"placeholder">>),
    ok.

a_reordered_payload_yields_the_same_stand_in(_Config) ->
    %% The digest is canonical (sorted keys), so two callers who send the same fields in a
    %% different order get the same deterministic stand-in back.
    A = {obj, [{<<"prompt">>, <<"a cat">>}, {<<"n">>, 1}]},
    B = {obj, [{<<"n">>, 1}, {<<"prompt">>, <<"a cat">>}]},
    Digest = apr_placeholder:digest(A),
    Digest = apr_placeholder:digest(B),
    ok.

placeholder_artifact_declares_itself(_Config) ->
    lists:foreach(
      fun(Modality) ->
              Response = apr_placeholder:complete(Modality, #{<<"prompt">> => <<"a cat">>},
                                                  <<"placeholder">>),
              [Artifact | _] = apr_json:get(<<"data">>, Response),
              true = apr_json:get(<<"placeholder">>, Artifact),
              MediaType = apr_json:get(<<"media_type">>, Artifact),
              [Family | _] = binary:split(MediaType, <<"/">>),
              true = lists:member(Family, [<<"image">>, <<"audio">>, <<"video">>])
      end, [image, speech, music, video]),
    ok.

a_crashing_rung_falls_through_to_placeholder(_Config) ->
    %% A configured paid rung whose transport raises: the worker crashes, its supervisor
    %% restarts it, and the request still completes on the placeholder — the crash never
    %% reaches the caller (nor the node).
    os:putenv(?KEY_VAR, "sk-secret-should-not-leak"),
    try
        Boom = fun(_Backend, _Payload) -> error(boom) end,
        Completion = apr_router:complete(text, #{<<"prompt">> => <<"hi">>},
                                         #{transport => Boom}),
        placeholder = apr_router:completion_tier(Completion),
        Attempts = maps:get(attempts, Completion),
        true = lists:any(fun(A) -> maps:get(tier, A) =:= paid end, Attempts),
        %% The crashed rung worker is back — the supervisor healed it.
        timer:sleep(150),
        true = is_pid(whereis(apr_rung_worker:name(text, paid)))
    after
        os:unsetenv(?KEY_VAR)
    end,
    ok.

a_timing_out_rung_falls_through_to_placeholder(_Config) ->
    %% A configured paid rung slower than its deadline: the router's per-rung timeout fires,
    %% the attempt is recorded as a timeout, and the walk falls through to the placeholder.
    os:putenv(?KEY_VAR, "sk-secret-should-not-leak"),
    try
        Slow = fun(_Backend, _Payload) -> timer:sleep(1000), {ok, #{}} end,
        Completion = apr_router:complete(text, #{<<"prompt">> => <<"hi">>},
                                         #{transport => Slow, call_timeout => 100}),
        placeholder = apr_router:completion_tier(Completion),
        Attempts = maps:get(attempts, Completion),
        true = lists:any(
                 fun(A) ->
                         maps:get(tier, A) =:= paid
                             andalso maps:get(reason, A, undefined) =:= <<"timeout">>
                 end, Attempts)
    after
        os:unsetenv(?KEY_VAR)
    end,
    ok.
