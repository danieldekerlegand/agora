%%% @doc The top supervisor.
%%%
%%% The cowboy listener runs under ranch's own supervisor, started from the application
%%% callback. This tree owns the two halves of the router:
%%%
%%% * the **sacred ladder** (US-2) under {@link apr_ladder_sup} — the per-modality rung trees
%%%   (paid / mlx / local rung workers plus the permanent placeholder worker), where a
%%%   crashing rung is just the next child rather than a failed request;
%%% * the **capability bus** (US-4) — the asset store, the dynamic tree of consumer
%%%   subscriptions, and the registry that indexes them (`capability-bus.md' §4).
%%%
%%% Order matters on the way up and on the way down. `apr_assets' and `apr_subscriber_sup'
%%% start before `apr_bus' because the registry starts children in the one and the fan-out
%%% resolves references against the other; `one_for_one' keeps a restart of any of them from
%%% disturbing the ladder, whose availability is the invariant everything else is subordinate
%%% to. Nothing in the bus can make a generation fail: the worst case is that a published
%%% event finds no index and is dropped.
-module(agora_provider_router_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

-spec init([]) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init([]) ->
    SupFlags = #{strategy => one_for_one, intensity => 5, period => 10},
    {ok, {SupFlags, [worker(apr_assets), supervisor(apr_subscriber_sup),
                     worker(apr_bus), supervisor(apr_ladder_sup)]}}.

worker(Module) ->
    #{id => Module, start => {Module, start_link, []},
      restart => permanent, shutdown => 5000, type => worker}.

supervisor(Module) ->
    #{id => Module, start => {Module, start_link, []},
      restart => permanent, shutdown => infinity, type => supervisor}.
