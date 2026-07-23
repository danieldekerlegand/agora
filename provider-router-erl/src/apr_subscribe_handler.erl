%%% @doc The `subscribe' surface — `capability-bus.md' §4, in its A2A-streaming shape.
%%%
%%% `POST /v1/subscribe' with `{"topic": "world/<world>", "grant": ...}' opens a
%%% `text/event-stream' that carries KGP deltas and media events as they occur. A2A streams
%%% server-sent events over a POST (there is no GET to hang an `EventSource' off), and MCP
%%% notifications are the same frames under a different envelope — §4 fixes the semantics, not
%%% the pipe, so one stream serves both.
%%%
%%% This is an **additional** surface, not a change to an existing one: the eleven paths
%%% mirrored from `app.py' answer byte-for-byte as they did before, whether or not
%%% subscriptions are open (US-4's fourth criterion, and what US-6's conformance fixture
%%% pins). For the same reason the capability manifest is left exactly as it was — the
%%% AgentCard is a document a crawler has already stored, and the router does not get to
%%% rewrite it to advertise a verb the spec already defines for every KCB provider.
%%%
%%% The connection process *is* the consumer: the subscription process monitors it, so a
%%% dropped connection deregisters the subscription without anyone polling for liveness.
-module(apr_subscribe_handler).
-behaviour(cowboy_loop).

-export([init/2, info/3, terminate/3]).

%% The grant may also ride in a header, for the same reason the budget ceiling may
%% ({@link apr_cost:budget_header/0}): a client that cannot shape the body can still present
%% its authorization. The body wins, as it does for the ceiling.
-define(GRANT_HEADER, <<"x-agora-grant">>).

-spec init(cowboy_req:req(), map()) ->
          {ok, cowboy_req:req(), map()} | {cowboy_loop, cowboy_req:req(), map()}.
init(Req0, State) ->
    case cowboy_req:method(Req0) of
        <<"POST">> ->
            {Body, Req1} = read_body(Req0, <<>>),
            open(Body, Req1, State);
        _Other ->
            {ok, refuse(405, <<"subscribe is a POST (capability-bus.md §4)"/utf8>>, Req0), State}
    end.

open(Body, Req, State) ->
    case apr_json:decode(empty_as_object(Body)) of
        {ok, {obj, _} = Payload} ->
            subscribe(Payload, Req, State);
        {ok, _NotAnObject} ->
            {ok, refuse(422, <<"request body must be a JSON object">>, Req), State};
        {error, _Reason} ->
            {ok, refuse(422, <<"request body must be valid JSON">>, Req), State}
    end.

subscribe(Payload, Req, State) ->
    Topic = apr_json:get(<<"topic">>, Payload),
    Grant = grant(Payload, Req),
    case apr_bus:subscribe(Topic, Grant, #{deliver_to => self()}) of
        {ok, #{ref := Ref, topic := Registered}} ->
            stream(Ref, Registered, Req, State);
        {error, Status, Message} ->
            %% Refused before a single event was delivered — the whole point of gating
            %% registration rather than filtering the stream.
            {ok, refuse(Status, Message, Req), State}
    end.

grant(Payload, Req) ->
    case apr_json:get(<<"grant">>, Payload) of
        undefined -> cowboy_req:header(?GRANT_HEADER, Req, undefined);
        Grant -> Grant
    end.

stream(Ref, Topic, Req0, State) ->
    Req = cowboy_req:stream_reply(
            200,
            #{<<"content-type">> => <<"text/event-stream">>,
              <<"cache-control">> => <<"no-store">>,
              <<"x-agora-subscription">> => Ref},
            Req0),
    Hello = {obj, [{<<"subscription">>, Ref},
                   {<<"topic">>, Topic},
                   {<<"kcb_version">>, apr:kcb_version()}]},
    ok = cowboy_req:stream_events(#{event => <<"subscribed">>, data => apr_json:encode(Hello)},
                                  nofin, Req),
    {cowboy_loop, Req, State#{subscription => Ref}}.

-spec info(term(), cowboy_req:req(), map()) ->
          {ok, cowboy_req:req(), map()} | {stop, cowboy_req:req(), map()}.
info({kcb_event, _Ref, Envelope}, Req, State) ->
    #{id := Id, kind := Kind, json := Json} = Envelope,
    ok = cowboy_req:stream_events(
           #{event => Kind, id => Id, data => apr_json:encode(Json)}, nofin, Req),
    {ok, Req, State};
info({kcb_closed, Ref, Reason}, Req, State) ->
    Closed = {obj, [{<<"subscription">>, Ref},
                    {<<"reason">>, atom_to_binary(Reason, utf8)}]},
    ok = cowboy_req:stream_events(
           #{event => <<"closed">>, data => apr_json:encode(Closed)}, fin, Req),
    {stop, Req, State};
info(_Message, Req, State) ->
    {ok, Req, State}.

-spec terminate(term(), cowboy_req:req(), map()) -> ok.
terminate(_Reason, _Req, #{subscription := Ref}) ->
    %% The subscription would go anyway — it monitors this process — but saying so on the way
    %% out means the index is clean before the next publish rather than after the next DOWN.
    try apr_bus:unsubscribe(Ref)
    catch _Class:_Error -> ok
    end,
    ok;
terminate(_Reason, _Req, _State) ->
    ok.

refuse(Status, Message, Req) ->
    cowboy_req:reply(Status, #{<<"content-type">> => <<"application/json">>},
                     apr_json:encode({obj, [{<<"detail">>, Message}]}), Req).

empty_as_object(<<>>) -> <<"{}">>;
empty_as_object(Body) -> Body.

read_body(Req0, Acc) ->
    case cowboy_req:read_body(Req0) of
        {ok, Data, Req} -> {<<Acc/binary, Data/binary>>, Req};
        {more, Data, Req} -> read_body(Req, <<Acc/binary, Data/binary>>)
    end.
