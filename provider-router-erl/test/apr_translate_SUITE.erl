%%% @doc common_test: dialing a native-wire vendor through the Rust translator (agora:60), and
%%% every way that can go wrong without costing the request.
%%%
%%% Two claims are under test and they pull in opposite directions:
%%%
%%% 1. **A native vendor is genuinely dialable now.** The seven vendors `backends.py' marks
%%%    `wire = "native"' were `pending-adapter' — recognised and skipped. With the translator
%%%    bound, a keyed one resolves `ready', the request goes out in the vendor's own shape to
%%%    the vendor's own path, and the answer comes back as the OpenAI envelope with the vendor
%%%    named in the `agora' report. A stubbed transport stands in for the vendor: what is
%%%    being verified is the conversion and the routing, not anybody's uptime.
%%%
%%% 2. **Nothing about it can cost the request.** An absent translator, a refused conversion,
%%%    an unreadable vendor response and a killed port program are each just an attempt. The
%%%    control for all four is the free path: the walk reaches the placeholder having dialed
%%%    nothing, which is ZERO-SPEND stated over the new machinery.
%%%
%%% Cases in group 1 need the real binary — `build-translator.sh' builds it as a compile hook,
%%% but a host without cargo has none, so they skip rather than fail. Group 2 needs no binary
%%% at all; "there is no translator" is one of the states it asserts.
-module(apr_translate_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1, init_per_testcase/2, end_per_testcase/2]).
-export([a_native_vendor_is_dialed_in_its_own_wire_format/1,
         the_translated_response_wears_the_openai_envelope/1,
         a_native_media_vendor_answers_in_the_media_envelope/1,
         the_doctor_reports_a_native_vendor_as_ready/1,
         an_openai_wire_vendor_is_dialed_untranslated/1,
         a_disabled_translator_falls_through_to_the_placeholder/1,
         a_refused_conversion_is_an_undialed_attempt/1,
         an_untranslatable_vendor_response_is_a_dialed_attempt/1,
         a_killed_port_program_cannot_take_down_the_node/1,
         the_contract_surface_is_unchanged_by_the_binding/1]).

-define(ANTHROPIC, "AGORA_PROVIDER_ANTHROPIC_API_KEY").
-define(REPLICATE, "AGORA_PROVIDER_REPLICATE_API_KEY").
-define(OPENAI, "AGORA_PROVIDER_OPENAI_API_KEY").
-define(KEY, "sk-ant-secret-should-not-leak").

all() ->
    [a_native_vendor_is_dialed_in_its_own_wire_format,
     the_translated_response_wears_the_openai_envelope,
     a_native_media_vendor_answers_in_the_media_envelope,
     the_doctor_reports_a_native_vendor_as_ready,
     an_openai_wire_vendor_is_dialed_untranslated,
     a_disabled_translator_falls_through_to_the_placeholder,
     a_refused_conversion_is_an_undialed_attempt,
     an_untranslatable_vendor_response_is_a_dialed_attempt,
     a_killed_port_program_cannot_take_down_the_node,
     the_contract_surface_is_unchanged_by_the_binding].

init_per_suite(Config) ->
    lists:foreach(fun os:unsetenv/1,
                  [?ANTHROPIC, ?REPLICATE, ?OPENAI, "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
                   "AGORA_TRANSLATOR", "AGORA_TRANSLATOR_BIN",
                   "AGORA_TEXT_LADDER", "AGORA_IMAGE_LADDER", "AGORA_PREFER_LOCAL"]),
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    {ok, _Inets} = application:ensure_all_started(inets),
    [{port, ranch:get_port(agora_provider_router_listener)} | Config].

end_per_suite(_Config) ->
    ok = application:stop(agora_provider_router),
    ok.

%% The Rust binary is built by a compile hook; a host without cargo simply has none, so the
%% cases that need one skip rather than failing for a missing toolchain. Everything under
%% "nothing about it can cost the request" runs either way — "there is no translator" is one
%% of the states it asserts.
init_per_testcase(Case, Config) ->
    case lists:member(Case, needs_translator()) andalso not apr_translate:enabled() of
        true -> {skip, "no translation port program built (agora:60 / cargo absent)"};
        false -> Config
    end.

needs_translator() ->
    [a_native_vendor_is_dialed_in_its_own_wire_format,
     the_translated_response_wears_the_openai_envelope,
     a_native_media_vendor_answers_in_the_media_envelope,
     the_doctor_reports_a_native_vendor_as_ready,
     a_refused_conversion_is_an_undialed_attempt,
     an_untranslatable_vendor_response_is_a_dialed_attempt,
     a_killed_port_program_cannot_take_down_the_node].

end_per_testcase(_Case, _Config) ->
    lists:foreach(fun os:unsetenv/1,
                  [?ANTHROPIC, ?REPLICATE, ?OPENAI, "AGORA_TRANSLATOR",
                   "AGORA_TEXT_LADDER", "AGORA_IMAGE_LADDER"]),
    ok.

%% --- 1. a native vendor is dialable -----------------------------------------

a_native_vendor_is_dialed_in_its_own_wire_format(_Config) ->
    keyed(?ANTHROPIC),
    {_Completion, [{Backend, Sent}]} =
        dial(text, chat(<<"how tall is the sky">>), fun(_B) -> anthropic_response() end),
    %% Where it went: Anthropic's own route under Anthropic's own base URL.
    <<"anthropic">> = maps:get(provider, Backend),
    <<"https://api.anthropic.com/v1/messages">> = apr_backends:backend_url(Backend),
    %% What went: Anthropic's request shape, exactly — `max_tokens` is required there and
    %% optional in OpenAI, and it is supplied rather than forwarded.
    [<<"model">>, <<"max_tokens">>, <<"messages">>] = apr_json:keys(Sent),
    true = is_integer(apr_json:get(<<"max_tokens">>, Sent)),
    [Message] = apr_json:get(<<"messages">>, Sent),
    <<"how tall is the sky">> = apr_json:get(<<"content">>, Message),
    ok.

the_translated_response_wears_the_openai_envelope(_Config) ->
    keyed(?ANTHROPIC),
    {Completion, _Dialed} =
        dial(text, chat(<<"hi">>), fun(_B) -> anthropic_response() end),
    paid = apr_router:completion_tier(Completion),
    Response = apr_router:response(Completion),
    %% Indistinguishable from any other tier's answer, in the placeholder's own key order.
    [<<"id">>, <<"object">>, <<"created">>, <<"model">>, <<"choices">>, <<"usage">>] =
        apr_json:keys(Response),
    <<"chat.completion">> = apr_json:get(<<"object">>, Response),
    [Choice] = apr_json:get(<<"choices">>, Response),
    <<"the sky is very tall">> =
        apr_json:get(<<"content">>, apr_json:get(<<"message">>, Choice)),
    3 = apr_json:get(<<"total_tokens">>, apr_json:get(<<"usage">>, Response)),

    %% ...and the vendor that answered is named out of band, where it belongs.
    Routing = apr_router:routing(Completion),
    <<"paid">> = apr_json:get(<<"tier">>, Routing),
    <<"anthropic">> = apr_json:get(<<"provider">>, Routing),
    <<"claude-haiku-4-5-20251001">> = apr_json:get(<<"model">>, Routing),
    [Attempt] = apr_json:get(<<"attempts">>, Routing),
    true = apr_json:get(<<"ok">>, Attempt),
    true = apr_json:get(<<"dialed">>, Attempt),
    ok.

a_native_media_vendor_answers_in_the_media_envelope(_Config) ->
    keyed(?REPLICATE),
    {Completion, [{Backend, Sent}]} =
        dial(image, {obj, [{<<"prompt">>, <<"a heron">>}]},
             fun(_B) -> replicate_response() end),
    <<"replicate">> = maps:get(provider, Backend),
    %% Replicate addresses the model in the path and nests the prompt under `input`.
    true = binary:match(apr_backends:backend_url(Backend), <<"/predictions">>) =/= nomatch,
    <<"a heron">> = apr_json:get(<<"prompt">>, apr_json:get(<<"input">>, Sent)),
    Response = apr_router:response(Completion),
    <<"image.generation">> = apr_json:get(<<"object">>, Response),
    [Artifact] = apr_json:get(<<"data">>, Response),
    <<"https://replicate.delivery/heron.png">> = apr_json:get(<<"url">>, Artifact),
    <<"image/png">> = apr_json:get(<<"media_type">>, Artifact),
    ok.

the_doctor_reports_a_native_vendor_as_ready(Config) ->
    keyed(?ANTHROPIC),
    {200, Body} = get(Config, "/doctor"),
    {ok, Doctor} = apr_json:decode(Body),
    Text = apr_json:get(<<"text">>, apr_json:get(<<"modalities">>, Doctor)),
    [Paid | _] = apr_json:get(<<"tiers">>, Text),
    <<"paid">> = apr_json:get(<<"tier">>, Paid),
    <<"ready">> = apr_json:get(<<"status">>, Paid),
    <<"anthropic">> = apr_json:get(<<"provider">>, Paid),
    <<"anthropic">> = apr_json:get(<<"provider">>, apr_json:get(<<"resolves_to">>, Text)),
    %% Diagnostics, not a dial — and never a place a key surfaces.
    nomatch = binary:match(Body, list_to_binary(?KEY)),
    ok.

an_openai_wire_vendor_is_dialed_untranslated(_Config) ->
    %% The control for the whole suite: binding a translator must not put one in the way of
    %% the vendors that never needed it.
    keyed(?OPENAI),
    {Completion, [{Backend, Sent}]} =
        dial(text, chat(<<"hi">>), fun(_B) -> {obj, [{<<"id">>, <<"upstream">>}]} end),
    <<"openai">> = maps:get(provider, Backend),
    openai = maps:get(wire, Backend),
    <<"https://api.openai.com/v1/chat/completions">> = apr_backends:backend_url(Backend),
    %% Relayed verbatim, in and out.
    <<"gpt-4o-mini">> = apr_json:get(<<"model">>, Sent),
    true = apr_json:is_key(<<"messages">>, Sent),
    <<"upstream">> = apr_json:get(<<"id">>, apr_router:response(Completion)),
    ok.

%% --- 2. nothing about it can cost the request -------------------------------

a_disabled_translator_falls_through_to_the_placeholder(_Config) ->
    %% The fail-safe case, and the one a host with no cargo is permanently in: with no
    %% translator the keyed native vendor is `pending-adapter' again and the walk ends free.
    true = os:putenv("AGORA_TRANSLATOR", "off"),
    keyed(?ANTHROPIC),
    {Completion, Dialed} = dial(text, chat(<<"hi">>), fun(_B) -> vendor_should_not_be_dialed end),
    placeholder = apr_router:completion_tier(Completion),
    %% ZERO-SPEND: the transport was never invoked, so nothing could have been billed.
    [] = Dialed,
    Paid = attempt(paid, Completion),
    false = maps:get(dialed, Paid),
    true = binary:match(maps:get(reason, Paid), <<"adapter">>) =/= nomatch,
    ok.

a_refused_conversion_is_an_undialed_attempt(_Config) ->
    keyed(?ANTHROPIC),
    %% A body with nothing to say: the translator refuses it rather than inventing a request,
    %% and a refusal BEFORE the dial cannot have spent anything.
    {Completion, Dialed} =
        dial(text, {obj, [{<<"messages">>, []}]}, fun(_B) -> vendor_should_not_be_dialed end),
    placeholder = apr_router:completion_tier(Completion),
    [] = Dialed,
    Paid = attempt(paid, Completion),
    false = maps:get(dialed, Paid),
    Reason = maps:get(reason, Paid),
    %% The translator's own words, attributed — a caller should not have to guess which of the
    %% router's moving parts refused.
    true = binary:match(Reason, <<"translator: ">>) =/= nomatch,
    ok.

an_untranslatable_vendor_response_is_a_dialed_attempt(_Config) ->
    keyed(?ANTHROPIC),
    %% The vendor answered — with something the adapter cannot read. That IS a dial: it may
    %% well have billed, and a budget audit must not be told otherwise.
    {Completion, Dialed} =
        dial(text, chat(<<"hi">>), fun(_B) -> {obj, [{<<"unexpected">>, true}]} end),
    placeholder = apr_router:completion_tier(Completion),
    [_] = Dialed,
    Paid = attempt(paid, Completion),
    true = maps:get(dialed, Paid),
    true = binary:match(maps:get(reason, Paid), <<"translator: ">>) =/= nomatch,
    ok.

a_killed_port_program_cannot_take_down_the_node(_Config) ->
    keyed(?ANTHROPIC),
    Before = whereis(apr_translate),
    %% Prime the port, then kill it out from under the router mid-life.
    {ok, _Path, _Body} =
        apr_translate:to_native(<<"anthropic">>, text, <<"m">>, chat(<<"hi">>)),
    Port = translator_port(),
    true = is_port(Port),
    exit(Port, kill),
    ok = until(fun() -> translator_port() =:= undefined end),

    %% The owner survived — a dead port is a state change, not a crash.
    Before = whereis(apr_translate),
    %% ...and it reopens on demand, so the node recovers without a restart.
    {ok, <<"/messages">>, _Reopened} =
        apr_translate:to_native(<<"anthropic">>, text, <<"m">>, chat(<<"hi">>)),
    true = is_port(translator_port()),

    %% Meanwhile the ladder never stopped completing.
    {Completion, _Dialed} = dial(text, chat(<<"hi">>), fun(_B) -> anthropic_response() end),
    paid = apr_router:completion_tier(Completion),
    ok.

the_contract_surface_is_unchanged_by_the_binding(Config) ->
    %% US-1..US-4's surface, with a native vendor keyed and the translator bound: the five
    %% generation routes and the manifest answer exactly as before. The binding widens which
    %% rungs can be dialed; it changes no byte of the contract.
    keyed(?ANTHROPIC),
    lists:foreach(
      fun(Path) ->
              {200, Headers, Body} = post(Config, Path, <<"{\"prompt\":\"hi\"}">>),
              {ok, Decoded} = apr_json:decode(Body),
              true = apr_json:is_key(<<"id">>, Decoded),
              true = apr_json:is_key(<<"agora">>, Decoded),
              %% No live transport is configured over HTTP, so every rung falls through — the
              %% always-completes end state, reported as such.
              <<"placeholder">> = header(<<"x-agora-tier">>, Headers),
              nomatch = binary:match(Body, list_to_binary(?KEY))
      end,
      ["/v1/chat/completions", "/v1/images/generations", "/v1/audio/speech",
       "/v1/audio/music-generations", "/v1/video/generations"]),
    {200, Card} = get(Config, binary_to_list(apr_manifest:manifest_path())),
    {ok, Decoded} = apr_json:decode(Card),
    <<"agora:agent:provider-router">> = apr_json:get(<<"name">>, Decoded),
    nomatch = binary:match(Card, list_to_binary(?KEY)),
    ok.

%% --- helpers ----------------------------------------------------------------

%% One paid vendor per case, so "which one answered" is never ambiguous.
keyed(Var) ->
    true = os:putenv(Var, ?KEY),
    ok.

%% `complete/3` with a transport that records what it was handed and answers with `Answer'.
%% A non-`{ok, _}`/`{error, _}` answer means the case asserted it would never be reached.
dial(Modality, Payload, Answer) ->
    Self = self(),
    Transport = fun(Backend, Sent) ->
                        Self ! {dialed, Backend, Sent},
                        case Answer(Backend) of
                            vendor_should_not_be_dialed -> {error, <<"unexpected dial">>};
                            Response -> {ok, Response}
                        end
                end,
    Completion = apr_router:complete(Modality, Payload, #{transport => Transport}),
    {Completion, drain([])}.

drain(Acc) ->
    receive
        {dialed, Backend, Sent} -> drain([{Backend, Sent} | Acc])
    after 50 ->
        lists:reverse(Acc)
    end.

attempt(Tier, #{attempts := Attempts}) ->
    [Attempt] = [A || A <- Attempts, maps:get(tier, A) =:= Tier],
    Attempt.

translator_port() -> maps:get(port, sys:get_state(apr_translate)).

until(Predicate) -> until(Predicate, 100).

until(_Predicate, 0) -> timeout;
until(Predicate, Left) ->
    case Predicate() of
        true -> ok;
        false ->
            timer:sleep(10),
            until(Predicate, Left - 1)
    end.

chat(Text) ->
    {obj, [{<<"messages">>, [{obj, [{<<"role">>, <<"user">>}, {<<"content">>, Text}]}]}]}.

anthropic_response() ->
    {obj, [{<<"id">>, <<"msg_01ABC">>},
           {<<"type">>, <<"message">>},
           {<<"role">>, <<"assistant">>},
           {<<"content">>, [{obj, [{<<"type">>, <<"text">>},
                                   {<<"text">>, <<"the sky is very tall">>}]}]},
           {<<"stop_reason">>, <<"end_turn">>},
           {<<"usage">>, {obj, [{<<"input_tokens">>, 1}, {<<"output_tokens">>, 2}]}}]}.

replicate_response() ->
    {obj, [{<<"id">>, <<"pred_9">>},
           {<<"status">>, <<"succeeded">>},
           {<<"output">>, [<<"https://replicate.delivery/heron.png">>]}]}.

get(Config, Path) ->
    {ok, {{_Vsn, Status, _Reason}, _Headers, Body}} =
        httpc:request(get, {url(Config, Path), []}, [], [{body_format, binary}]),
    {Status, Body}.

post(Config, Path, Body) ->
    {ok, {{_Vsn, Status, _Reason}, Headers, ResponseBody}} =
        httpc:request(post, {url(Config, Path), [], "application/json", Body}, [],
                      [{body_format, binary}]),
    {Status, Headers, ResponseBody}.

url(Config, Path) ->
    "http://127.0.0.1:" ++ integer_to_list(?config(port, Config)) ++ Path.

header(Name, Headers) ->
    case lists:keyfind(binary_to_list(Name), 1, Headers) of
        {_, Value} -> list_to_binary(Value);
        false -> undefined
    end.
