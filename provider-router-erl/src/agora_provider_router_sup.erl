%%% @doc The top supervisor.
%%%
%%% Empty for US-1 — the cowboy listener runs under ranch's own supervisor, started from
%%% the application callback. US-2 populates this tree with the per-modality ladder
%%% supervisors (paid / mlx / local rung workers plus the permanent placeholder worker),
%%% where a crashing rung is just the next child rather than a failed request.
-module(agora_provider_router_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

-spec init([]) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init([]) ->
    SupFlags = #{strategy => one_for_one, intensity => 1, period => 5},
    {ok, {SupFlags, []}}.
