%%% @doc eunit: the local tier's address is the operator's, never a library's default.
%%%
%%% The Erlang half of `tests/test_local_backend.py'. The rung exists **if and only if** a base
%%% URL was configured, and that is stated twice on purpose: once at resolution (an
%%% unconfigured local tier is `unconfigured', so no backend is ever built for it) and once at
%%% dispatch ({@link apr_backends:dispatch_url/1}, so no injected transport can substitute an
%%% address on its way out). LiteLLM defaults `ollama' to `http://localhost:11434' and it is
%%% not alone; inheriting any such default would make "no local server configured" a claim
%%% about whatever happens to be listening on the box, which is precisely the state the
%%% zero-spend invariant has to be able to assert.
%%%
%%% The other two thirds of the posture are here too, because they are the same subject: where
%%% an unauthenticated local server is expected to be bound (and what the router says when it
%%% is not), and the credential it carries for one that is authenticated. All three are
%%% `docs/local-backend-posture.md'.
-module(apr_local_backend_tests).
-include_lib("eunit/include/eunit.hrl").

%% The addresses these tests configure. Deliberately not loopback-looking, so a test that
%% passed by accident of something listening locally would be visible as such.
-define(OLLAMA, "http://ollama.test:11434/v1").
-define(MLX, "http://mlx.test:8080/v1").

%% A loopback address per tier — the *expected* deployment, since an unauthenticated local
%% server is safe by where it is bound and by nothing else.
-define(OLLAMA_LOOPBACK, "http://127.0.0.1:11434/v1").
-define(MLX_LOOPBACK, "http://localhost:8080/v1").

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

%% --- the bind posture is classified, not assumed ----------------------------

%% The router does not *enforce* loopback — an operator running a model server on another box
%% on their network has a real deployment, and refusing it would be this commons deciding
%% somebody's topology. It classifies and reports instead, so the remote case is an explicit
%% choice rather than one indistinguishable from the safe one.

loopback_addresses_are_recognised_test() ->
    lists:foreach(
      fun(Address) ->
              ?assertEqual(loopback, apr_backends:local_bind(list_to_binary(Address)))
      end,
      [?OLLAMA_LOOPBACK, "http://127.0.0.1:11434", ?MLX_LOOPBACK,
       "HTTP://LocalHost:8080/v1", "http://[::1]:11434/v1", "http://127.5.6.7/v1",
       "http://ollama.localhost:11434/v1",
       %% A bare `host:port' is how `OLLAMA_HOST' is spelled in the wild, and it is not a
       %% URI scheme however much it parses as one.
       "localhost:11434", "127.0.0.1:11434"]).

anything_not_demonstrably_loopback_is_remote_test() ->
    lists:foreach(
      fun(Address) ->
              ?assertEqual(remote, apr_backends:local_bind(list_to_binary(Address)))
      end,
      [?OLLAMA, ?MLX, "http://10.0.0.4:11434/v1", "http://0.0.0.0:11434/v1",
       "https://ollama.internal.example/v1", "http://[2001:db8::1]:11434/v1",
       "http://localhost.example.com:11434/v1",
       %% Not demonstrably loopback is remote: an unparseable host is the operator's to
       %% explain, and "I could not tell" must not read as "it stays on the box".
       "://:::", "ollama.test:11434", "   "]).

no_address_is_nothing_to_classify_test() ->
    %% Nothing to classify on exactly the values {@link apr_backends:dispatch_url/1} calls no
    %% address, so a rung that will be dialed always reports where it is being dialed.
    ?assertEqual(undefined, apr_backends:local_bind(undefined)),
    ?assertEqual(undefined, apr_backends:local_bind(<<>>)).

a_loopback_rung_is_ready_and_says_nothing_further_test() ->
    lists:foreach(
      fun({Tier, Var, Address}) ->
              Resolution = resolve(Tier, #{Var => Address}),
              ?assertEqual(ready, maps:get(status, Resolution)),
              ?assertEqual(undefined, maps:get(reason, Resolution)),
              ?assertEqual({obj, [{<<"bind">>, <<"loopback">>}]},
                           bind_only(apr_backends:resolution_describe(Resolution)))
      end,
      [{local, "OLLAMA_BASE_URL", ?OLLAMA_LOOPBACK},
       {mlx, "MLX_SERVE_BASE_URL", ?MLX_LOOPBACK}]).

a_remote_rung_is_ready_but_marked_test() ->
    %% Allowed, because configured; never silent, because it was designed for loopback.
    lists:foreach(
      fun({Tier, Var, Address}) ->
              Resolution = resolve(Tier, #{Var => Address}),
              ?assertEqual(ready, maps:get(status, Resolution)),
              Reason = maps:get(reason, Resolution),
              ?assertNotEqual(nomatch, binary:match(Reason, <<"non-loopback">>)),
              ?assertNotEqual(nomatch, binary:match(Reason, list_to_binary(Address))),
              ?assertNotEqual(nomatch, binary:match(Reason, <<"explicit operator choice">>)),
              ?assertEqual({obj, [{<<"bind">>, <<"remote">>}]},
                           bind_only(apr_backends:resolution_describe(Resolution)))
      end,
      [{local, "OLLAMA_BASE_URL", ?OLLAMA}, {mlx, "MLX_SERVE_BASE_URL", ?MLX}]).

the_two_are_distinguishable_on_a_report_test() ->
    %% The whole point: a report cannot show the two deployments as the same thing.
    Remote = apr_json:encode(
               apr_backends:resolution_describe(resolve(local, #{"OLLAMA_BASE_URL" => ?OLLAMA}))),
    Loopback = apr_json:encode(
                 apr_backends:resolution_describe(
                   resolve(local, #{"OLLAMA_BASE_URL" => ?OLLAMA_LOOPBACK}))),
    ?assertNotEqual(nomatch, binary:match(Remote, <<"\"bind\":\"remote\"">>)),
    ?assertNotEqual(nomatch, binary:match(Loopback, <<"\"bind\":\"loopback\"">>)),
    ?assertNotEqual(nomatch, binary:match(Remote, <<"non-loopback">>)),
    ?assertEqual(nomatch, binary:match(Loopback, <<"non-loopback">>)).

only_a_local_rung_describes_a_bind_test() ->
    %% A paid vendor's address is public vocabulary, not a claim about anyone's network.
    Paid = (backend(<<"openai">>, <<"https://api.openai.com/v1">>))#{tier := paid},
    ?assertEqual({obj, []}, bind_only(apr_backends:backend_describe(Paid))),
    Placeholder = apr_backends:placeholder_backend(text),
    ?assertEqual({obj, []}, bind_only(apr_backends:backend_describe(Placeholder))).

%% --- auth is optional, carried, and never fabricated ------------------------

-define(JSON_HEADER, {<<"content-type">>, <<"application/json">>}).

a_configured_credential_reaches_the_backend_and_the_headers_test() ->
    lists:foreach(
      fun({Tier, Var, Address, KeyVar}) ->
              Env = #{Var => Address, KeyVar => "local-proxy-token"},
              Backend = maps:get(backend, resolve(Tier, Env)),
              ?assertEqual(<<"local-proxy-token">>, maps:get(api_key, Backend)),
              ?assertEqual([?JSON_HEADER,
                            {<<"authorization">>, <<"Bearer local-proxy-token">>}],
                           apr_backends:dispatch_headers(Backend))
      end,
      [{local, "OLLAMA_BASE_URL", ?OLLAMA, "AGORA_PROVIDER_OLLAMA_API_KEY"},
       {mlx, "MLX_SERVE_BASE_URL", ?MLX, "AGORA_PROVIDER_MLX_SERVE_API_KEY"}]).

no_credential_means_no_header_at_all_test() ->
    %% Not an empty bearer — a permissive backend would take it and a strict one would reject
    %% it for a reason that has nothing to do with the operator's configuration.
    lists:foreach(
      fun({Tier, Var, Address}) ->
              Backend = maps:get(backend, resolve(Tier, #{Var => Address})),
              ?assertEqual(undefined, maps:get(api_key, Backend)),
              ?assertEqual([?JSON_HEADER], apr_backends:dispatch_headers(Backend))
      end,
      [{local, "OLLAMA_BASE_URL", ?OLLAMA}, {mlx, "MLX_SERVE_BASE_URL", ?MLX}]).

an_empty_credential_is_no_credential_test() ->
    Backend = (backend(apr_backends:local_provider(), <<?OLLAMA>>))#{api_key := <<>>},
    ?assertEqual([?JSON_HEADER], apr_backends:dispatch_headers(Backend)).

a_credential_is_not_an_address_test() ->
    %% The address rule is untouched by the auth rule: a key alone still buys no rung.
    lists:foreach(
      fun({Tier, KeyVar}) ->
              Resolution = resolve(Tier, #{KeyVar => "k"}),
              ?assertEqual(unconfigured, maps:get(status, Resolution)),
              ?assertEqual(undefined, maps:get(backend, Resolution))
      end,
      [{local, "AGORA_PROVIDER_OLLAMA_API_KEY"},
       {mlx, "AGORA_PROVIDER_MLX_SERVE_API_KEY"}]).

a_local_credential_is_never_reported_test() ->
    Env = #{"OLLAMA_BASE_URL" => ?OLLAMA, "AGORA_PROVIDER_OLLAMA_API_KEY" => "local-proxy-token"},
    Reported = apr_json:encode(apr_backends:resolution_describe(resolve(local, Env))),
    ?assertEqual(nomatch, binary:match(Reported, <<"local-proxy-token">>)),
    Config = apr_json:encode(apr_config:describe(apr_config:from_env(Env))),
    ?assertEqual(nomatch, binary:match(Config, <<"local-proxy-token">>)).

the_paid_tier_is_dialed_by_the_same_rule_test() ->
    %% One decision point for every tier, so neither can drift from the other.
    Backend = maps:get(backend, resolve(paid, #{"OPENAI_API_KEY" => "sk-test"})),
    ?assertEqual([?JSON_HEADER, {<<"authorization">>, <<"Bearer sk-test">>}],
                 apr_backends:dispatch_headers(Backend)).

%% The `bind' pair of a describe object, or an empty object when it carries none — so a test
%% pins the field's presence without restating every other field beside it.
bind_only({obj, Fields}) ->
    {obj, [{K, V} || {K, V} <- Fields, K =:= <<"bind">>]}.
