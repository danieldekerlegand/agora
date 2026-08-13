%%% @doc common_test: the external contract, judged against the Python router byte for byte.
%%%
%%% This is the supersession gate (ADR-0004). Everything else in this suite directory tests a
%%% behaviour; this one tests an *equality*: the same request corpus, driven over real HTTP
%%% against the running OTP application, must come back as the same bytes the Python router
%%% (agora:50) answers with — key order, float spelling, separators and all. Equivalent JSON
%%% is not the bar. A caller that parses one and re-serialises it must get the other.
%%%
%%% The corpus lives in `apr_conformance_SUITE_data/python-surface.json', captured from the
%%% Python app itself (see `capture_python_surface.py' in the same directory, which carries
%%% the regenerate command). It pins two environments — bare, where every modality falls to
%%% the placeholder, and keyed, where a ceiling of zero refuses the paid rung without dialing
%%% it — across all five generation routes, the five reads and the legacy manifest redirect.
%%%
%%% The console's captured session
%%% (`console/src/fixtures/provider-router.session.json') is pinned separately, because it is
%%% a *third* party's copy of the same exchange: the conformance console replays it instead
%%% of opening a socket, so the Erlang router has to satisfy the identical fixture for the
%%% console's scenario to still be a capture of the router it claims to describe.
%%%
%%% Cross-area files are optional. `provider-router-erl/' must stay extractable on its own, so
%%% an absent `console/' or `schemas/' skips its case (reporting the skip) rather than failing
%%% it — the same rule the Python suite spells with `pytest.mark.skipif'.
-module(apr_conformance_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1, init_per_testcase/2, end_per_testcase/2]).
-export([the_bare_surface_is_byte_identical_to_the_python_router/1,
         the_keyed_surface_is_byte_identical_to_the_python_router/1,
         the_console_captured_session_is_still_a_capture_of_this_router/1,
         the_kcb_version_is_pinned_to_the_typescript_schemas_package/1,
         the_budget_unit_anchor_is_pinned_to_the_python_cost_model/1,
         no_read_endpoint_echoes_a_configured_key/1,
         a_failed_rung_redacts_the_key_from_its_reason/1,
         an_absent_sibling_area_is_a_skip_not_a_failure/1]).

%% The key a leak test looks for. Long and distinctive: a substring search for it must not be
%% able to match anything the router legitimately reports.
-define(KEY, "sk-super-secret-not-a-real-key").
-define(KEY_VAR, "AGORA_PROVIDER_OPENAI_API_KEY").

%% Every environment variable that can change what the surface says. Cleared before each
%% case so the answer is a function of the fixture, never of the host that runs it.
-define(SCRUBBED_PREFIXES, ["AGORA_"]).

all() ->
    [the_bare_surface_is_byte_identical_to_the_python_router,
     the_keyed_surface_is_byte_identical_to_the_python_router,
     the_console_captured_session_is_still_a_capture_of_this_router,
     the_kcb_version_is_pinned_to_the_typescript_schemas_package,
     the_budget_unit_anchor_is_pinned_to_the_python_cost_model,
     no_read_endpoint_echoes_a_configured_key,
     a_failed_rung_redacts_the_key_from_its_reason,
     an_absent_sibling_area_is_a_skip_not_a_failure].

init_per_suite(Config) ->
    Saved = [{Name, os:getenv(Name)} || Name <- configuring_vars()],
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    {ok, _Inets} = application:ensure_all_started(inets),
    [{port, ranch:get_port(agora_provider_router_listener)},
     {saved_env, Saved},
     {surface, read_surface(Config)} | Config].

end_per_suite(Config) ->
    scrub(),
    lists:foreach(fun({Name, false}) -> os:unsetenv(Name);
                     ({Name, Value}) -> os:putenv(Name, Value)
                  end, ?config(saved_env, Config)),
    ok = application:stop(agora_provider_router),
    ok.

init_per_testcase(_Case, Config) ->
    scrub(),
    Config.

end_per_testcase(_Case, _Config) ->
    scrub(),
    ok.

%% --- the captured Python surface --------------------------------------------

the_bare_surface_is_byte_identical_to_the_python_router(Config) ->
    replay(<<"bare">>, Config).

the_keyed_surface_is_byte_identical_to_the_python_router(Config) ->
    replay(<<"keyed">>, Config).

replay(Name, Config) ->
    Environment = environment(Name, ?config(surface, Config)),
    apply_env(apr_json:get(<<"env">>, Environment)),
    lists:foreach(fun(Exchange) -> assert_exchange(?config(port, Config), Exchange) end,
                  apr_json:get(<<"exchanges">>, Environment)),
    ok.

%% One exchange: same status, same contract headers, same body bytes.
assert_exchange(Port, Exchange) ->
    Method = apr_json:get(<<"method">>, Exchange),
    Path = apr_json:get(<<"path">>, Exchange),
    {Status, Headers, Body} = request(Port, Exchange),
    Expected = apr_json:get(<<"body">>, Exchange),
    ExpectedStatus = apr_json:get(<<"status">>, Exchange),
    case {Status, Body} of
        {ExpectedStatus, Expected} -> ok;
        _ ->
            ct:fail({surface_diff, Method, Path,
                     {status, Status, ExpectedStatus},
                     {erlang, Body}, {python, Expected}})
    end,
    lists:foreach(
      fun({HeaderName, Value}) ->
              Got = proplists:get_value(binary_to_list(HeaderName), Headers),
              case Got =:= binary_to_list(Value) of
                  true -> ok;
                  false -> ct:fail({header_diff, Path, HeaderName, Got, Value})
              end
      end, apr_json:kvs(apr_json:get(<<"response_headers">>, Exchange))),
    ok.

%% --- the console's captured session -----------------------------------------

the_console_captured_session_is_still_a_capture_of_this_router(Config) ->
    Fixture = "console/src/fixtures/provider-router.session.json",
    case apr_testpaths:repo_file(Fixture) of
        not_found ->
            {skip, "standalone checkout: " ++ Fixture ++ " (the console fixture) is absent"};
        {ok, Path} ->
            apply_env(apr_json:get(<<"env">>, environment(<<"bare">>, ?config(surface, Config)))),
            Session = read_json(Path),
            %% The console replays the crawled manifest *body* — the AgentCard's one
            %% extension's params — and the one exchange it dials.
            Manifest = apr_json:encode(apr_manifest:body(apr_config:from_env())),
            Manifest = apr_json:encode(apr_json:get(<<"manifest">>, Session)),
            Captured = apr_json:get(<<"exchange">>, Session),
            {Status, _Headers, Body} = request(?config(port, Config), Captured),
            Status = apr_json:get(<<"status">>, Captured),
            Body = apr_json:encode(apr_json:get(<<"response">>, Captured)),
            %% ...and it is the zero-spend tier: the scenario's whole point is that no keys
            %% and no servers still completed, free.
            Routing = apr_json:get(<<"agora">>, apr_json:get(<<"response">>, Captured)),
            <<"placeholder">> = apr_json:get(<<"tier">>, Routing),
            ok
    end.

%% --- the cross-language spec-version pin ------------------------------------

the_kcb_version_is_pinned_to_the_typescript_schemas_package(_Config) ->
    %% The same guard `test_skeleton.py' puts on the Python constant, one area over: the KCB
    %% version this app reports is pinned to `schemas/src/versions.ts', so a spec bump turns
    %% the Erlang gate red exactly the way it turns the Python one red. Bump both together.
    Versions = "schemas/src/versions.ts",
    case apr_testpaths:repo_file(Versions) of
        not_found ->
            {skip, "standalone checkout: " ++ Versions ++ " (the TS schemas package) is absent"};
        {ok, Path} ->
            {ok, Source} = file:read_file(Path),
            Pinned = kcb_pin(Source),
            Reported = apr:kcb_version(),
            case Pinned =:= Reported of
                true -> ok;
                false -> ct:fail({kcb_version_drift, {schemas, Pinned}, {erlang, Reported}})
            end
    end.

%% `kcb: '0.2.0',' — the one pin in the file, quoted either way.
kcb_pin(Source) ->
    {match, [Version]} =
        re:run(Source, "kcb:\\s*['\"]([^'\"]+)['\"]", [{capture, [1], binary}]),
    Version.

the_budget_unit_anchor_is_pinned_to_the_python_cost_model(_Config) ->
    %% The `budget_units' denomination is one of the three rules both cost models keep
    %% hand-built rather than inherit from a pricing library
    %% (`docs/router-hand-built-behaviours.md' §2.2), and the Python router now applies it to
    %% a currency-denominated rate source (its optional LiteLLM price map). A ceiling travels
    %% between the two routers, so it is only the comparable scalar KCB §5 asks for while both
    %% anchor it identically — pinned here the way the KCB version above is, and from the
    %% other side by `test_cost.py', which runs where rebar3 is not installed.
    Cost = "provider-router/src/agora_provider_router/cost.py",
    case apr_testpaths:repo_file(Cost) of
        not_found ->
            {skip, "standalone checkout: " ++ Cost ++ " (the Python cost model) is absent"};
        {ok, Path} ->
            {ok, Source} = file:read_file(Path),
            Pinned = anchor_pin(Source),
            Reported = apr_cost:budget_units_per_usd(),
            case Pinned =:= Reported of
                true -> ok;
                false -> ct:fail({budget_unit_anchor_drift, {python, Pinned}, {erlang, Reported}})
            end
    end.

%% `BUDGET_UNITS_PER_USD = 100_000.0' — Python's digit separators stripped before parsing.
anchor_pin(Source) ->
    {match, [Digits]} =
        re:run(Source, "BUDGET_UNITS_PER_USD\\s*=\\s*([0-9_.]+)", [{capture, [1], binary}]),
    Cleaned = [C || C <- binary_to_list(Digits), C =/= $_],
    case string:to_float(Cleaned) of
        {Value, []} -> Value;
        _ -> float(list_to_integer(Cleaned))
    end.

%% --- no secret on any surface -----------------------------------------------

no_read_endpoint_echoes_a_configured_key(Config) ->
    %% `test_app.py::test_no_endpoint_reports_a_configured_key', ported. Every read is
    %% answered from a configuration that holds a key; none of them may contain it.
    true = os:putenv(?KEY_VAR, ?KEY),
    Port = ?config(port, Config),
    lists:foreach(
      fun(Path) ->
              {200, _Headers, Body} = get(Port, Path),
              case binary:match(Body, list_to_binary(?KEY)) of
                  nomatch -> ok;
                  _ -> ct:fail({key_leaked, Path})
              end
      end, ["/health", "/doctor", "/v1/models", "/v1/providers",
            binary_to_list(apr_manifest:manifest_path())]),
    ok.

a_failed_rung_redacts_the_key_from_its_reason(_Config) ->
    %% A transport error can quote the URL it was dialing, and a base URL can carry an
    %% embedded credential — so the rung's own key is redacted out of the reason before it
    %% reaches a log line or a response body (`router.py::_reason').
    true = os:putenv(?KEY_VAR, ?KEY),
    Leaky = fun(_Backend, _Payload) ->
                    {error, list_to_binary("connect to https://" ++ ?KEY ++ "@api.example failed")}
            end,
    Completion = apr_router:complete(text, #{<<"prompt">> => <<"hi">>}, #{transport => Leaky}),
    placeholder = apr_router:completion_tier(Completion),
    [Paid] = [A || A <- maps:get(attempts, Completion), maps:get(tier, A) =:= paid],
    Reason = maps:get(reason, Paid),
    nomatch = binary:match(Reason, list_to_binary(?KEY)),
    true = binary:match(Reason, <<"***">>) =/= nomatch,
    ok.

an_absent_sibling_area_is_a_skip_not_a_failure(_Config) ->
    %% The three cross-area assertions above look their file up rather than assuming a path,
    %% and an extracted `provider-router-erl/' has none of the siblings. A lookup that finds
    %% nothing must say so — the caller then skips, which ct reports; what must never happen
    %% is a case that quietly passes because it did nothing.
    not_found = apr_testpaths:repo_file("schemas/src/no-such-versions-file.ts"),
    ok.

%% --- fixtures ---------------------------------------------------------------

read_surface(Config) ->
    read_json(filename:join(?config(data_dir, Config), "python-surface.json")).

read_json(Path) ->
    {ok, Bytes} = file:read_file(Path),
    {ok, Decoded} = apr_json:decode(Bytes),
    Decoded.

environment(Name, Surface) ->
    [Environment] = [E || E <- apr_json:get(<<"environments">>, Surface),
                          apr_json:get(<<"name">>, E) =:= Name],
    Environment.

%% --- the environment --------------------------------------------------------

%% Every name that can configure the router: the two namespaced prefixes as they are set on
%% this host, plus the non-namespaced spellings `config.py' accepts as fallbacks.
configuring_vars() ->
    Live = [Name || Entry <- os:getenv(),
                    Name <- [hd(string:split(Entry, "="))],
                    lists:any(fun(Prefix) -> lists:prefix(Prefix, Name) end,
                              ?SCRUBBED_PREFIXES)],
    lists:usort(Live ++ standard_vars()).

standard_vars() ->
    ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "GROQ_API_KEY",
     "GEMINI_API_KEY", "GOOGLE_API_KEY", "REPLICATE_API_TOKEN", "ELEVENLABS_API_KEY",
     "RUNWAY_API_KEY", "LUMA_API_KEY", "MINIMAX_API_KEY", "MLX_SERVE_BASE_URL",
     "OLLAMA_BASE_URL", "OLLAMA_HOST"].

scrub() ->
    lists:foreach(fun os:unsetenv/1, configuring_vars()).

apply_env(Env) ->
    scrub(),
    lists:foreach(fun({Name, Value}) ->
                          true = os:putenv(binary_to_list(Name), binary_to_list(Value))
                  end, apr_json:kvs(Env)),
    %% The Python router has no translator, so conformance compares like with like: a host
    %% that happens to have built the Rust port program must not resolve a native-wire vendor
    %% the capture could not have (agora:60 / US-5 — `AGORA_TRANSLATOR=off' is the documented
    %% way to say so).
    true = os:putenv("AGORA_TRANSLATOR", "off"),
    ok.

%% --- HTTP -------------------------------------------------------------------

get(Port, Path) ->
    request(Port, {obj, [{<<"method">>, <<"GET">>}, {<<"path">>, list_to_binary(Path)}]}).

request(Port, Exchange) ->
    URL = "http://127.0.0.1:" ++ integer_to_list(Port)
        ++ binary_to_list(apr_json:get(<<"path">>, Exchange)),
    Headers = [{binary_to_list(Name), binary_to_list(Value)}
               || {Name, Value} <- apr_json:kvs(apr_json:get(<<"headers">>, Exchange, {obj, []}))],
    Request = case apr_json:get(<<"request">>, Exchange, null) of
                  null -> {URL, Headers};
                  Payload -> {URL, Headers, "application/json", apr_json:encode(Payload)}
              end,
    Method = method(apr_json:get(<<"method">>, Exchange)),
    %% No autoredirect: the 308 onto the AgentCard is itself part of the contract.
    {ok, {{_Version, Status, _Phrase}, ResponseHeaders, Body}} =
        httpc:request(Method, Request, [{autoredirect, false}], [{body_format, binary}]),
    {Status, ResponseHeaders, Body}.

method(<<"GET">>) -> get;
method(<<"POST">>) -> post.
