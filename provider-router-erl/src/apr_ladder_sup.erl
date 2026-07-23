%%% @doc The ladder tree root: a supervisor over one {@link apr_modality_sup} per modality.
%%%
%%% Each modality gets its own subtree of rung workers, so the five ladders are isolated from
%%% one another — a storm of crashes in one modality can never take down another's rungs.
-module(apr_ladder_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

-spec init([]) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init([]) ->
    SupFlags = #{strategy => one_for_one, intensity => 10, period => 10},
    Children = [#{id => {modality, Modality},
                  start => {apr_modality_sup, start_link, [Modality]},
                  restart => permanent, shutdown => infinity, type => supervisor}
                || Modality <- apr_ladder:modalities()],
    {ok, {SupFlags, Children}}.
