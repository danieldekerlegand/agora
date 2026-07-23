%%% @doc The sacred ladder — per-modality tier ordering, the Erlang mirror of `ladder.py'.
%%%
%%% Two things carry over verbatim in behaviour:
%%%
%%% * The order is **configuration, not hardcode**: `AGORA_<MODALITY>_LADDER' names a
%%%   comma-separated tier order and `AGORA_PREFER_LOCAL=1' fronts the zero-spend tiers.
%%% * The **placeholder is not a ladder token**. It is the unconditional terminal tier every
%%%   modality ends on (appended by {@link apr_router}), so a configured ladder can narrow
%%%   *which* backends are tried but can never break the always-completes contract.
%%%
%%% Tiers and modalities are atoms internally; the env-var spellings and the doctor report
%%% render them back as their lowercase strings. {@link safe_resolve/2} never raises for a
%%% known modality, so `/doctor' always answers.
-module(apr_ladder).

-export([modalities/0, tiers/0, placeholder/0, local_tiers/0,
         ladder_env_var/1, default_ladder/1,
         resolve_ladder/2, safe_resolve/2, resolve_all/1]).

-type modality() :: atom().
-type tier() :: paid | mlx | local.
-type env() :: #{string() => string()}.

%% @doc The modalities the router ladders (`ladder.py::MODALITIES').
-spec modalities() -> [modality()].
modalities() -> [text, image, speech, music, video].

%% @doc The configurable tier tokens, cheapest-last. `placeholder' is deliberately absent.
-spec tiers() -> [tier()].
tiers() -> [paid, mlx, local].

%% @doc The terminal tier. Always appended by the router, never configurable away.
-spec placeholder() -> placeholder.
placeholder() -> placeholder.

%% @doc The zero-spend tiers `AGORA_PREFER_LOCAL' moves to the front, in lead order.
-spec local_tiers() -> [tier()].
local_tiers() -> [mlx, local].

-spec prefer_local_env() -> string().
prefer_local_env() -> "AGORA_PREFER_LOCAL".

%% @doc modality -> the env var naming its ladder override (`ladder.py::LADDER_ENV').
-spec ladder_env_var(modality()) -> string().
ladder_env_var(Modality) ->
    "AGORA_" ++ string:uppercase(atom_to_list(Modality)) ++ "_LADDER".

%% @doc The default tier order for any modality (cloud-first, `ladder.py::DEFAULT_LADDERS').
-spec default_ladder(modality()) -> [tier()].
default_ladder(_Modality) -> tiers().

%% @doc The configured tier order for `Modality', WITHOUT the terminal placeholder.
%%
%% Throws `{ladder_error, Message}' on an unknown tier token — the message names the
%% offending variable and lists the valid tokens. Duplicates keep their first position;
%% `AGORA_PREFER_LOCAL' fronting applies on top of either order.
-spec resolve_ladder(modality(), env()) -> [tier()].
resolve_ladder(Modality, Env) ->
    true = lists:member(Modality, modalities()),
    Var = ladder_env_var(Modality),
    Raw = string:trim(env_get(Env, Var)),
    Tokens = string:split(Raw, ",", all),
    Collected = collect(Tokens, Modality, Var, []),
    Tiers = case Collected of
                [] -> default_ladder(Modality);
                _ -> Collected
            end,
    case truthy(env_get(Env, prefer_local_env())) of
        true -> front_local(Tiers);
        false -> Tiers
    end.

collect([], _Modality, _Var, Acc) ->
    lists:reverse(Acc);
collect([Token | Rest], Modality, Var, Acc) ->
    Name = string:lowercase(string:trim(Token)),
    case tier_atom(Name) of
        skip ->
            %% Empty or the redundant `placeholder' token — dropping it keeps the list honest.
            collect(Rest, Modality, Var, Acc);
        unknown ->
            throw({ladder_error, unknown_tier_message(Var, Modality, Name)});
        Tier ->
            case lists:member(Tier, Acc) of
                true -> collect(Rest, Modality, Var, Acc);
                false -> collect(Rest, Modality, Var, [Tier | Acc])
            end
    end.

tier_atom("") -> skip;
tier_atom("placeholder") -> skip;
tier_atom("paid") -> paid;
tier_atom("mlx") -> mlx;
tier_atom("local") -> local;
tier_atom(_) -> unknown.

front_local(Tiers) ->
    Local = [T || T <- local_tiers(), lists:member(T, Tiers)],
    Local ++ [T || T <- Tiers, not lists:member(T, Local)].

unknown_tier_message(Var, Modality, Name) ->
    unicode:characters_to_binary(
      [Var, ": unknown ", atom_to_list(Modality), " tier '", Name, "' ",
       [16#2014], " valid tiers: paid, mlx, local"]).

%% @doc `{Tiers, Error}' — never raises for a known modality.
%%
%% A bad ladder variable degrades to the default order (`AGORA_PREFER_LOCAL' still honoured)
%% and returns the rejection string, so the caller can warn loudly.
-spec safe_resolve(modality(), env()) -> {[tier()], binary() | undefined}.
safe_resolve(Modality, Env) ->
    try
        {resolve_ladder(Modality, Env), undefined}
    catch
        throw:{ladder_error, Message} ->
            Clean = #{prefer_local_env() => env_get(Env, prefer_local_env())},
            {resolve_ladder(Modality, Clean), Message}
    end.

%% @doc Every modality's configured ladder for the `/doctor' `ladders' block. Never raises.
%% Returns an ordered object so the JSON key order matches `ladder.py::resolve_all'.
-spec resolve_all(env()) -> {obj, [{binary(), term()}]}.
resolve_all(Env) ->
    {obj, [{atom_to_binary(Modality, utf8), ladder_entry(Modality, Env)}
           || Modality <- modalities()]}.

ladder_entry(Modality, Env) ->
    {Tiers, Error} = safe_resolve(Modality, Env),
    Var = ladder_env_var(Modality),
    Set = string:trim(env_get(Env, Var)) =/= "",
    Source = case Set andalso Error =:= undefined of
                 true -> <<"env">>;
                 false -> <<"default">>
             end,
    Tokens = [atom_to_binary(T, utf8) || T <- Tiers ++ [placeholder]],
    Base = [{<<"ladder">>, Tokens},
            {<<"source">>, Source},
            {<<"prefer_local">>, truthy(env_get(Env, prefer_local_env()))}],
    case Error of
        undefined -> {obj, Base};
        _ -> {obj, Base ++ [{<<"error">>, Error}]}
    end.

env_get(Env, Key) -> maps:get(Key, Env, "").

truthy(Value) ->
    lists:member(string:lowercase(string:trim(Value)), ["1", "true", "yes", "on"]).
