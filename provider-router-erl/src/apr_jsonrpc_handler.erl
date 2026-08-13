%%% @doc cowboy handler for the two KCB §4 `invoke' transports — the Erlang mirror of
%%% `app.py::_jsonrpc'.
%%%
%%% MCP ({@link apr_mcp}) and A2A ({@link apr_a2a}) are both JSON-RPC 2.0 over one POST and
%%% both end in the same {@link apr_router:complete/3} the OpenAI routes call, so a peer gets
%%% the same ladder and the same ceiling whichever way it dials — and it dials *this* router
%%% directly, which is the whole point (ADR-0001 decision 3). The shape they share lives here:
%%% parse, hand to the surface, answer.
%%%
%%% The body is read and the errors are spelled here rather than by the framework: a JSON-RPC
%%% caller must get a JSON-RPC refusal, not a validation shape that belongs to whichever server
%%% is hosting. A body that is not JSON is a JSON-RPC parse error with the HTTP 400 the
%%% transport expects; a surface answering `no_reply' means the request was a notification,
%%% which JSON-RPC answers with no body at all.
%%%
%%% A method-level refusal (unknown method, bad params) rides a 200 the way JSON-RPC intends; a
%%% request that was never a request does not.
-module(apr_jsonrpc_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State} when State :: map().
init(Req0, State) ->
    Surface = maps:get(surface, State),
    Req = case {cowboy_req:method(Req0), Surface} of
              {<<"POST">>, _} -> post(Surface, Req0);
              %% The spec's optional server->client SSE stream. This surface offers none, and
              %% says so rather than leaving a socket hanging.
              {<<"GET">>, apr_mcp} -> no_stream(Req0);
              {_Other, _} -> not_allowed(Req0)
          end,
    {ok, Req, State}.

post(Surface, Req0) ->
    {Body, Req} = read_body(Req0, <<>>),
    case header_ceiling(Req) of
        {error, Message} -> unprocessable(Message, Req);
        {ok, Ceiling} -> parsed(Surface, Body, Ceiling, Req)
    end.

parsed(Surface, Body, Ceiling, Req) ->
    case decode(Body) of
        {ok, Call} -> answer(handle(Surface, Call, Ceiling), Req);
        {error, Reason} -> parse_error(Reason, Req)
    end.

%% `json.loads(raw) if raw else None': an empty body is not a request, and is refused as one.
decode(<<>>) -> {ok, null};
decode(Body) -> apr_json:decode(Body).

handle(apr_mcp, Call, Ceiling) -> apr_mcp:handle(Call, Ceiling);
handle(apr_a2a, Call, Ceiling) -> apr_a2a:handle(Call, Ceiling).

answer(no_reply, Req) ->
    cowboy_req:reply(202, #{}, <<>>, Req);
answer({reply, Envelope}, Req) ->
    cowboy_req:reply(status_of(Envelope), #{<<"content-type">> => <<"application/json">>},
                     apr_json:encode(Envelope), Req).

%% Whether a JSON-RPC answer reports a *transport*-level fault, which HTTP reports too.
status_of(Envelope) ->
    Fault = apr_json:get(<<"error">>, Envelope),
    Transport = [apr_invoke:parse_error(), apr_invoke:invalid_request()],
    case lists:member(apr_json:get(<<"code">>, Fault), Transport) of
        true -> 400;
        false -> 200
    end.

%% The parser's own prose is its own — this reports the same code, at the same status, in the
%% same envelope, but the corpus deliberately pins no malformed-JSON exchange (CPython's
%% `JSONDecodeError' text is a detail of whichever parser is hosting).
parse_error(Reason, Req) ->
    Message = unicode:characters_to_binary(io_lib:format("invalid JSON: ~p", [Reason])),
    reply(400, apr_invoke:rpc_error(null, apr_invoke:parse_error(), Message), Req).

no_stream(Req) ->
    Message = <<(apr_mcp:path())/binary,
                " is a stateless POST surface; it opens no stream">>,
    reply(405, apr_invoke:rpc_error(null, apr_invoke:method_not_found(), Message), Req).

not_allowed(Req) ->
    detail(405, <<"Method Not Allowed">>, Req).

unprocessable(Message, Req) ->
    detail(422, Message, Req).

detail(Status, Message, Req) ->
    reply(Status, {obj, [{<<"detail">>, Message}]}, Req).

reply(Status, Body, Req) ->
    cowboy_req:reply(Status, #{<<"content-type">> => <<"application/json">>},
                     apr_json:encode(Body), Req).

%% The transport-borne ceiling (KCB §5). Junk in it is refused with the same 422 the generation
%% routes answer with — an unreadable ceiling must never read as "no ceiling".
header_ceiling(Req) ->
    Name = string:lowercase(apr_cost:budget_header()),
    case cowboy_req:header(Name, Req, undefined) of
        undefined -> {ok, undefined};
        Raw ->
            try {ok, apr_cost:parse_ceiling(Raw)}
            catch throw:{ceiling_error, Message} -> {error, Message}
            end
    end.

read_body(Req0, Acc) ->
    case cowboy_req:read_body(Req0) of
        {ok, Data, Req} -> {<<Acc/binary, Data/binary>>, Req};
        {more, Data, Req} -> read_body(Req, <<Acc/binary, Data/binary>>)
    end.
