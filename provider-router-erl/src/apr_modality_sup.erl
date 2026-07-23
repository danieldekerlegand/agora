%%% @doc One modality's rung tree: a supervisor over its paid/mlx/local rung workers plus the
%%% permanent placeholder worker.
%%%
%%% `one_for_one', so a crashing rung is restarted on its own without disturbing its siblings
%%% or the placeholder — the tree "moves to the next child" for the in-flight request (handled
%%% by {@link apr_router}) and heals the crashed rung for the next one. The intensity is set
%%% generously so a burst of transport crashes degrades to the placeholder rather than
%%% escalating to the parent.
-module(apr_modality_sup).
-behaviour(supervisor).

-export([start_link/1, name/1, init/1]).

-type modality() :: atom().

-spec name(modality()) -> atom().
name(Modality) ->
    list_to_atom("apr_modality_sup$" ++ atom_to_list(Modality)).

-spec start_link(modality()) -> {ok, pid()} | {error, term()}.
start_link(Modality) ->
    supervisor:start_link({local, name(Modality)}, ?MODULE, Modality).

-spec init(modality()) -> {ok, {supervisor:sup_flags(), [supervisor:child_spec()]}}.
init(Modality) ->
    SupFlags = #{strategy => one_for_one, intensity => 20, period => 10},
    Rungs = [rung_spec(Modality, Tier) || Tier <- apr_ladder:tiers()],
    Placeholder = #{id => placeholder,
                    start => {apr_placeholder_worker, start_link, [Modality]},
                    restart => permanent, shutdown => 5000, type => worker},
    {ok, {SupFlags, Rungs ++ [Placeholder]}}.

rung_spec(Modality, Tier) ->
    #{id => {rung, Tier},
      start => {apr_rung_worker, start_link, [Modality, Tier]},
      restart => permanent, shutdown => 5000, type => worker}.
