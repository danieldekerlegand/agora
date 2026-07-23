%%% @doc The KCB `subscribe' verb — registration and fan-out (`capability-bus.md' §4).
%%%
%%% "`subscribe' — A2A streaming / MCP notifications: register for a world or capability;
%%% receive KGP **deltas** (KGP §6) or media events as they occur."
%%%
%%% The shape
%%% ---------
%%% A **topic** is `world/<world>' or `capability/<name>' — the two things §4 says a consumer
%%% registers against. `world/*' and `capability/*' subscribe to every one of their kind, the
%%% same wildcard spelling the manifest publishes as a producer's `world_pattern' (delta J).
%%%
%%% A **subscription** is a process ({@link apr_subscriber}), one per consumer, held in a
%%% `simple_one_for_one' tree. This module is only the registry: an ETS index from topic to
%%% subscriber pid, plus the monitors that keep it honest when a subscriber dies.
%%%
%%% Why publishing does not go through this gen_server
%%% --------------------------------------------------
%%% {@link publish/2} runs **in the publisher's own process**: it reads the index from ETS and
%%% casts to each subscriber. Routing a firehose through one registry process would make the
%%% registry the bottleneck the per-consumer processes exist to avoid, and would put the
%%% ladder's hot path behind a queue shared with every consumer. Registration is serialized
%%% here because it is rare and has to be; delivery is not, because it is neither.
%%%
%%% Authorization (§5)
%%% ------------------
%%% Registration needs a grant covering `subscribe' on the topic's scope, and the grant's
%%% `budget_units' ceiling is checked twice: **here**, against what one event on a capability
%%% topic is projected to cost — a grant that cannot afford a single delivery is refused
%%% outright rather than admitted to a stream that would immediately close — and **on the
%%% stream**, event by event, in the subscriber. A world topic has no per-event projection to
%%% check against, so only the stream ledger bounds it.
-module(apr_bus).
-behaviour(gen_server).

-export([start_link/0, subscribe/2, subscribe/3, unsubscribe/1, publish/2,
         subscribers/1, subscription_count/0, refs/0, parse_topic/1,
         world_topic/1, capability_topic/1, envelope/2, event_id/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2]).

-define(TABLE, apr_bus_subscriptions).

-type topic() :: binary().
-type registration() :: #{ref := binary(), pid := pid(), topic := topic()}.

-export_type([topic/0, registration/0]).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec init([]) -> {ok, map()}.
init([]) ->
    _ = ets:new(?TABLE, [named_table, protected, bag, {read_concurrency, true}]),
    {ok, #{subs => #{}, by_pid => #{}}}.

%% --- registration -----------------------------------------------------------

%% @doc Register the calling process for `Topic' under `Grant'.
-spec subscribe(term(), term()) -> {ok, registration()} | {error, 403 | 422, binary()}.
subscribe(Topic, Grant) -> subscribe(Topic, Grant, #{}).

%% @doc As {@link subscribe/2}, with a delivery target: `deliver_to' (a pid, defaulting to the
%% caller, which receives `{kcb_event, Ref, Envelope}') or `deliver' (a one-arity fun run in
%% the subscription's own process).
-spec subscribe(term(), term(), map()) -> {ok, registration()} | {error, 403 | 422, binary()}.
subscribe(TopicTerm, GrantTerm, Opts0) ->
    Opts = default_target(Opts0),
    case parse_topic(TopicTerm) of
        {error, Status, Message} -> {error, Status, Message};
        {ok, Topic} ->
            case apr_grant:parse(GrantTerm) of
                {error, Status, Message} -> {error, Status, Message};
                {ok, Grant} -> authorize(Topic, Grant, Opts)
            end
    end.

default_target(Opts) ->
    case maps:is_key(deliver, Opts) orelse maps:is_key(deliver_to, Opts) of
        true -> Opts;
        false -> Opts#{deliver_to => self()}
    end.

authorize(Topic, Grant, Opts) ->
    case apr_grant:permits(Grant, <<"subscribe">>, apr_grant:required_scope(Topic)) of
        false ->
            {error, 403,
             <<"grant \"", (apr_grant:token(Grant))/binary, "\" does not cover subscribe:",
               (apr_grant:required_scope(Topic))/binary>>};
        true ->
            case affordable(Topic, Grant) of
                {error, Message} -> {error, 403, Message};
                ok -> register_subscription(Topic, Grant, Opts)
            end
    end.

%% §5: a grant "carries a spend ceiling ... so a cross-project chain cannot exceed the
%% caller's authorized spend". For a capability topic the router already knows what one event
%% is projected to cost — the manifest advertises exactly that number (§2.1) — so a ceiling
%% that cannot cover a single one is refused at registration, before anything is delivered.
%% The unpriced rule rides along in {@link apr_cost:within/2}: an unpriceable capability never
%% passes a ceiling, because "we don't know" must not read as "free".
affordable(<<"capability/", Name/binary>>, Grant) ->
    case {modality_of(Name), apr_grant:ceiling(Grant)} of
        {undefined, _Ceiling} -> ok;
        {_Modality, undefined} -> ok;
        {Modality, Ceiling} -> affordable(Modality, Ceiling, apr_config:from_env())
    end;
affordable(_Topic, _Grant) ->
    ok.

affordable(Modality, Ceiling, Config) ->
    Backend = apr_router:resolve(Modality, Config),
    Provider = maps:get(provider, Backend),
    Cost = apr_cost:project(Modality, Provider, apr_manifest:nominal(Modality),
                            apr_config:ladder_env(Config)),
    case apr_cost:within(Cost, Ceiling) of
        true -> ok;
        false -> {error, apr_cost:refusal(Cost, Ceiling, Modality, Provider)}
    end.

modality_of(Name) ->
    Matches = [M || M <- apr_ladder:modalities(), apr_manifest:capability_name(M) =:= Name],
    case Matches of
        [Modality] -> Modality;
        [] -> undefined
    end.

register_subscription(Topic, Grant, Opts) ->
    gen_server:call(?MODULE, {register, Topic, Grant, Opts}).

%% @doc Drop a subscription. Idempotent: an already-gone subscription is still `ok'.
-spec unsubscribe(binary()) -> ok.
unsubscribe(Ref) -> gen_server:call(?MODULE, {unregister, Ref}).

%% --- fan-out ----------------------------------------------------------------

%% @doc Deliver `Event' to every subscription registered for `Topic' (and to the matching
%% wildcard topic). Runs in the caller's process and never blocks on a consumer; the reply is
%% how many subscriptions it was handed to, not how many have processed it.
-spec publish(term(), term()) -> {ok, non_neg_integer()} | {error, 422, binary()}.
publish(TopicTerm, Event) ->
    case parse_topic(TopicTerm) of
        {error, Status, Message} -> {error, Status, Message};
        {ok, Topic} ->
            Envelope = envelope(Topic, Event),
            Targets = lookup(Topic) ++ wildcard_targets(Topic),
            _ = [apr_subscriber:deliver(Pid, Envelope) || {_T, _R, Pid} <- Targets],
            {ok, length(Targets)}
    end.

wildcard_targets(Topic) ->
    case wildcard(Topic) of
        Topic -> [];
        Wildcard -> lookup(Wildcard)
    end.

wildcard(<<"world/", _Rest/binary>>) -> <<"world/*">>;
wildcard(<<"capability/", _Rest/binary>>) -> <<"capability/*">>;
wildcard(Topic) -> Topic.

lookup(Topic) ->
    case ets:whereis(?TABLE) of
        undefined -> [];
        Table -> ets:lookup(Table, Topic)
    end.

%% @doc The registered `{Topic, Ref, Pid}' entries for a topic — the index, unfiltered.
-spec subscribers(binary()) -> [{binary(), binary(), pid()}].
subscribers(Topic) -> lookup(Topic).

-spec subscription_count() -> non_neg_integer().
subscription_count() -> gen_server:call(?MODULE, count).

%% @doc Every open subscription reference — the registry's own view, which (unlike the ETS
%% index) needs no guess about which topics might be in use.
-spec refs() -> [binary()].
refs() -> gen_server:call(?MODULE, refs).

%% --- the wire form ----------------------------------------------------------

%% @doc Wrap `Event' for delivery: its content-addressed id, the topic it arrived on, its kind
%% and what it costs against a grant's ceiling, around the producer's payload verbatim.
-spec envelope(binary(), term()) -> apr_subscriber:envelope().
envelope(Topic, Event) ->
    Id = event_id(Event),
    Kind = case apr_json:get(<<"kind">>, Event, <<"delta">>) of
               K when is_binary(K) -> K;
               _ -> <<"delta">>
           end,
    Cost = cost_units(Event),
    #{id => Id, topic => Topic, kind => Kind, cost_units => Cost,
      json => {obj, [{<<"topic">>, Topic},
                     {<<"id">>, Id},
                     {<<"kind">>, Kind},
                     {<<"cost_units">>, Cost},
                     {<<"data">>, Event}]}}.

%% @doc An event's identity. A producer's own content-addressed id wins (KGP claim ids are
%% hashes of the claim, §4); otherwise the canonical digest of the event stands in. Either way
%% the id is a function of the *content*, which is what makes redelivery idempotent and lets
%% the bus skip an exactly-once guarantee it could not honestly give.
-spec event_id(term()) -> binary().
event_id(Event) ->
    case authored_id(Event) of
        undefined -> <<"kcb:event:sha256:", (apr_placeholder:digest(Event))/binary>>;
        Id -> Id
    end.

authored_id(Event) ->
    case apr_json:get(<<"claim_id">>, Event) of
        Id when is_binary(Id), Id =/= <<>> -> Id;
        _ ->
            case apr_json:get(<<"id">>, Event) of
                Id2 when is_binary(Id2), Id2 =/= <<>> -> Id2;
                _ -> undefined
            end
    end.

cost_units(Event) ->
    case apr_json:get(<<"cost_units">>, Event, 0) of
        Number when is_number(Number) -> float(Number);
        _ -> 0.0
    end.

%% --- topics -----------------------------------------------------------------

%% @doc Validate a topic. A capability topic must name a capability this router actually
%% offers — a stream for a capability that does not exist would never emit, and saying so at
%% registration is the same courtesy as refusing an unaffordable grant.
-spec parse_topic(term()) -> {ok, topic()} | {error, 422, binary()}.
parse_topic(<<"world/", World/binary>>) when World =/= <<>> ->
    {ok, <<"world/", World/binary>>};
parse_topic(<<"capability/*">>) ->
    {ok, <<"capability/*">>};
parse_topic(<<"capability/", Name/binary>>) when Name =/= <<>> ->
    case modality_of(Name) of
        undefined ->
            {error, 422, <<"no capability \"", Name/binary, "\" is offered by this router">>};
        _Modality ->
            {ok, <<"capability/", Name/binary>>}
    end;
parse_topic(_Other) ->
    {error, 422,
     <<"a topic is \"world/<world>\" or \"capability/<name>\" (capability-bus.md §4)"/utf8>>}.

-spec world_topic(binary()) -> topic().
world_topic(World) -> <<"world/", World/binary>>.

-spec capability_topic(atom()) -> topic().
capability_topic(Modality) -> <<"capability/", (apr_manifest:capability_name(Modality))/binary>>.

%% --- the registry process ---------------------------------------------------

handle_call({register, Topic, Grant, Opts}, _From, State) ->
    Ref = new_ref(),
    case apr_subscriber_sup:start_subscriber(Ref, Topic, Grant, Opts) of
        {ok, Pid} ->
            _ = erlang:monitor(process, Pid),
            true = ets:insert(?TABLE, {Topic, Ref, Pid}),
            #{subs := Subs, by_pid := ByPid} = State,
            {reply, {ok, #{ref => Ref, pid => Pid, topic => Topic}},
             State#{subs := Subs#{Ref => {Topic, Pid}}, by_pid := ByPid#{Pid => Ref}}};
        Other ->
            {reply, {error, 422, reason_binary(Other)}, State}
    end;
handle_call({unregister, Ref}, _From, State) ->
    case maps:get(Ref, maps:get(subs, State), undefined) of
        undefined -> {reply, ok, State};
        {_Topic, Pid} ->
            try apr_subscriber:stop(Pid)
            catch _Class:_Reason -> ok
            end,
            {reply, ok, forget(Pid, State)}
    end;
handle_call(count, _From, State) ->
    {reply, maps:size(maps:get(subs, State)), State};
handle_call(refs, _From, State) ->
    {reply, maps:keys(maps:get(subs, State)), State};
handle_call(_Request, _From, State) ->
    {reply, {error, unknown_request}, State}.

handle_cast(_Message, State) ->
    {noreply, State}.

%% A subscription that ends for any reason — consumer gone, ceiling exhausted, callback
%% crash — deregisters itself here, so the index can never hand a publisher a dead pid.
handle_info({'DOWN', _MonitorRef, process, Pid, _Reason}, State) ->
    {noreply, forget(Pid, State)};
handle_info(_Message, State) ->
    {noreply, State}.

forget(Pid, State) ->
    #{subs := Subs, by_pid := ByPid} = State,
    case maps:get(Pid, ByPid, undefined) of
        undefined -> State;
        Ref ->
            case maps:get(Ref, Subs, undefined) of
                undefined -> State#{by_pid := maps:remove(Pid, ByPid)};
                {Topic, _Pid} ->
                    true = ets:delete_object(?TABLE, {Topic, Ref, Pid}),
                    State#{subs := maps:remove(Ref, Subs), by_pid := maps:remove(Pid, ByPid)}
            end
    end.

new_ref() ->
    <<"kcb:sub:", (hex(crypto:strong_rand_bytes(12)))/binary>>.

hex(Bin) -> << <<(nibble(N))>> || <<N:4>> <= Bin >>.

nibble(N) when N < 10 -> $0 + N;
nibble(N) -> ($a - 10) + N.

reason_binary(Reason) ->
    unicode:characters_to_binary(io_lib:format("~p", [Reason])).
