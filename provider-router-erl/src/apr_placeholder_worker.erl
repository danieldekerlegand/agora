%%% @doc The terminal-tier worker: one permanent `gen_server' per modality.
%%%
%%% It is the child that makes the supervision tree always complete — offline, free and
%%% deterministic, it can never be unconfigured or fail, so the ladder walk always terminates
%%% in a response here. It dials nothing; it computes the deterministic stand-in in-process
%%% ({@link apr_placeholder}).
-module(apr_placeholder_worker).
-behaviour(gen_server).

-export([start_link/1, name/1]).
-export([init/1, handle_call/3, handle_cast/2]).

-type modality() :: atom().

%% @doc The registered name for a modality's placeholder worker.
-spec name(modality()) -> atom().
name(Modality) ->
    list_to_atom("apr_placeholder$" ++ atom_to_list(Modality)).

-spec start_link(modality()) -> {ok, pid()} | {error, term()}.
start_link(Modality) ->
    gen_server:start_link({local, name(Modality)}, ?MODULE, Modality, []).

-spec init(modality()) -> {ok, map()}.
init(Modality) ->
    {ok, #{modality => Modality}}.

%% The ceiling is accepted and deliberately not enforced: the placeholder is priced (never
%% `unpriced') at `0.0', and `parse_ceiling' clamps a negative ceiling to zero, so it survives
%% every ceiling by construction. Gating it anyway would make the terminal child refusable —
%% the one thing always-completes forbids. Its success attempt carries no `projected', exactly
%% as `router.py' records the placeholder rung.
handle_call({serve, Payload, _Ceiling, _Transport}, _From, State) ->
    #{modality := Modality} = State,
    Backend = apr_backends:placeholder_backend(Modality),
    Response = apr_placeholder:complete(Modality, Payload, maps:get(model, Backend)),
    Attempt = #{tier => placeholder, provider => <<"placeholder">>, ok => true, dialed => true},
    {reply, {ok, Response, Backend, Attempt}, State}.

handle_cast(_Message, State) ->
    {noreply, State}.
