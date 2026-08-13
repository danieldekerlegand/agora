%%% @doc common_test: the two KCB §4 `invoke' transports, dialed directly over HTTP.
%%%
%%% `apr_conformance_SUITE' pins what these surfaces *say*, byte for byte, against the Python
%%% router. This suite pins what they *are*: that the addresses the AgentCard advertises are
%%% the addresses that answer, that a digest a caller was handed verifies against the bytes it
%%% came with, that nothing here relays and that no configured key reaches either wire.
%%%
%%% Every case drives the real handshake through the running OTP application — the endpoint's
%%% promise is that a peer who read the manifest can dial *that address* and be answered, so
%%% asserting on the modules alone would prove the wrong thing (`tests/test_mcp.py',
%%% `tests/test_a2a.py' make the same choice one language over).
-module(apr_invoke_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1, init_per_testcase/2, end_per_testcase/2]).
-export([every_advertised_address_answers/1,
         every_capability_is_callable_on_both_transports/1,
         a_media_call_carries_a_digest_that_verifies_against_its_bytes/1,
         the_same_call_twice_is_byte_identical/1,
         no_session_is_issued/1,
         no_tool_takes_a_peer_address/1,
         an_argument_naming_a_peer_is_never_dialed/1,
         a_message_for_another_peer_is_refused_not_forwarded/1,
         no_key_reaches_either_surface/1]).

%% A key long enough that a substring search for it cannot match anything the router
%% legitimately reports.
-define(KEY, "sk-live-should-never-appear").
-define(KEY_VAR, "AGORA_PROVIDER_OPENAI_API_KEY").

all() ->
    [every_advertised_address_answers,
     every_capability_is_callable_on_both_transports,
     a_media_call_carries_a_digest_that_verifies_against_its_bytes,
     the_same_call_twice_is_byte_identical,
     no_session_is_issued,
     no_tool_takes_a_peer_address,
     an_argument_naming_a_peer_is_never_dialed,
     a_message_for_another_peer_is_refused_not_forwarded,
     no_key_reaches_either_surface].

init_per_suite(Config) ->
    Saved = [{Name, os:getenv(Name)} || Name <- configuring_vars()],
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    {ok, _Inets} = application:ensure_all_started(inets),
    [{port, ranch:get_port(agora_provider_router_listener)}, {saved_env, Saved} | Config].

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

%% --- what is advertised is what is served -----------------------------------

every_advertised_address_answers(Config) ->
    %% The card is the document a peer actually reads, so the addresses under test are taken
    %% out of it rather than re-typed: what is advertised must be dialable, or the registry is
    %% handing peers a dead address (ADR-0001 decision 3).
    Card = decode(get(Config, "/.well-known/agent-card.json")),
    Endpoints = apr_json:get(<<"endpoints">>, manifest_of(Card)),
    Mcp = path_of(apr_json:get(<<"mcp">>, Endpoints)),
    A2a = path_of(apr_json:get(<<"a2a">>, Endpoints)),
    %% The card's own `url' is the A2A service endpoint — the same address, said twice.
    A2a = path_of(apr_json:get(<<"url">>, Card)),
    <<"JSONRPC">> = apr_json:get(<<"preferredTransport">>, Card),

    %% The MCP address answers the handshake and lists one tool per advertised capability.
    Latest = apr_mcp:latest_protocol_version(),
    {200, _, Handshake} = post(Config, Mcp, rpc(<<"initialize">>, {obj, []})),
    Latest = apr_json:get(<<"protocolVersion">>, apr_json:get(<<"result">>, decode(Handshake))),
    {200, _, Listed} = post(Config, Mcp, rpc(<<"tools/list">>, {obj, []})),
    Tools = apr_json:get(<<"tools">>, apr_json:get(<<"result">>, decode(Listed))),
    Capabilities = apr_invoke:capabilities(),
    Capabilities = [apr_json:get(<<"name">>, Tool) || Tool <- Tools],

    %% The A2A address answers a message with a completed task.
    {200, _, Sent} = post(Config, A2a, message(<<"what is the agora commons?">>, [])),
    <<"completed">> = state_of(apr_json:get(<<"result">>, decode(Sent))),

    %% ...and the read addresses it publishes answer too.
    {200, _, _} = get_full(Config, binary_to_list(path_of(apr_json:get(<<"doctor">>, Endpoints)))),
    {200, _, _} = get_full(Config,
                           binary_to_list(path_of(apr_json:get(<<"manifest">>, Endpoints)))),
    ok.

every_capability_is_callable_on_both_transports(Config) ->
    lists:foreach(
      fun(Modality) ->
              Capability = apr_invoke:capability_name(Modality),
              Called = call_tool(Config, Capability, {obj, [{<<"prompt">>, <<"a lyre">>}]}),
              placeholder = tier_of(routing_of_tool(Called)),
              true = apr_json:get(<<"content">>, Called) =/= [],

              Sent = send(Config, <<"a lyre">>,
                          [{<<"metadata">>, {obj, [{<<"capability">>, Capability}]}}]),
              <<"completed">> = state_of(Sent),
              placeholder = tier_of(apr_json:get(<<"agora">>,
                                                 apr_json:get(<<"metadata">>, Sent)))
      end, apr_ladder:modalities()).

a_media_call_carries_a_digest_that_verifies_against_its_bytes(Config) ->
    %% The digest is over the bytes, so a caller can verify what it was handed (KCB §4,
    %% delta G) — the same guarantee on both transports, checked by recomputing it.
    Called = call_tool(Config, <<"generate.image">>, {obj, [{<<"prompt">>, <<"a clay tablet">>}]}),
    [Resource] = [apr_json:get(<<"resource">>, Block)
                  || Block <- apr_json:get(<<"content">>, Called),
                     apr_json:get(<<"type">>, Block) =:= <<"resource">>],
    <<"image/png">> = apr_json:get(<<"mimeType">>, Resource),
    Blob = base64:decode(apr_json:get(<<"blob">>, Resource)),
    Uri = <<"agora:artifact:sha256:", (hex(crypto:hash(sha256, Blob)))/binary>>,
    Uri = apr_json:get(<<"uri">>, Resource),

    Sent = send(Config, <<"a clay tablet">>,
                [{<<"metadata">>, {obj, [{<<"capability">>, <<"generate.image">>}]}}]),
    [Artifact] = apr_json:get(<<"artifacts">>, Sent),
    [Part] = apr_json:get(<<"parts">>, Artifact),
    <<"file">> = apr_json:get(<<"kind">>, Part),
    File = apr_json:get(<<"file">>, Part),
    %% A2A's file union carries bytes OR a uri — this router serves no artifact address on the
    %% mirrored surface, so it must not pretend to.
    undefined = apr_json:get(<<"uri">>, File),
    Bytes = base64:decode(apr_json:get(<<"bytes">>, File)),
    Digest = <<"sha256:", (hex(crypto:hash(sha256, Bytes)))/binary>>,
    Digest = apr_json:get(<<"digest">>, apr_json:get(<<"metadata">>, Artifact)),
    ok.

the_same_call_twice_is_byte_identical(Config) ->
    %% Nothing random rides on either wire — the conformance corpus needs that to hold, and a
    %% task id that changed per call could not be pinned at all.
    {200, _, First} = post(Config, apr_mcp:path(),
                           tool_call(<<"generate.image">>,
                                     {obj, [{<<"prompt">>, <<"a clay tablet">>}]})),
    {200, _, First} = post(Config, apr_mcp:path(),
                           tool_call(<<"generate.image">>,
                                     {obj, [{<<"prompt">>, <<"a clay tablet">>}]})),
    {200, _, Task} = post(Config, apr_a2a:path(), message(<<"the same question">>, [])),
    {200, _, Task} = post(Config, apr_a2a:path(), message(<<"the same question">>, [])),
    ok.

no_session_is_issued(Config) ->
    %% Stateless: nothing per-caller accumulates, so there is no session id to echo.
    {200, Headers, _Body} = post(Config, apr_mcp:path(), rpc(<<"initialize">>, {obj, []})),
    undefined = proplists:get_value("mcp-session-id", Headers, undefined),
    ok.

%% --- it never relays --------------------------------------------------------

no_tool_takes_a_peer_address(Config) ->
    {200, _, Listed} = post(Config, apr_mcp:path(), rpc(<<"tools/list">>, {obj, []})),
    Tools = apr_json:get(<<"tools">>, apr_json:get(<<"result">>, decode(Listed))),
    Forwarding = [<<"url">>, <<"endpoint">>, <<"base_url">>, <<"peer">>, <<"target">>],
    lists:foreach(
      fun(Tool) ->
              Declared = apr_json:keys(apr_json:get(<<"properties">>,
                                                    apr_json:get(<<"inputSchema">>, Tool))),
              [] = [Name || Name <- Declared, lists:member(Name, Forwarding)]
      end, Tools).

an_argument_naming_a_peer_is_never_dialed(Config) ->
    %% A forwarding address in the arguments is just an argument — it dials nothing, and the
    %% only backends this surface reaches are its own ladder's (ADR-0001 decisions 3/7).
    Called = call_tool(Config, <<"generate.text">>,
                       {obj, [{<<"prompt">>, <<"hi">>},
                              {<<"base_url">>, <<"http://peer.invalid/v1">>},
                              {<<"url">>, <<"http://peer.invalid">>}]}),
    placeholder = tier_of(routing_of_tool(Called)),
    ok.

a_message_for_another_peer_is_refused_not_forwarded(Config) ->
    {200, _, Body} = post(Config, apr_a2a:path(),
                          message(<<"for somebody else">>,
                                  [{<<"toAgent">>, <<"example:agent:somebody-else">>}])),
    Error = apr_json:get(<<"error">>, decode(Body)),
    -32602 = apr_json:get(<<"code">>, Error),
    {_, _} = binary:match(apr_json:get(<<"message">>, Error), <<"relays nothing">>),
    %% ...and addressed to this router by name, it is served.
    Mine = send(Config, <<"for you">>, [{<<"toAgent">>, apr:identity()}]),
    <<"completed">> = state_of(Mine),
    ok.

%% --- no secret on either wire -----------------------------------------------

no_key_reaches_either_surface(Config) ->
    %% Configured, and ceilinged at zero so the paid rung is refused before it is contacted —
    %% a test that dialed api.openai.com would be neither free nor reproducible.
    true = os:putenv(?KEY_VAR, ?KEY),
    Rendered =
        [element(3, post(Config, apr_mcp:path(), rpc(<<"initialize">>, {obj, []}))),
         element(3, post(Config, apr_mcp:path(), rpc(<<"tools/list">>, {obj, []}))),
         element(3, post(Config, apr_mcp:path(),
                         tool_call(<<"generate.text">>,
                                   {obj, [{<<"prompt">>, <<"hi">>},
                                          {<<"budget_units">>, 0}]}))),
         element(3, post(Config, apr_a2a:path(),
                         message(<<"hi">>,
                                 [{<<"metadata">>,
                                   {obj, [{<<"budget_units">>, 0}]}}])))],
    lists:foreach(
      fun(Body) ->
              case binary:match(Body, list_to_binary(?KEY)) of
                  nomatch -> ok;
                  _ -> ct:fail({key_leaked, Body})
              end
      end, Rendered).

%% --- helpers ----------------------------------------------------------------

rpc(Method, Params) ->
    {obj, [{<<"jsonrpc">>, <<"2.0">>}, {<<"id">>, 1},
           {<<"method">>, Method}, {<<"params">>, Params}]}.

tool_call(Name, Arguments) ->
    rpc(<<"tools/call">>, {obj, [{<<"name">>, Name}, {<<"arguments">>, Arguments}]}).

message(Text, Fields) ->
    Message = {obj, [{<<"role">>, <<"user">>},
                     {<<"parts">>, [{obj, [{<<"kind">>, <<"text">>}, {<<"text">>, Text}]}]},
                     {<<"messageId">>, <<"agora-suite-message">>},
                     {<<"kind">>, <<"message">>},
                     {<<"fromAgent">>, <<"agora-console">>}] ++ Fields},
    rpc(<<"message/send">>, {obj, [{<<"message">>, Message}]}).

call_tool(Config, Name, Arguments) ->
    {200, _Headers, Body} = post(Config, apr_mcp:path(), tool_call(Name, Arguments)),
    Envelope = decode(Body),
    undefined = apr_json:get(<<"error">>, Envelope),
    apr_json:get(<<"result">>, Envelope).

send(Config, Text, Fields) ->
    {200, _Headers, Body} = post(Config, apr_a2a:path(), message(Text, Fields)),
    Envelope = decode(Body),
    undefined = apr_json:get(<<"error">>, Envelope),
    apr_json:get(<<"result">>, Envelope).

routing_of_tool(Result) ->
    apr_json:get(apr_mcp:meta_routing_key(), apr_json:get(<<"_meta">>, Result)).

state_of(Task) -> apr_json:get(<<"state">>, apr_json:get(<<"status">>, Task)).

tier_of(Routing) -> binary_to_atom(apr_json:get(<<"tier">>, Routing), utf8).

%% The KCB manifest a card carries — the one extension's `params' (capability-bus.md §2/§6).
manifest_of(Card) ->
    [Extension] = apr_json:get(<<"extensions">>, apr_json:get(<<"capabilities">>, Card)),
    apr_json:get(<<"params">>, Extension).

%% An advertised address is absolute; what this suite dials is its path.
path_of(Address) ->
    Base = apr_manifest:base_url(apr_config:from_env(#{})),
    Size = byte_size(Base),
    <<Base:Size/binary, Path/binary>> = Address,
    Path.

hex(Bin) -> << <<(nibble(N))>> || <<N:4>> <= Bin >>.

nibble(N) when N < 10 -> $0 + N;
nibble(N) -> ($a - 10) + N.

decode(Body) ->
    {ok, Decoded} = apr_json:decode(Body),
    Decoded.

get(Config, Path) ->
    {200, _Headers, Body} = get_full(Config, Path),
    Body.

get_full(Config, Path) ->
    request(get, {url(Config, Path), []}).

post(Config, Path, Body) ->
    request(post, {url(Config, binary_to_list(Path)), [], "application/json",
                   apr_json:encode(Body)}).

url(Config, Path) ->
    "http://127.0.0.1:" ++ integer_to_list(?config(port, Config)) ++ Path.

request(Method, Request) ->
    {ok, {{_Version, Status, _Phrase}, Headers, Body}} =
        httpc:request(Method, Request, [{autoredirect, false}], [{body_format, binary}]),
    {Status, Headers, Body}.

%% Every name that can configure the router, cleared before each case so an answer is a
%% function of the case rather than of the host that runs it.
configuring_vars() ->
    Live = [Name || Entry <- os:getenv(),
                    Name <- [hd(string:split(Entry, "="))],
                    lists:prefix("AGORA_", Name)],
    lists:usort([?KEY_VAR | Live]).

scrub() ->
    lists:foreach(fun os:unsetenv/1, configuring_vars()).
