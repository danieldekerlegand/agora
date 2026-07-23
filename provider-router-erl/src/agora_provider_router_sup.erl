%%% @doc The top supervisor.
%%%
%%% The cowboy listener runs under ranch's own supervisor, started from the application
%%% callback. This tree owns the sacred ladder (US-2): its one child is {@link
%%% apr_ladder_sup}, the root of the per-modality rung trees (paid / mlx / local rung workers
%%% plus the permanent placeholder worker), where a crashing rung is just the next child
%%% rather than a failed request.
-module(agora_provider_router_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

-spec init([]) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init([]) ->
    SupFlags = #{strategy => one_for_one, intensity => 5, period => 10},
    LadderSup = #{id => apr_ladder_sup,
                  start => {apr_ladder_sup, start_link, []},
                  restart => permanent, shutdown => infinity, type => supervisor},
    {ok, {SupFlags, [LadderSup]}}.
