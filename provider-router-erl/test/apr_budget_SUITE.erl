%%% @doc common_test: the `budget_units' spend ceiling (KCB §5), the routing report attached
%%% to every generation response, and the KCB capability manifest.
%%%
%%% Ported from `tests/test_app.py' (the ceiling cases) and `tests/test_manifest.py'. The
%%% assertion that matters is **"was it dialed"**, not "did it win": spend happens at the
%%% connection, so a recording transport's call list is the real budget assertion —
%%% `completion.tier' alone would pass even if the paid rung had been contacted and merely
%%% lost. Over HTTP the same fact is readable off the report itself, as `dialed: false' on the
%%% refused attempt.
-module(apr_budget_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1, init_per_testcase/2, end_per_testcase/2]).
-export([a_budget_ceiling_in_the_body_downshifts_the_ladder/1,
         the_ceiling_can_arrive_as_a_header_for_a_stock_openai_client/1,
         the_body_ceiling_wins_over_the_header/1,
         a_generous_ceiling_still_dials_the_paid_rung/1,
         an_unreadable_ceiling_is_refused_rather_than_ignored/1,
         every_response_carries_the_routing_report/1,
         a_refused_rung_is_reported_as_not_dialed/1,
         the_manifest_advertises_the_resolved_tier/1,
         the_legacy_manifest_path_redirects_to_the_card/1]).

-define(KEY_VAR, "AGORA_PROVIDER_OPENAI_API_KEY").
-define(KEY, "sk-secret-should-not-leak").

all() ->
    [a_budget_ceiling_in_the_body_downshifts_the_ladder,
     the_ceiling_can_arrive_as_a_header_for_a_stock_openai_client,
     the_body_ceiling_wins_over_the_header,
     a_generous_ceiling_still_dials_the_paid_rung,
     an_unreadable_ceiling_is_refused_rather_than_ignored,
     every_response_carries_the_routing_report,
     a_refused_rung_is_reported_as_not_dialed,
     the_manifest_advertises_the_resolved_tier,
     the_legacy_manifest_path_redirects_to_the_card].

init_per_suite(Config) ->
    lists:foreach(fun os:unsetenv/1,
                  ["OPENAI_API_KEY", "AGORA_TEXT_LADDER", "AGORA_PREFER_LOCAL",
                   "AGORA_PUBLIC_BASE_URL"]),
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    {ok, _Inets} = application:ensure_all_started(inets),
    [{port, ranch:get_port(agora_provider_router_listener)} | Config].

end_per_suite(_Config) ->
    ok = application:stop(agora_provider_router),
    ok.

%% Every case runs against a router with a live OpenAI key: a ceiling that changes nothing
%% would prove nothing on a keyless node, where the ladder is already at the placeholder.
init_per_testcase(_Case, Config) ->
    true = os:putenv(?KEY_VAR, ?KEY),
    Config.

end_per_testcase(_Case, _Config) ->
    os:unsetenv(?KEY_VAR),
    ok.

%% --- the ceiling on the ladder ----------------------------------------------

a_budget_ceiling_in_the_body_downshifts_the_ladder(_Config) ->
    {Completion, Dialed} =
        complete_recording(text, {obj, [{<<"messages">>, []},
                                        {<<"max_tokens">>, 1000},
                                        {<<"budget_units">>, 0}]}, #{}),
    placeholder = apr_router:completion_tier(Completion),
    true = maps:get(budget_units, Completion) == 0.0,
    %% A refused rung is never contacted — this, not the resolved tier, is the invariant.
    [] = Dialed,
    %% ...and the walk says so: the paid attempt is present, undialed, priced.
    Paid = attempt(paid, Completion),
    false = maps:get(dialed, Paid),
    true = is_binary(maps:get(reason, Paid)),
    ok.

the_ceiling_can_arrive_as_a_header_for_a_stock_openai_client(_Config) ->
    %% The header form: a stock OpenAI SDK will not let a caller add an unknown body key.
    {Completion, Dialed} =
        complete_recording(text, {obj, [{<<"messages">>, []}, {<<"max_tokens">>, 1000}]},
                           #{budget_units => 0.0}),
    placeholder = apr_router:completion_tier(Completion),
    [] = Dialed,
    ok.

the_body_ceiling_wins_over_the_header(_Config) ->
    %% Body 0 beats header 1e6: the ladder still downshifts and nothing is dialed.
    {Completion, Dialed} =
        complete_recording(text, {obj, [{<<"messages">>, []}, {<<"budget_units">>, 0}]},
                           #{budget_units => 1000000.0}),
    placeholder = apr_router:completion_tier(Completion),
    [] = Dialed,
    ok.

a_generous_ceiling_still_dials_the_paid_rung(_Config) ->
    %% The control for the two cases above: without the ceiling refusing it, the SAME keyed
    %% ladder does contact the paid rung. Otherwise "nothing was dialed" would prove nothing.
    {Completion, Dialed} =
        complete_recording(text, {obj, [{<<"messages">>, []}, {<<"max_tokens">>, 1000},
                                        {<<"budget_units">>, 1000000}]}, #{}),
    paid = apr_router:completion_tier(Completion),
    [Backend] = Dialed,
    <<"openai">> = maps:get(provider, Backend),
    ok.

%% --- the HTTP surface -------------------------------------------------------

an_unreadable_ceiling_is_refused_rather_than_ignored(Config) ->
    %% Dropping it would turn a typo into unlimited spend authority.
    {BodyStatus, _} = post(Config, "/v1/chat/completions",
                           <<"{\"messages\":[],\"budget_units\":\"lots\"}">>, []),
    422 = BodyStatus,
    {HeaderStatus, _} = post(Config, "/v1/chat/completions", <<"{\"messages\":[]}">>,
                             [{"X-Agora-Budget-Units", "lots"}]),
    422 = HeaderStatus,
    %% A body that is not JSON at all is the same class of caller bug.
    {MalformedStatus, _} = post(Config, "/v1/chat/completions", <<"{oops">>, []),
    422 = MalformedStatus,
    ok.

every_response_carries_the_routing_report(Config) ->
    %% Every modality, on the one path a bare node always has: the paid rung is keyed but
    %% undialable (no live transport), so the walk falls through to the placeholder and the
    %% report explains exactly that.
    lists:foreach(
      fun({Path, Modality}) ->
              {200, Headers, Body} = post_full(Config, Path, <<"{\"prompt\":\"hi\"}">>, []),
              {ok, Decoded} = apr_json:decode(Body),
              Agora = apr_json:get(<<"agora">>, Decoded),
              Modality = binary_to_atom(apr_json:get(<<"modality">>, Agora), utf8),
              <<"placeholder">> = apr_json:get(<<"tier">>, Agora),
              <<"placeholder">> = apr_json:get(<<"provider">>, Agora),
              true = is_binary(apr_json:get(<<"model">>, Agora)),
              true = length(apr_json:get(<<"attempts">>, Agora)) >= 2,
              Cost = apr_json:get(<<"cost">>, Agora),
              <<"budget_units">> = apr_json:get(<<"currency">>, Cost),
              null = apr_json:get(<<"budget_units">>, Cost),
              true = apr_json:get(<<"actual_units">>, Cost) == 0.0,
              %% The upstream body is relayed intact alongside the report.
              true = apr_json:is_key(<<"id">>, Decoded),
              %% The headers mirror the report for a client that cannot read the body.
              <<"placeholder">> = header(<<"x-agora-tier">>, Headers),
              <<"placeholder">> = header(<<"x-agora-provider">>, Headers),
              <<"0">> = header(<<"x-agora-cost-units">>, Headers),
              %% No endpoint ever echoes a configured key.
              nomatch = binary:match(Body, list_to_binary(?KEY))
      end,
      [{"/v1/chat/completions", text},
       {"/v1/images/generations", image},
       {"/v1/audio/speech", speech},
       {"/v1/audio/music-generations", music},
       {"/v1/video/generations", video}]),
    ok.

a_refused_rung_is_reported_as_not_dialed(Config) ->
    %% The same fact as `a_budget_ceiling_in_the_body_downshifts_the_ladder', read off the
    %% wire: with a ceiling of 0 the keyed paid rung is refused undialed; without one it is
    %% contacted (and fails, there being no live transport) — `dialed' tells them apart.
    {200, _, Refused} = post_full(Config, "/v1/chat/completions",
                                  <<"{\"messages\":[],\"budget_units\":0}">>, []),
    false = attempt_dialed(<<"paid">>, Refused),
    {ok, Decoded} = apr_json:decode(Refused),
    Cost = apr_json:get(<<"cost">>, apr_json:get(<<"agora">>, Decoded)),
    true = apr_json:get(<<"budget_units">>, Cost) == 0.0,

    {200, _, Unbudgeted} = post_full(Config, "/v1/chat/completions",
                                     <<"{\"messages\":[]}">>, []),
    true = attempt_dialed(<<"paid">>, Unbudgeted),
    ok.

%% --- the KCB manifest -------------------------------------------------------

the_manifest_advertises_the_resolved_tier(Config) ->
    {200, Body} = get(Config, binary_to_list(apr_manifest:manifest_path())),
    {ok, Card} = apr_json:decode(Body),
    <<"agora:agent:provider-router">> = apr_json:get(<<"name">>, Card),
    [Extension] = apr_json:get(<<"extensions">>, apr_json:get(<<"capabilities">>, Card)),
    Uri = apr_manifest:extension_uri(),
    Uri = apr_json:get(<<"uri">>, Extension),
    Manifest = apr_json:get(<<"params">>, Extension),

    <<"0.4.3">> = apr_json:get(<<"kcb_version">>, Manifest),
    <<"agora:agent:provider-router">> = apr_json:get(<<"identity">>, Manifest),
    Endpoints = apr_json:get(<<"endpoints">>, Manifest),
    <<"http://127.0.0.1:8000/doctor">> = apr_json:get(<<"doctor">>, Endpoints),
    <<"http://127.0.0.1:8000/.well-known/agent-card.json">> =
        apr_json:get(<<"manifest">>, Endpoints),
    %% §2.1 ports: text is knowledge, the media modalities dedupe to three media ports.
    4 = length(apr_json:get(<<"produces">>, Manifest)),
    2 = length(apr_json:get(<<"consumes">>, Manifest)),

    Capabilities = apr_json:get(<<"capabilities">>, Manifest),
    5 = length(Capabilities),
    [Text | _] = Capabilities,
    <<"generate.text">> = apr_json:get(<<"name">>, Text),
    Cost = apr_json:get(<<"cost">>, Text),
    %% The KEY is set, but the paid rung is a *resolution*, not a dial — so this deployment
    %% really does advertise the paid tier it would use. What must never be static is the
    %% number: a keyless node advertises the placeholder's zero.
    <<"1000 completion tokens">> = apr_json:get(<<"basis">>, Cost),
    <<"token">> = apr_json:get(<<"unit">>, Cost),
    true = apr_json:get(<<"quantity">>, Cost) == 1000.0,
    false = apr_json:get(<<"unpriced">>, Cost),
    <<"paid">> = apr_json:get(<<"tier">>, Cost),
    true = apr_json:get(<<"est_units">>, Cost) == 60.0,

    Auth = apr_json:get(<<"auth">>, Manifest),
    <<"capability-token">> = apr_json:get(<<"scheme">>, Auth),
    Grants = apr_json:get(<<"grants_required">>, Auth),
    true = lists:member(<<"invoke:generate.text">>, Grants),
    true = lists:member(<<"invoke:generate.video">>, Grants),
    Budget = apr_json:get(<<"budget_units">>, Auth),
    true = apr_json:get(<<"supported">>, Budget),
    <<"budget_units">> = apr_json:get(<<"request_key">>, Budget),
    <<"X-Agora-Budget-Units">> = apr_json:get(<<"header">>, Budget),
    %% The manifest is a public document — a key resolves a tier, it never appears on it.
    nomatch = binary:match(Body, list_to_binary(?KEY)),
    ok.

the_legacy_manifest_path_redirects_to_the_card(Config) ->
    %% capability-bus.md §6 folded the standalone manifest onto the AgentCard; a 0.2.0
    %% crawler is pointed at the authoritative document rather than a dead address.
    {308, Headers, _Body} = raw(Config, binary_to_list(apr_manifest:legacy_manifest_path())),
    Location = header(<<"location">>, Headers),
    Location = apr_manifest:manifest_path(),
    {200, Card} = get(Config, binary_to_list(Location)),
    {ok, Decoded} = apr_json:decode(Card),
    true = apr_json:is_key(<<"capabilities">>, Decoded),
    ok.

%% --- helpers ---

%% `complete/3` with a transport that records every backend it is handed. The list being
%% empty is the ZERO-SPEND assertion; a non-empty one names what was contacted.
complete_recording(Modality, Payload, Options) ->
    Self = self(),
    Transport = fun(Backend, _Dialed) ->
                        Self ! {dialed, Backend},
                        {ok, {obj, [{<<"id">>, <<"upstream">>}]}}
                end,
    Completion = apr_router:complete(Modality, Payload,
                                     Options#{transport => Transport}),
    {Completion, drain([])}.

drain(Acc) ->
    receive
        {dialed, Backend} -> drain([Backend | Acc])
    after 50 ->
        lists:reverse(Acc)
    end.

attempt(Tier, #{attempts := Attempts}) ->
    [Attempt] = [A || A <- Attempts, maps:get(tier, A) =:= Tier],
    Attempt.

%% `attempts[]` entry for `Tier`, read back off an encoded response body.
attempt_dialed(Tier, Body) ->
    {ok, Decoded} = apr_json:decode(Body),
    Attempts = apr_json:get(<<"attempts">>, apr_json:get(<<"agora">>, Decoded)),
    [Attempt] = [A || A <- Attempts, apr_json:get(<<"tier">>, A) =:= Tier],
    apr_json:get(<<"dialed">>, Attempt).

get(Config, Path) ->
    {Status, _Headers, Body} = raw(Config, Path),
    {Status, Body}.

raw(Config, Path) ->
    request({url(Config, Path), []}, get).

post(Config, Path, Body, Headers) ->
    {Status, _ResponseHeaders, ResponseBody} = post_full(Config, Path, Body, Headers),
    {Status, ResponseBody}.

post_full(Config, Path, Body, Headers) ->
    request({url(Config, Path), Headers, "application/json", Body}, post).

request(Request, Method) ->
    {ok, {{_Vsn, Status, _Reason}, Headers, Body}} =
        httpc:request(Method, Request, [{autoredirect, false}], [{body_format, binary}]),
    {Status, Headers, Body}.

url(Config, Path) ->
    "http://127.0.0.1:" ++ integer_to_list(?config(port, Config)) ++ Path.

%% httpc lowercases header names and hands back strings.
header(Name, Headers) ->
    case lists:keyfind(binary_to_list(Name), 1, Headers) of
        {_, Value} -> list_to_binary(Value);
        false -> undefined
    end.
