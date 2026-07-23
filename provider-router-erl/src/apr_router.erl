%%% @doc The router: walk the ladder, dispatch to the first rung that answers, always
%%% complete. The Erlang mirror of `router.py', re-expressed over the supervision tree.
%%%
%%% **Resolution** ({@link resolutions/2}, {@link candidates/2}, {@link doctor/1}) is a pure
%%% question of configuration — computed directly from {@link apr_backends}, dialing nothing,
%%% exactly as `router.py' computes its resolutions before it dispatches.
%%%
%%% **Dispatch** ({@link complete/2}) is a walk *across the rung workers*: for each tier in
%%% ladder order (placeholder last) it issues a monitored `gen_server:call' to that modality's
%%% worker. A rung that is unconfigured, over budget, times out, crashes or errors is recorded
%%% as an attempt and the walk moves to the next child; the placeholder worker is terminal,
%%% offline and free, so the walk always terminates in a response. A worker crash surfaces as
%%% a caught exit here — never as a failed request.
%%%
%%% **The budget** (KCB §5). A request may carry a `budget_units' ceiling, in the body or —
%%% for a stock OpenAI client that cannot add body keys — the `X-Agora-Budget-Units' header,
%%% the body winning. The ladder order is a *preference* and the ceiling is a *constraint*:
%%% each rung is priced before it is dialed and one projected over budget is refused without
%%% being contacted, so the first surviving rung is the best one the caller can afford. A
%%% ceiling of `0' therefore cannot spend at all. The only error {@link complete/3} raises is
%%% for a malformed *request* (an unknown modality, an unreadable ceiling) — a caller bug
%%% rather than a state to fall down from.
-module(apr_router).

-export([resolutions/2, resolve/2, candidates/2, doctor/0, doctor/1,
         complete/2, complete/3, completion_tier/1, routing/1, response/1]).

-type modality() :: atom().
-type completion() :: #{modality := modality(), backend := apr_backends:backend(),
                       response := term(), attempts := [map()],
                       projected := apr_cost:cost(), actual := apr_cost:cost(),
                       budget_units := float() | undefined}.

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
-spec doctor() -> apr_json:object().
doctor() -> doctor(apr_config:from_env()).

%% @doc The resolved ladder per modality, plus how it was configured. Dials nothing.
-spec doctor(apr_config:config()) -> apr_json:object().
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

%% @doc The upstream response body, as it will be relayed to the caller.
-spec response(completion()) -> term().
response(#{response := Response}) -> Response.

%% @doc Dispatch `Payload' down `Modality''s ladder. Always completes.
-spec complete(modality(), term()) -> completion().
complete(Modality, Payload) -> complete(Modality, Payload, #{}).

%% @doc As {@link complete/2}, with options: `transport' (injected dialer), `budget_units'
%% (the header-borne spend ceiling, which the body's key overrides) and `call_timeout' (the
%% per-rung deadline).
-spec complete(modality(), term(), map()) -> completion().
complete(Modality, Payload0, Options) ->
    case lists:member(Modality, apr_ladder:modalities()) of
        false -> throw({unknown_modality, Modality});
        true -> ok
    end,
    Config = apr_config:from_env(),
    Env = apr_config:ladder_env(Config),
    %% Split the ceiling off the body BEFORE anything reads the payload: it is an agora
    %% extension an upstream provider would reject, and the placeholder's digest must be
    %% taken over the request as forwarded, not as received.
    {Payload, BodyCeiling} = apr_cost:take_ceiling(Payload0),
    Ceiling = case BodyCeiling of
                  undefined -> maps:get(budget_units, Options, undefined);
                  _ -> BodyCeiling
              end,
    {Tiers, _Error} = apr_ladder:safe_resolve(Modality, Env),
    Context = #{ceiling => Ceiling,
                transport => maps:get(transport, Options, default_transport()),
                timeout => maps:get(call_timeout, Options, ?DEFAULT_CALL_TIMEOUT)},
    Walked = walk(Modality, Tiers ++ [placeholder], Payload, Context, []),
    settled(Walked, Payload, Ceiling, Env).

%% Price what was actually served: projected (what the winning rung was expected to cost) and
%% actual (what the response says it did). Both are pure functions of the winning provider, so
%% they are computed here rather than threaded back out of the worker.
settled(#{modality := Modality, backend := Backend, response := Response} = Walked,
        Payload, Ceiling, Env) ->
    Provider = maps:get(provider, Backend),
    Walked#{projected => apr_cost:project(Modality, Provider, Payload, Env),
            actual => apr_cost:settle(Modality, Provider, Payload, Response, Env),
            budget_units => Ceiling}.

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

%% --- the routing report -----------------------------------------------------

%% @doc The out-of-band routing report attached to every response — the body's `agora' key,
%% byte-compatible with `router.py::Completion.routing'.
-spec routing(completion()) -> apr_json:object().
routing(#{modality := Modality, backend := Backend, attempts := Attempts} = Completion) ->
    {obj, [{<<"modality">>, atom_to_binary(Modality, utf8)},
           {<<"tier">>, atom_to_binary(maps:get(tier, Backend), utf8)},
           {<<"provider">>, maps:get(provider, Backend)},
           {<<"model">>, maps:get(model, Backend)},
           {<<"attempts">>, [attempt_describe(A) || A <- Attempts]},
           {<<"cost">>, cost_report(Completion)}]}.

%% Projected vs actual spend, in KCB budget units (KCB §3: surface it to the caller).
cost_report(#{projected := Projected, actual := Actual, budget_units := Ceiling}) ->
    {obj, [{<<"currency">>, <<"budget_units">>},
           {<<"budget_units">>, nn(Ceiling)},
           {<<"projected_units">>, apr_cost:units(Projected)},
           {<<"actual_units">>, apr_cost:units(Actual)},
           {<<"projected">>, apr_cost:describe(Projected)},
           {<<"actual">>, apr_cost:describe(Actual)}]}.

%% `dialed' separates the two ways a rung can fail: it was contacted and did not answer, or it
%% was refused on price and never contacted at all. A budget audit needs to tell those apart —
%% only the first could have spent anything (`router.py::Attempt.describe').
attempt_describe(Attempt) ->
    Base = [{<<"tier">>, atom_to_binary(maps:get(tier, Attempt), utf8)},
            {<<"provider">>, maps:get(provider, Attempt)},
            {<<"ok">>, maps:get(ok, Attempt)},
            {<<"dialed">>, maps:get(dialed, Attempt)}],
    WithReason = case maps:get(reason, Attempt, undefined) of
                     undefined -> Base;
                     <<>> -> Base;
                     Reason -> Base ++ [{<<"reason">>, Reason}]
                 end,
    case maps:get(projected, Attempt, undefined) of
        undefined -> {obj, WithReason};
        Projected -> {obj, WithReason ++ [{<<"projected">>, apr_cost:describe(Projected)}]}
    end.

nn(undefined) -> null;
nn(Value) -> Value.

%% The default transport is intentionally inert: the OpenAI-wire HTTP dial (and the
%% native-wire translator path, agora:80 US-5) is wired in a later story. Until then a
%% configured-but-undialable rung falls through exactly as an unreachable one would, so
%% always-completes holds. Tests inject their own transport.
default_transport() ->
    fun(_Backend, _Payload) -> {error, <<"no live transport configured">>} end.
