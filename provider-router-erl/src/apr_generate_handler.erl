%%% @doc cowboy handler for the five generation POSTs — the Erlang mirror of `app.py::_generate'.
%%%
%%% One response shape for every modality: the upstream body verbatim with one addition, an
%%% `agora' key (mirrored into `X-Agora-*' headers) carrying the resolved tier, provider,
%%% model, the rungs that were tried, and the projected and actual cost. An OpenAI client
%%% ignores the extra key; the conformance console reads it to show which tier served a
%%% request and what it cost, without having to trust a header surviving CORS.
%%%
%%% A request's spend ceiling (KCB §5) rides in the body as `budget_units' or in the
%%% `X-Agora-Budget-Units' header — the header exists because a stock OpenAI SDK will not let
%%% a caller add an unknown body key. The body wins when both are present.
%%%
%%% A malformed body or an unreadable ceiling is a **422**, not a silently-unbudgeted request:
%%% the whole point of the ceiling is that a caller who states one is not billed as if they
%%% had not. Every other failure is a ladder concern and cannot reach here — the walk always
%%% completes.
-module(apr_generate_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State} when State :: map().
init(Req0, State) ->
    Modality = maps:get(modality, State),
    {Body, Req1} = read_body(Req0, <<>>),
    Req = case decode_request(Body, Req1) of
              {ok, Payload, Options} -> generate(Modality, Payload, Options, Req1);
              {error, Message} -> unprocessable(Message, Req1)
          end,
    {ok, Req, State}.

generate(Modality, Payload, Options, Req) ->
    try apr_router:complete(Modality, Payload, Options) of
        Completion -> ok_response(Completion, Req)
    catch
        %% The body's ceiling is parsed inside the walk (it is stripped from the payload
        %% there), so an unreadable one surfaces here rather than at decode time.
        throw:{ceiling_error, Message} -> unprocessable(Message, Req)
    end.

ok_response(Completion, Req) ->
    %% The upstream body verbatim, plus one key — `put/3' keeps the relayed order and, like
    %% Python's `{**response, "agora": ...}', replaces rather than duplicates an `agora' key
    %% a provider improbably sent us.
    Response = apr_router:response(Completion),
    Body = apr_json:encode(apr_json:put(<<"agora">>, apr_router:routing(Completion), Response)),
    #{backend := Backend, actual := Actual} = Completion,
    Headers =
        #{<<"content-type">> => <<"application/json">>,
          <<"x-agora-tier">> => atom_to_binary(maps:get(tier, Backend), utf8),
          <<"x-agora-provider">> => maps:get(provider, Backend),
          <<"x-agora-model">> => maps:get(model, Backend),
          <<"x-agora-cost-units">> =>
              list_to_binary(apr_cost:fmt_g(apr_cost:units(Actual)))},
    cowboy_req:reply(200, Headers, Body, Req).

unprocessable(Message, Req) ->
    cowboy_req:reply(422, #{<<"content-type">> => <<"application/json">>},
                     apr_json:encode({obj, [{<<"detail">>, Message}]}), Req).

%% The body must be a JSON object (`app.py' types the payload as one), and the header ceiling
%% is parsed here so junk in it is refused with the same 422 as junk in the body.
decode_request(Body, Req) ->
    case apr_json:decode(empty_as_object(Body)) of
        {ok, {obj, _} = Payload} ->
            case header_ceiling(Req) of
                {ok, Ceiling} -> {ok, Payload, ceiling_options(Ceiling)};
                {error, Message} -> {error, Message}
            end;
        {ok, _NotAnObject} ->
            {error, <<"request body must be a JSON object">>};
        {error, _Reason} ->
            {error, <<"request body must be valid JSON">>}
    end.

empty_as_object(<<>>) -> <<"{}">>;
empty_as_object(Body) -> Body.

ceiling_options(undefined) -> #{};
ceiling_options(Ceiling) -> #{budget_units => Ceiling}.

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
