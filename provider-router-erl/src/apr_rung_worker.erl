%%% @doc A per-rung worker process: one `gen_server' per (modality, tier) pair for the
%%% dialable tiers (paid, mlx, local).
%%%
%%% This is where `router.py::Router.complete''s per-rung logic lives, one process at a time:
%%% on a `{serve, ...}' call the worker resolves its own tier against the live configuration
%%% and either serves it (dialing the injected transport) or reports why it cannot — as an
%%% `Attempt' the router records before walking to the next child.
%%%
%%% The worker does NOT catch a transport that raises: a crashing rung takes down only this
%%% process, its supervisor restarts it, and {@link apr_router} — which called it with a
%%% monitored `gen_server:call' — records the crash as a failed attempt and walks on. That is
%%% the always-completes invariant expressed as a supervision tree: an unconfigured, timing
%%% out, crashing or erroring rung is just the next child, never a failed request.
-module(apr_rung_worker).
-behaviour(gen_server).

-export([start_link/2, name/2]).
-export([init/1, handle_call/3, handle_cast/2]).

-type modality() :: atom().
-type tier() :: paid | mlx | local.

%% @doc The registered name for a rung worker — a bounded set (5 modalities x 3 tiers).
-spec name(modality(), tier()) -> atom().
name(Modality, Tier) ->
    list_to_atom("apr_rung$" ++ atom_to_list(Modality) ++ "$" ++ atom_to_list(Tier)).

-spec start_link(modality(), tier()) -> {ok, pid()} | {error, term()}.
start_link(Modality, Tier) ->
    gen_server:start_link({local, name(Modality, Tier)}, ?MODULE, {Modality, Tier}, []).

-spec init({modality(), tier()}) -> {ok, map()}.
init({Modality, Tier}) ->
    {ok, #{modality => Modality, tier => Tier}}.

handle_call({serve, Payload, Ceiling, Transport}, _From, State) ->
    #{modality := Modality, tier := Tier} = State,
    Config = apr_config:from_env(),
    Resolution = apr_backends:resolve_tier(Tier, Modality, Config),
    {reply, serve(Resolution, Tier, Payload, Ceiling, Transport), State}.

handle_cast(_Message, State) ->
    {noreply, State}.

%% A ready rung is dialed; the transport says whether it answered. A rung that is
%% unconfigured or pending-adapter has no backend, so it is skipped without being dialed.
serve(#{status := ready, backend := Backend}, Tier, Payload, _Ceiling, Transport) ->
    Provider = maps:get(provider, Backend),
    %% agora:80 US-3 layers the budget projection/refusal in front of this dial.
    case Transport(Backend, dial_payload(Backend, Payload)) of
        {ok, Response} ->
            {ok, Response, Backend,
             #{tier => Tier, provider => Provider, ok => true, dialed => true}};
        {error, Reason} ->
            {failed, #{tier => Tier, provider => Provider, ok => false,
                       dialed => true, reason => to_binary(Reason)}}
    end;
serve(#{status := Status, reason := Reason}, Tier, _Payload, _Ceiling, _Transport) ->
    {skip, #{tier => Tier, provider => <<"-">>, ok => false, dialed => false,
             reason => skip_reason(Reason, Status)}}.

dial_payload(Backend, Payload) ->
    maps:put(<<"model">>, maps:get(model, Backend), Payload).

skip_reason(undefined, Status) -> atom_to_binary(Status, utf8);
skip_reason(Reason, _Status) -> Reason.

to_binary(Bin) when is_binary(Bin) -> Bin;
to_binary(Term) -> unicode:characters_to_binary(io_lib:format("~p", [Term])).
