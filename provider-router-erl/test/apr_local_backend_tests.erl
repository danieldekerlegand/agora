%%% @doc eunit: the local tier's address is the operator's, never a library's default.
%%%
%%% The Erlang half of `tests/test_local_backend.py'. The rung exists **if and only if** a base
%%% URL was configured, and that is stated twice on purpose: once at resolution (an
%%% unconfigured local tier is `unconfigured', so no backend is ever built for it) and once at
%%% dispatch ({@link apr_backends:dispatch_url/1}, so no injected transport can substitute an
%%% address on its way out). LiteLLM defaults `ollama' to `http://localhost:11434' and it is
%%% not alone; inheriting any such default would make "no local server configured" a claim
%%% about whatever happens to be listening on the box, which is precisely the state the
%%% zero-spend invariant has to be able to assert. See `docs/spike-litellm-leaf.md' N2/N3,
%%% where that default was caught.
-module(apr_local_backend_tests).
-include_lib("eunit/include/eunit.hrl").

%% The addresses these tests configure. Deliberately not loopback-looking, so a test that
%% passed by accident of something listening locally would be visible as such.
-define(OLLAMA, "http://ollama.test:11434/v1").
-define(MLX, "http://mlx.test:8080/v1").

resolve(Tier, Env) -> apr_backends:resolve_tier(Tier, text, apr_config:from_env(Env)).

backend(Provider, BaseUrl) ->
    #{tier => local, provider => Provider, modality => text, model => <<"m">>,
      base_url => BaseUrl, api_key => undefined, wire => openai, path => undefined}.

%% --- a rung exists only by configuration ------------------------------------

no_configured_address_is_no_rung_test() ->
    lists:foreach(
      fun({Tier, Provider}) ->
              Resolution = resolve(Tier, #{}),
              ?assertEqual(unconfigured, maps:get(status, Resolution)),
              ?assertEqual(undefined, maps:get(backend, Resolution)),
              ?assertEqual(<<Provider/binary, " base URL not set">>,
                           maps:get(reason, Resolution))
      end,
      [{local, apr_backends:local_provider()}, {mlx, apr_backends:mlx_provider()}]).

a_configured_address_is_the_one_that_resolves_test() ->
    lists:foreach(
      fun({Tier, Var, Address}) ->
              Resolution = resolve(Tier, #{Var => Address}),
              ?assertEqual(ready, maps:get(status, Resolution)),
              Backend = maps:get(backend, Resolution),
              ?assert(lists:member(maps:get(provider, Backend),
                                   apr_backends:local_providers())),
              ?assertEqual(list_to_binary(Address), maps:get(base_url, Backend)),
              ?assertEqual(list_to_binary(Address ++ "/chat/completions"),
                           apr_backends:backend_url(Backend))
      end,
      [{local, "OLLAMA_BASE_URL", ?OLLAMA}, {mlx, "MLX_SERVE_BASE_URL", ?MLX}]).

the_ollama_host_spelling_configures_it_too_test() ->
    %% A fallback spelling, never a fallback *value*.
    Resolution = resolve(local, #{"OLLAMA_HOST" => ?OLLAMA}),
    ?assertEqual(<<?OLLAMA>>, maps:get(base_url, maps:get(backend, Resolution))),
    ?assertEqual(unconfigured, maps:get(status, resolve(local, #{"OLLAMA_HOST" => ""}))).

an_explicitly_disabled_local_provider_is_no_rung_either_test() ->
    Env = #{"OLLAMA_BASE_URL" => ?OLLAMA, "AGORA_PROVIDER_OLLAMA_ENABLED" => "0"},
    ?assertEqual(unconfigured, maps:get(status, resolve(local, Env))).

a_bare_report_names_no_local_address_at_all_test() ->
    %% `/doctor' on a keyless, serverless box: every rung it names is one it was given.
    Reported = apr_json:encode(apr_backends:resolution_describe(resolve(local, #{}))),
    ?assertEqual(nomatch, binary:match(Reported, <<"11434">>)),
    ?assertEqual(nomatch, binary:match(Reported, <<"localhost">>)).

%% --- and no transport substitutes a default ---------------------------------

a_local_backend_without_an_address_is_refused_not_dialed_test() ->
    lists:foreach(
      fun(Provider) ->
              {error, Reason} = apr_backends:dispatch_url(backend(Provider, undefined)),
              ?assertNotEqual(nomatch, binary:match(Reason, Provider)),
              ?assertNotEqual(nomatch, binary:match(Reason, <<"never dialed at">>)),
              ?assertMatch({error, _}, apr_backends:dispatch_url(backend(Provider, <<>>)))
      end,
      apr_backends:local_providers()).

the_configured_address_is_what_is_dialed_test() ->
    Backend = backend(apr_backends:local_provider(), <<?OLLAMA>>),
    ?assertEqual({ok, <<?OLLAMA, "/chat/completions">>}, apr_backends:dispatch_url(Backend)).

a_paid_rung_may_still_carry_no_address_of_its_own_test() ->
    %% A vendor address is public vocabulary; a local one is a fact about an operator's box.
    Paid = (backend(<<"anthropic">>, undefined))#{tier := paid},
    ?assertEqual({ok, <<"/chat/completions">>}, apr_backends:dispatch_url(Paid)).
