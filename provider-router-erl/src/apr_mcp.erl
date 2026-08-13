%%% @doc The MCP server surface — the `invoke' verb as a tool call (KCB §4/§6). The Erlang
%%% mirror of `mcp.py'.
%%%
%%% A peer that has read this router's manifest dials {@link path/0} **directly** and drives
%%% the Model Context Protocol handshake over Streamable HTTP: `initialize' -> `tools/list' ->
%%% `tools/call'. One tool per capability, named exactly as the manifest names it
%%% (`generate.text', `generate.image', ...), so a client that discovered the capability can
%%% call it without a second vocabulary. The console's own MCP wire
%%% (`console/src/kcs/mcp-wire.ts') is written against this handshake, and it is the client
%%% this surface is judged by.
%%%
%%% **Stateless.** No session is issued, so nothing here accumulates per-caller state and no
%%% `mcp-session-id' is echoed; each POST is a whole exchange. A `GET' (the spec's optional
%%% server->client SSE stream) is answered `405', which is what the transport spec says a
%%% server that offers no stream must do — an honest refusal rather than a hanging socket.
%%%
%%% **It never relays.** Every tool this surface serves is one of *this* router's own
%%% capabilities, dispatched down its own ladder; there is no tool that takes a peer address
%%% and no argument that can make it dial one (ADR-0001 decisions 3/7 — peers connect
%%% directly, nothing routes through a middle). An unknown tool is refused by name rather than
%%% forwarded.
%%%
%%% **Always completes.** `tools/call' inherits the ladder's guarantee: an unconfigured,
%%% unreachable or over-budget rung falls through to the deterministic placeholder, so a tool
%%% call answers rather than failing. `isError' is reserved for a malformed *request*, which
%%% is the only thing {@link apr_router:complete/3} refuses.
-module(apr_mcp).

-export([path/0, protocol_versions/0, latest_protocol_version/0, meta_routing_key/0,
         instructions/0, tools/0, handle/1, handle/2]).

-type modality() :: atom().

%% Where the MCP surface is served — the address the manifest advertises as `endpoints.mcp'.
-define(MCP_PATH, <<"/mcp">>).

%% The `_meta' key the routing report rides under. Prefixed with a domain because MCP reserves
%% unprefixed `_meta' names for the protocol itself.
-define(META_ROUTING_KEY, <<"koine.dev/agora">>).

%% @doc Where this surface is served.
-spec path() -> binary().
path() -> ?MCP_PATH.

%% @doc The MCP protocol revisions this server speaks, oldest -> newest. A client asking for
%% one of these is answered in its own version; anything else is answered in
%% {@link latest_protocol_version/0}, which the spec requires of a server that cannot meet it.
-spec protocol_versions() -> [binary()].
protocol_versions() -> [<<"2024-11-05">>, <<"2025-03-26">>, <<"2025-06-18">>].

-spec latest_protocol_version() -> binary().
latest_protocol_version() -> lists:last(protocol_versions()).

-spec meta_routing_key() -> binary().
meta_routing_key() -> ?META_ROUTING_KEY.

%% @doc What a client is told this server is, and what it will not do.
-spec instructions() -> binary().
instructions() ->
    <<"One tool per capability this router offers (KCB §2), each dispatched down its own tier "
      "ladder: paid → mlx-serve → local → a deterministic placeholder, so every call answers. "
      "This surface answers for this router alone — it never relays a call to another peer "
      "(ADR-0001 decision 3); peers are dialed directly at the address their own manifest "
      "advertises. A spend ceiling rides in the X-Agora-Budget-Units header or as a "
      "budget_units argument (KCB §5)."/utf8>>.

%% @doc The `tools/list' catalogue: one entry per capability, in ladder-modality order.
-spec tools() -> [apr_json:object()].
tools() -> [tool(Modality) || Modality <- apr_ladder:modalities()].

-spec handle(term()) -> {reply, apr_json:object()} | no_reply.
handle(Request) -> handle(Request, undefined).

%% @doc Answer one JSON-RPC request. `no_reply' means it was a notification — say nothing back.
%%
%% `Ceiling' is the spend ceiling the transport carried (the `X-Agora-Budget-Units' header); an
%% argument of the same name overrides it, exactly as a body key beats the header on the `/v1'
%% routes.
-spec handle(term(), float() | undefined) -> {reply, apr_json:object()} | no_reply.
handle(Request, Ceiling) ->
    case apr_invoke:is_object(Request) of
        false ->
            {reply, apr_invoke:rpc_error(null, apr_invoke:invalid_request(),
                                         <<"a JSON-RPC request must be an object">>)};
        true ->
            requested(apr_json:get(<<"method">>, Request), Request, Ceiling)
    end.

requested(Method, Request, Ceiling) when is_binary(Method) ->
    case apr_json:is_key(<<"id">>, Request) of
        false ->
            %% A notification (`notifications/initialized' is the one MCP mandates). Nothing is
            %% answered, and an unknown one is ignored rather than refused — a notification has
            %% nowhere to carry a refusal to.
            no_reply;
        true ->
            {reply, method(Method, apr_json:get(<<"id">>, Request), params(Request), Ceiling)}
    end;
requested(_NotAMethod, Request, _Ceiling) ->
    {reply, apr_invoke:rpc_error(apr_json:get(<<"id">>, Request, null),
                                 apr_invoke:invalid_request(),
                                 <<"a JSON-RPC request must name a method">>)}.

params(Request) ->
    Params = apr_json:get(<<"params">>, Request),
    case apr_invoke:is_object(Params) of
        true -> Params;
        false -> {obj, []}
    end.

method(<<"initialize">>, Id, Params, _Ceiling) ->
    apr_invoke:rpc_result(Id, initialize(Params));
method(<<"ping">>, Id, _Params, _Ceiling) ->
    apr_invoke:rpc_result(Id, {obj, []});
method(<<"tools/list">>, Id, _Params, _Ceiling) ->
    apr_invoke:rpc_result(Id, {obj, [{<<"tools">>, tools()}]});
method(<<"tools/call">>, Id, Params, Ceiling) ->
    call(Id, Params, Ceiling);
method(Method, Id, _Params, _Ceiling) ->
    apr_invoke:rpc_error(Id, apr_invoke:method_not_found(),
                         iolist_to_binary([<<"this router serves no MCP method ">>,
                                           apr_json:python_repr(Method)])).

initialize(Params) ->
    Requested = apr_json:get(<<"protocolVersion">>, Params),
    Version = case lists:member(Requested, protocol_versions()) of
                  true -> Requested;
                  false -> latest_protocol_version()
              end,
    {obj, [{<<"protocolVersion">>, Version},
           {<<"capabilities">>, {obj, [{<<"tools">>, {obj, [{<<"listChanged">>, false}]}}]}},
           {<<"serverInfo">>, {obj, [{<<"name">>, apr:identity()},
                                     {<<"version">>, apr:version()}]}},
           {<<"instructions">>, instructions()}]}.

call(Id, Params, Ceiling) ->
    case apr_json:get(<<"name">>, Params) of
        Name when is_binary(Name) ->
            case apr_invoke:modality_for(Name) of
                {ok, Modality} -> invoke(Id, Modality, arguments(Params), Ceiling);
                %% A protocol-level refusal, not a tool failure: there was no tool to fail.
                {error, Reason} -> apr_invoke:rpc_error(Id, apr_invoke:invalid_params(), Reason)
            end;
        _Unnamed ->
            apr_invoke:rpc_error(Id, apr_invoke:invalid_params(),
                                 <<"tools/call must name a tool">>)
    end.

arguments(Params) ->
    Raw = apr_json:get(<<"arguments">>, Params),
    case apr_invoke:is_object(Raw) of
        true -> Raw;
        false -> {obj, []}
    end.

invoke(Id, Modality, Arguments, Ceiling) ->
    Payload = apr_invoke:payload_for(Modality, Arguments),
    try apr_router:complete(Modality, Payload, options(Ceiling)) of
        Completion -> apr_invoke:rpc_result(Id, tool_result(Modality, Completion))
    catch
        %% The one thing the walk refuses: a ceiling it cannot read. A tool error rather than a
        %% JSON-RPC error, because the request WAS a request — the tool could not run.
        throw:{ceiling_error, Reason} -> apr_invoke:rpc_result(Id, tool_error(Reason))
    end.

options(undefined) -> #{};
options(Ceiling) -> #{budget_units => Ceiling}.

%% One completion as MCP content: text as text, media as digested resources.
tool_result(Modality, Completion) ->
    Response = apr_router:response(Completion),
    Spoken = apr_invoke:text_of(Response),
    Artifacts = apr_invoke:artifacts_of(Modality, Response),
    Content = spoken_content(Spoken) ++ [resource(A) || A <- Artifacts],
    {obj, [{<<"content">>, nonempty(Content, Response)},
           {<<"_meta">>, {obj, [{?META_ROUTING_KEY, apr_router:routing(Completion)}]}}]}.

spoken_content(<<>>) -> [];
spoken_content(Spoken) -> [text_block(Spoken)].

nonempty([], Response) -> [text_block(apr_invoke:fallback_text(Response))];
nonempty(Content, _Response) -> Content.

text_block(Text) -> {obj, [{<<"type">>, <<"text">>}, {<<"text">>, Text}]}.

%% A media output as an MCP embedded resource, named by its own content digest.
resource(#{media_type := MediaType, data := Data} = Artifact) ->
    {obj, [{<<"type">>, <<"resource">>},
           {<<"resource">>, {obj, [{<<"uri">>, apr_invoke:artifact_uri(Artifact)},
                                   {<<"mimeType">>, MediaType},
                                   {<<"blob">>, Data}]}}]}.

tool_error(Reason) ->
    {obj, [{<<"content">>, [text_block(Reason)]}, {<<"isError">>, true}]}.

%% One capability as an MCP tool declaration.
-spec tool(modality()) -> apr_json:object().
tool(Modality) ->
    Name = atom_to_binary(Modality, utf8),
    {obj, [{<<"name">>, apr_invoke:capability_name(Modality)},
           {<<"description">>,
            <<"Generate ", Name/binary, " down this router's ", Name/binary,
              " ladder. Always answers: an unavailable or over-budget rung falls through to a "
              "deterministic placeholder.">>},
           %% Nothing is required: the ladder completes whatever it is handed, and a required
           %% field would be a promise about the request that the placeholder tier does not need.
           {<<"inputSchema">>, {obj, [{<<"type">>, <<"object">>},
                                      {<<"properties">>, {obj, properties(Modality, Name)}},
                                      {<<"additionalProperties">>, true}]}}]}.

properties(Modality, Name) ->
    Base = [{<<"prompt">>,
             {obj, [{<<"type">>, <<"string">>},
                    {<<"description">>, <<"what to generate (", Name/binary, ")">>}]}},
            {<<"model">>,
             {obj, [{<<"type">>, <<"string">>},
                    {<<"description">>, <<"a model id, if the caller wants one">>}]}},
            {<<"budget_units">>,
             {obj, [{<<"type">>, <<"number">>},
                    {<<"description">>, <<"KCB §5 spend ceiling, in budget units"/utf8>>}]}}],
    case apr_invoke:prompt_key(Modality) of
        <<"messages">> ->
            Base ++ [{<<"messages">>,
                      {obj, [{<<"type">>, <<"array">>},
                             {<<"description">>,
                              <<"an OpenAI-shaped chat transcript; wins over `prompt` when "
                                "given">>},
                             {<<"items">>, {obj, [{<<"type">>, <<"object">>}]}}]}}];
        _Other ->
            Base
    end.
