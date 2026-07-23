%%% @doc A per-rung worker process: one `gen_server' per (modality, tier) pair for the
%%% dialable tiers (paid, mlx, local).
%%%
%%% This is where `router.py::Router.complete''s per-rung logic lives, one process at a time:
%%% on a `{serve, ...}' call the worker resolves its own tier against the live configuration,
%%% **prices it before dialing** ({@link apr_cost}), and either serves it or reports why it
%%% cannot — as an `Attempt' the router records before walking to the next child.
%%%
%%% The budget gate is the reason the projection happens *here* rather than in the router: the
%%% ceiling is a constraint on the rung this worker owns, and a rung projected over budget is
%%% refused WITHOUT the transport ever being invoked, so the walk falls through to a cheaper —
%%% ultimately zero-cost — rung having spent nothing. `dialed => false' on the attempt is what
%%% a budget audit reads to tell "refused on price" from "contacted and did not answer".
%%%
%%% The worker does NOT catch a transport that raises: a crashing rung takes down only this
%%% process, its supervisor restarts it, and {@link apr_router} — which called it with a
%%% monitored `gen_server:call' — records the crash as a failed attempt and walks on. That is
%%% the always-completes invariant expressed as a supervision tree: an unconfigured, over
%%% budget, timing out, crashing or erroring rung is just the next child, never a failed
%%% request.
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
    Env = apr_config:ladder_env(Config),
    Resolution = apr_backends:resolve_tier(Tier, Modality, Config,
                                           rank(Ceiling, Modality, Payload, Env)),
    {reply, serve(Resolution, Tier, Modality, Payload, Ceiling, Transport, Env), State}.

handle_cast(_Message, State) ->
    {noreply, State}.

%% Where the ladder expresses no preference — two usable paid vendors — the cheaper is chosen
%% (KCB §3). Only under a ceiling: without one the ladder's declared order is the whole story.
rank(undefined, _Modality, _Payload, _Env) ->
    undefined;
rank(_Ceiling, Modality, Payload, Env) ->
    fun(Backend) ->
            apr_cost:units(apr_cost:project(Modality, maps:get(provider, Backend), Payload, Env))
    end.

%% A ready rung is priced, then dialed if it fits; the transport says whether it answered. A
%% rung that is unconfigured or pending-adapter has no backend, so it is skipped undialed.
serve(#{status := ready, backend := Backend}, Tier, Modality, Payload, Ceiling, Transport, Env) ->
    Provider = maps:get(provider, Backend),
    Projected = apr_cost:project(Modality, Provider, Payload, Env),
    case apr_cost:within(Projected, Ceiling) of
        false ->
            {skip, #{tier => Tier, provider => Provider, ok => false, dialed => false,
                     reason => apr_cost:refusal(Projected, Ceiling, Modality, Provider),
                     projected => Projected}};
        true ->
            dial(Backend, Tier, Provider, Payload, Projected, Transport)
    end;
serve(#{status := Status, reason := Reason}, Tier, _Modality, _Payload, _Ceiling, _Transport,
      _Env) ->
    {skip, #{tier => Tier, provider => <<"-">>, ok => false, dialed => false,
             reason => skip_reason(Reason, Status)}}.

dial(Backend, Tier, Provider, Payload, Projected, Transport) ->
    case Transport(Backend, dial_payload(Backend, Payload)) of
        {ok, Response} ->
            {ok, Response, Backend,
             #{tier => Tier, provider => Provider, ok => true, dialed => true,
               projected => Projected}};
        {error, Reason} ->
            {failed, #{tier => Tier, provider => Provider, ok => false, dialed => true,
                       reason => redact(to_binary(Reason), Backend), projected => Projected}}
    end.

dial_payload(Backend, Payload) ->
    apr_json:put_front(<<"model">>, maps:get(model, Backend), Payload).

skip_reason(undefined, Status) -> atom_to_binary(Status, utf8);
skip_reason(Reason, _Status) -> Reason.

%% A transport error's message can quote the URL it was dialing, and a base URL can carry an
%% embedded credential — so the backend's own key is redacted before the string reaches a log
%% line or a response body (`router.py::_reason').
redact(Reason, #{api_key := Key}) when is_binary(Key), byte_size(Key) > 0 ->
    binary:replace(Reason, Key, <<"***">>, [global]);
redact(Reason, _Backend) ->
    Reason.

to_binary(Bin) when is_binary(Bin) -> Bin;
to_binary(Term) -> unicode:characters_to_binary(io_lib:format("~p", [Term])).
