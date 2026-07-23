%%% @doc The `fetch' surface — `capability-bus.md' §4: "CAS GET by `asset' id; integrity
%%% self-verifies against the hash (delta G). Requires a `fetch:asset' grant (§5)."
%%%
%%% `GET /v1/assets/<digest>' with `X-Agora-Grant: fetch:asset'. The address is the content
%%% hash, so the response needs no trust in where the reference came from — and that is
%%% exactly what makes lazy fetching safe: a consumer that received a reference before its
%%% bytes propagated (delta L) can come back later and still be certain it got the right ones.
%%%
%%% An asset that has not arrived yet is a **404**, not a 500 and not an empty 200. It is a
%%% retryable state in the normal life of a stream — producers "MUST NOT assume bytes are
%%% pre-propagated" — so the body says `"pending": true' to distinguish "not yet" from
%%% "never", which a consumer needs in order to decide whether to ask again.
-module(apr_fetch_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-define(GRANT_HEADER, <<"x-agora-grant">>).

%% The scope a `fetch' grant must name (§5's own example: `fetch:asset').
-define(FETCH_SCOPE, <<"asset">>).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State} when State :: map().
init(Req0, State) ->
    Req = case authorize(Req0) of
              ok -> serve(cowboy_req:binding(id, Req0, <<>>), Req0);
              {error, Status, Message} -> detail(Status, Message, Req0)
          end,
    {ok, Req, State}.

authorize(Req) ->
    case apr_grant:parse(cowboy_req:header(?GRANT_HEADER, Req, undefined)) of
        {error, Status, Message} ->
            {error, Status, Message};
        {ok, Grant} ->
            case apr_grant:permits(Grant, <<"fetch">>, ?FETCH_SCOPE) of
                true -> ok;
                false ->
                    {error, 403, <<"grant \"", (apr_grant:token(Grant))/binary,
                                   "\" does not cover fetch:asset">>}
            end
    end.

serve(<<>>, Req) ->
    detail(422, <<"an asset id is required">>, Req);
serve(Reference, Req) ->
    case apr_assets:get(Reference) of
        {ok, MediaType, Bytes} ->
            cowboy_req:reply(200,
                             #{<<"content-type">> => MediaType,
                               <<"etag">> => <<"\"", (apr_assets:digest_of(Reference))/binary,
                                               "\"">>},
                             Bytes, Req);
        {error, not_propagated} ->
            pending(Reference, Req)
    end.

pending(Reference, Req) ->
    Body = {obj, [{<<"detail">>, <<"asset has not propagated yet">>},
                  {<<"asset">>, Reference},
                  %% "Not yet" and "never" are different answers, and a consumer that has to
                  %% guess which one it got will either give up early or retry forever.
                  {<<"pending">>, true}]},
    cowboy_req:reply(404, #{<<"content-type">> => <<"application/json">>},
                     apr_json:encode(Body), Req).

detail(Status, Message, Req) ->
    cowboy_req:reply(Status, #{<<"content-type">> => <<"application/json">>},
                     apr_json:encode({obj, [{<<"detail">>, Message}]}), Req).
