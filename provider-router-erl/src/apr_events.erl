%%% @doc What the router publishes on the bus: one event per completed generation
%%% (`capability-bus.md' §4 — "receive KGP deltas or media events **as they occur**").
%%%
%%% A generation is announced on two topics: its capability (`capability/generate.image') and,
%%% when the request named a world, that world (`world/<world>'). The second is what makes
%%% delta J's `world_pattern' on the manifest's produced media ports mean something — a peer
%%% that wants "media *from world X*" subscribes to the world, not to this router.
%%%
%%% The event's `claim_id' is the digest of the response, so it is **content-addressed**: the
%%% same generation announced twice carries the same id, and a consumer that sees it twice
%%% drops the second (KGP §6 / {@link apr_subscriber}). That is the whole reason the fan-out
%%% can be at-least-once.
%%%
%%% Media artifacts are put in the store ({@link apr_assets}) and referenced, not inlined.
%%% References are cheap to fan out to a thousand subscribers and bytes are not — and the
%%% reference is allowed to outrun the bytes anyway (delta L), which is exactly why `fetch'
%%% exists as a separate verb.
%%%
%%% **Announcing can never fail a request.** It runs after the response has been sent, and
%%% every path through it is guarded: a publish with no subscribers, an absent asset store, a
%%% response in a shape this router did not produce — all of them are `ok'. The bus is an
%%% observer of the ladder, never a participant in it.
-module(apr_events).

-export([announce/3, event/3, world_of/1]).

-type modality() :: atom().

%% @doc Publish `Completion' to its capability topic, and to its world topic when the request
%% named one. Never raises and never blocks on a consumer.
-spec announce(modality(), term(), apr_router:completion()) -> ok.
announce(Modality, Payload, Completion) ->
    try
        Event = event(Modality, Payload, Completion),
        _ = apr_bus:publish(apr_bus:capability_topic(Modality), Event),
        _ = case world_of(Payload) of
                undefined -> ok;
                World -> apr_bus:publish(apr_bus:world_topic(World), Event)
            end,
        ok
    catch
        _Class:_Reason -> ok
    end.

%% @doc The event body for a completion, ready to publish.
-spec event(modality(), term(), apr_router:completion()) -> apr_json:object().
event(Modality, Payload, Completion) ->
    #{backend := Backend, response := Response, actual := Actual} = Completion,
    Base = [{<<"kind">>, kind(Modality)},
            {<<"claim_id">>, <<"kgp:claim:sha256:", (apr_placeholder:digest(Response))/binary>>},
            {<<"capability">>, apr_manifest:capability_name(Modality)},
            {<<"modality">>, atom_to_binary(Modality, utf8)},
            {<<"tier">>, atom_to_binary(maps:get(tier, Backend), utf8)},
            {<<"provider">>, maps:get(provider, Backend)},
            {<<"model">>, maps:get(model, Backend)},
            %% What this event spends against a subscriber's grant ceiling (§5) — the same
            %% number the response's own routing report carries, so a consumer's ledger and
            %% the caller's bill are denominated identically.
            {<<"cost_units">>, apr_cost:units(Actual)}],
    WithWorld = case world_of(Payload) of
                    undefined -> Base;
                    World -> Base ++ [{<<"world">>, World}]
                end,
    case asset(Modality, Response) of
        undefined -> {obj, WithWorld};
        Asset -> {obj, WithWorld ++ [{<<"asset">>, Asset}]}
    end.

%% Text is a knowledge-plane event; every other modality produces a media artifact (§2.1).
kind(text) -> <<"knowledge">>;
kind(_Modality) -> <<"media">>.

%% @doc The world a request named, if any. Read, never stripped: `world' is not an agora
%% extension the way `budget_units' is, so removing it would change the bytes forwarded
%% upstream — and the placeholder's digest with them.
-spec world_of(term()) -> binary() | undefined.
world_of(Payload) ->
    case apr_json:get(<<"world">>, Payload) of
        World when is_binary(World), World =/= <<>> -> World;
        _Other -> undefined
    end.

asset(text, _Response) ->
    undefined;
asset(Modality, Response) ->
    case artifact(Response) of
        undefined -> undefined;
        {Bytes, MediaType} ->
            Id = apr_assets:put(Bytes, media_type(MediaType, Modality)),
            {obj, [{<<"id">>, Id},
                   {<<"media_type">>, media_type(MediaType, Modality)},
                   {<<"fetch">>, apr_assets:fetch_path(Id)}]}
    end.

%% The OpenAI media envelope: `data[0].b64_json'. An upstream vendor that answers in some
%% other shape simply yields no asset — a media event without a reference is still a valid
%% event, and inventing one would be worse than omitting it.
artifact(Response) ->
    case apr_json:get(<<"data">>, Response) of
        [Entry | _Rest] ->
            case apr_json:get(<<"b64_json">>, Entry) of
                Encoded when is_binary(Encoded) ->
                    try {base64:decode(Encoded), apr_json:get(<<"media_type">>, Entry)}
                    catch _Class:_Reason -> undefined
                    end;
                _Other -> undefined
            end;
        _Other -> undefined
    end.

media_type(MediaType, _Modality) when is_binary(MediaType), MediaType =/= <<>> -> MediaType;
media_type(_Absent, Modality) -> apr_placeholder:media_type(Modality).
