%%% @doc The dynamic supervisor over consumer subscriptions ({@link apr_subscriber}).
%%%
%%% `simple_one_for_one' with `restart => temporary': a subscription is a *relationship with a
%%% consumer*, not a service. If it dies — the consumer disconnected, its callback raised, its
%%% grant's ceiling ran out — restarting it would recreate a stream nobody is reading and
%%% silently reset the ledger that bounds its spend. The consumer resubscribes, presenting its
%%% grant again, or it does not.
%%%
%%% This is deliberately the opposite call from the rung workers ({@link apr_modality_sup}),
%%% which are `permanent' because a modality's ladder must exist whether or not anyone is
%%% currently using it.
-module(apr_subscriber_sup).
-behaviour(supervisor).

-export([start_link/0, start_subscriber/4, init/1]).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

-spec start_subscriber(binary(), binary(), apr_grant:grant(), map()) ->
          supervisor:startchild_ret().
start_subscriber(Ref, Topic, Grant, Opts) ->
    supervisor:start_child(?MODULE, [Ref, Topic, Grant, Opts]).

-spec init([]) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init([]) ->
    SupFlags = #{strategy => simple_one_for_one, intensity => 0, period => 1},
    Child = #{id => apr_subscriber,
              start => {apr_subscriber, start_link, []},
              restart => temporary, shutdown => 5000, type => worker},
    {ok, {SupFlags, [Child]}}.
