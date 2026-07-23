%%% @doc The router: walk the ladder, dispatch to the first rung that answers, always
%%% complete. The Erlang mirror of `router.py', re-expressed over the supervision tree.
%%%
%%% **Resolution** ({@link resolutions/2}, {@link candidates/2}, {@link doctor/1}) is a pure
%%% question of configuration — computed directly from {@link apr_backends}, dialing nothing,
%%% exactly as `router.py' computes its resolutions before it dispatches.
%%%
%%% **Dispatch** ({@link complete/2}) is a walk *across the rung workers*: for each tier in
%%% ladder order (placeholder last) it issues a monitored `gen_server:call' to that modality's
%%% worker. A rung that is unconfigured, times out, crashes or errors is recorded as an
%%% attempt and the walk moves to the next child; the placeholder worker is terminal, offline
%%% and free, so the walk always terminates in a response. A worker crash surfaces as a caught
%%% exit here — never as a failed request.
-module(apr_router).

-export([resolutions/2, resolve/2, candidates/2, doctor/0, doctor/1,
         complete/2, complete/3, completion_tier/1]).

-type modality() :: atom().
-type completion() :: #{modality := modality(), backend := apr_backends:backend(),
                       response := map(), attempts := [map()]}.

-export_type([completion/0]).

%% A rung gets this long to answer before it counts as unavailable; overridable per request
%% (`call_timeout' in the options) so a test can force a timeout without a real slow backend.
-define(DEFAULT_CALL_TIMEOUT, 30000).

%% @doc Every configured rung for `Modality' in order, plus any ladder-config error.
%% The placeholder is appended unconditionally, so the list is never empty and ends `ready'.
-spec resolutions(modality(), apr_config:config()) ->
          {[apr_backends:resolution()], binary() | undefined}.
resolutions(Modality, Config) ->
    {Tiers, Error} = apr_ladder:safe_resolve(Modality, apr_config:ladder_env(Config)),
    Resolved = [apr_backends:resolve_tier(Tier, Modality, Config) || Tier <- Tiers],
    Placeholder = #{tier => placeholder, status => ready,
                    backend => apr_backends:placeholder_backend(Modality), reason => undefined},
    {Resolved ++ [Placeholder], Error}.

%% @doc The ready backends for `Modality', in ladder order, placeholder last.
-spec candidates(modality(), apr_config:config()) -> [apr_backends:backend()].
candidates(Modality, Config) ->
    {Resolutions, _Error} = resolutions(Modality, Config),
    [maps:get(backend, R) || R <- Resolutions, maps:get(backend, R) =/= undefined].

%% @doc The backend `Modality' would dial first. Never fails: worst case, placeholder.
-spec resolve(modality(), apr_config:config()) -> apr_backends:backend().
resolve(Modality, Config) ->
    hd(candidates(Modality, Config)).

%% @doc The `/doctor' body for the live environment.
-spec doctor() -> {obj, [{binary(), term()}]}.
doctor() -> doctor(apr_config:from_env()).

%% @doc The resolved ladder per modality, plus how it was configured. Dials nothing.
-spec doctor(apr_config:config()) -> {obj, [{binary(), term()}]}.
doctor(Config) ->
    {obj, [{<<"identity">>, apr:identity()},
           {<<"version">>, apr:version()},
           {<<"modalities">>,
            {obj, [modality_doctor(Modality, Config) || Modality <- apr_ladder:modalities()]}},
           {<<"ladders">>, apr_ladder:resolve_all(apr_config:ladder_env(Config))},
           {<<"config">>, apr_config:describe(Config)}]}.

modality_doctor(Modality, Config) ->
    {Resolutions, Error} = resolutions(Modality, Config),
    Ladder = [atom_to_binary(maps:get(tier, R), utf8) || R <- Resolutions],
    Tiers = [apr_backends:resolution_describe(R) || R <- Resolutions],
    ResolvesTo = apr_backends:backend_describe(resolve(Modality, Config)),
    Base = [{<<"ladder">>, Ladder}, {<<"tiers">>, Tiers}, {<<"resolves_to">>, ResolvesTo}],
    Entry = case Error of
                undefined -> Base;
                _ -> Base ++ [{<<"error">>, Error}]
            end,
    {atom_to_binary(Modality, utf8), {obj, Entry}}.

%% @doc `completion.tier' — the tier that ultimately served the request.
-spec completion_tier(completion()) -> atom().
completion_tier(#{backend := Backend}) -> maps:get(tier, Backend).

%% @doc Dispatch `Payload' down `Modality''s ladder. Always completes.
-spec complete(modality(), map()) -> completion().
complete(Modality, Payload) -> complete(Modality, Payload, #{}).

%% @doc As {@link complete/2}, with options: `transport' (injected dialer), `budget_units'
%% (spend ceiling, honoured from US-3) and `call_timeout' (per-rung deadline).
-spec complete(modality(), map(), map()) -> completion().
complete(Modality, Payload, Options) ->
    case lists:member(Modality, apr_ladder:modalities()) of
        false -> throw({unknown_modality, Modality});
        true -> ok
    end,
    Config = apr_config:from_env(),
    {Tiers, _Error} = apr_ladder:safe_resolve(Modality, apr_config:ladder_env(Config)),
    Context = #{ceiling => maps:get(budget_units, Options, undefined),
                transport => maps:get(transport, Options, default_transport()),
                timeout => maps:get(call_timeout, Options, ?DEFAULT_CALL_TIMEOUT)},
    walk(Modality, Tiers ++ [placeholder], Payload, Context, []).

walk(Modality, [Tier | Rest], Payload, Context, Attempts) ->
    case dispatch(Modality, Tier, Payload, Context) of
        {ok, Response, Backend, Attempt} ->
            #{modality => Modality, backend => Backend, response => Response,
              attempts => lists:reverse([Attempt | Attempts])};
        {_Skipped, Attempt} ->
            walk(Modality, Rest, Payload, Context, [Attempt | Attempts])
    end;
walk(_Modality, [], _Payload, _Context, _Attempts) ->
    %% Unreachable: the ladder always ends with the ready placeholder worker.
    error(placeholder_tier_missing).

dispatch(Modality, Tier, Payload, Context) ->
    #{ceiling := Ceiling, transport := Transport, timeout := Timeout} = Context,
    Worker = worker_name(Modality, Tier),
    try
        gen_server:call(Worker, {serve, Payload, Ceiling, Transport}, Timeout)
    catch
        exit:{timeout, _} ->
            {failed, crash_attempt(Tier, <<"timeout">>)};
        exit:Reason ->
            {failed, crash_attempt(Tier, reason_binary(Reason))}
    end.

worker_name(Modality, placeholder) -> apr_placeholder_worker:name(Modality);
worker_name(Modality, Tier) -> apr_rung_worker:name(Modality, Tier).

crash_attempt(Tier, Reason) ->
    #{tier => Tier, provider => <<"-">>, ok => false, dialed => true, reason => Reason}.

reason_binary(Reason) ->
    unicode:characters_to_binary(io_lib:format("~p", [Reason])).

%% The default transport is intentionally inert: the OpenAI-wire HTTP dial (and the
%% native-wire translator path, agora:80 US-5) is wired in a later story. Until then a
%% configured-but-undialable rung falls through exactly as an unreachable one would, so
%% always-completes holds. Tests inject their own transport.
default_transport() ->
    fun(_Backend, _Payload) -> {error, <<"no live transport configured">>} end.
