%%% @doc One consumer subscription — one lightweight BEAM process (`capability-bus.md' §4).
%%%
%%% The subscription is a process rather than a row in the publisher's loop for one reason:
%%% **back-pressure has to be somebody's problem, and it must not be the producer's.** A
%%% delivery is a `cast', so {@link apr_bus:publish/2} never blocks; a consumer that cannot
%%% keep up simply grows *this* process's mailbox, leaving the ladder and every other
%%% subscriber untouched. §7's open question (firehose flow-control) is infra's; process
%%% isolation is what makes it safe to defer.
%%%
%%% What the process owns:
%%%
%%% * **The seen set.** Claim ids are content-addressed (§4 / KGP §6), so a redelivery is
%%%   detectable by value and dropped. That is why the bus needs no exactly-once guarantee —
%%%   at-least-once plus idempotence is the same thing from the consumer's side. Nothing here
%%%   inspects ordering: an event that arrives "late" is just an event.
%%% * **The ledger.** The grant's `budget_units' ceiling (§5) is spent down by the events
%%%   delivered. When the next event would cross it the stream is closed with
%%%   `budget_exhausted' rather than delivered — a grant bounds the whole stream, not each
%%%   event. Zero-cost events never exhaust a ceiling, so a free world stream runs forever
%%%   under a ceiling of `0'.
%%%
%%% Delivery targets are either a pid (`deliver_to', the SSE connection or a test consumer,
%%% which receives `{kcb_event, Ref, Envelope}') or a fun (`deliver', called in this process).
%%% A fun that blocks blocks only this subscription — that is the point.
-module(apr_subscriber).
-behaviour(gen_server).

-export([start_link/4, deliver/2, status/1, stop/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2]).

-type envelope() :: #{id := binary(), topic := binary(), kind := binary(),
                      cost_units := float(), json := apr_json:object()}.

-export_type([envelope/0]).

-spec start_link(binary(), binary(), apr_grant:grant(), map()) -> {ok, pid()} | {error, term()}.
start_link(Ref, Topic, Grant, Opts) ->
    gen_server:start_link(?MODULE, {Ref, Topic, Grant, Opts}, []).

-spec init({binary(), binary(), apr_grant:grant(), map()}) -> {ok, map()}.
init({Ref, Topic, Grant, Opts}) ->
    Target = target(Opts),
    _ = case Target of
            {pid, Pid} -> erlang:monitor(process, Pid);
            {'fun', _Fun} -> undefined
        end,
    {ok, #{ref => Ref, topic => Topic, grant => Grant, target => Target,
           ceiling => apr_grant:ceiling(Grant),
           seen => #{}, spent => 0.0, delivered => 0, dropped => 0}}.

target(#{deliver := Fun}) when is_function(Fun, 1) -> {'fun', Fun};
target(#{deliver_to := Pid}) when is_pid(Pid) -> {pid, Pid};
target(_Opts) -> {'fun', fun(_Envelope) -> ok end}.

%% @doc Hand an envelope to a subscription. Asynchronous by contract: the publisher's cost is
%% one message send per subscriber, whatever the subscribers are doing.
-spec deliver(pid(), envelope()) -> ok.
deliver(Pid, Envelope) -> gen_server:cast(Pid, {deliver, Envelope}).

%% @doc The subscription's counters — what was delivered, what was dropped as a redelivery,
%% and what has been spent against the grant.
-spec status(pid()) -> map().
status(Pid) -> gen_server:call(Pid, status, 5000).

-spec stop(pid()) -> ok.
stop(Pid) -> gen_server:stop(Pid, normal, 5000).

handle_call(status, _From, State) ->
    #{ref := Ref, topic := Topic, delivered := Delivered,
      dropped := Dropped, spent := Spent, ceiling := Ceiling} = State,
    {reply, #{ref => Ref, topic => Topic, delivered => Delivered,
              dropped => Dropped, spent => Spent, ceiling => Ceiling}, State}.

handle_cast({deliver, Envelope}, State) ->
    #{id := Id, cost_units := Cost} = Envelope,
    #{seen := Seen, spent := Spent, ceiling := Ceiling} = State,
    case maps:is_key(Id, Seen) of
        true ->
            %% A content-addressed id we already have. Silently idempotent — a redelivery is
            %% the transport doing its job, not an error to report.
            {noreply, maps:update_with(dropped, fun(N) -> N + 1 end, State)};
        false ->
            case affordable(Spent, Cost, Ceiling) of
                false ->
                    _ = notify_closed(State, budget_exhausted),
                    {stop, normal, State};
                true ->
                    _ = emit(State, Envelope),
                    {noreply, State#{seen := Seen#{Id => true},
                                     spent := Spent + Cost,
                                     delivered := maps:get(delivered, State) + 1}}
            end
    end;
handle_cast(_Message, State) ->
    {noreply, State}.

%% The consumer went away — the subscription has nothing left to feed and stops, which the
%% bus's own monitor turns into a deregistration.
handle_info({'DOWN', _MonitorRef, process, _Pid, _Reason}, State) ->
    {stop, normal, State};
handle_info(_Message, State) ->
    {noreply, State}.

affordable(_Spent, _Cost, undefined) -> true;
affordable(Spent, Cost, Ceiling) -> Spent + Cost =< Ceiling.

emit(#{target := {pid, Pid}, ref := Ref}, Envelope) ->
    Pid ! {kcb_event, Ref, Envelope};
emit(#{target := {'fun', Fun}}, Envelope) ->
    %% A consumer callback that raises kills only this subscription; the fan-out and the
    %% ladder never see it.
    try Fun(Envelope)
    catch _Class:_Reason -> ok
    end.

notify_closed(#{target := {pid, Pid}, ref := Ref}, Reason) ->
    Pid ! {kcb_closed, Ref, Reason};
notify_closed(#{target := {'fun', Fun}, ref := Ref}, Reason) ->
    try Fun(#{id => <<"closed">>, topic => <<>>, kind => <<"closed">>, cost_units => 0.0,
              json => {obj, [{<<"kind">>, <<"closed">>},
                             {<<"subscription">>, Ref},
                             {<<"reason">>, atom_to_binary(Reason, utf8)}]}})
    catch _Class:_Error -> ok
    end.
