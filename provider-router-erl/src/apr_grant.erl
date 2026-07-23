%%% @doc Capability grants — `koine/specs/capability-bus.md' §5.
%%%
%%% "Invocation requires a capability token naming the granted verb + scope —
%%% `invoke:compose', `subscribe:world/consensus-reality', `fetch:asset'. Grants are
%%% per-capability, per-world, and carry a spend ceiling (`budget_units')."
%%%
%%% This module fixes only the *shape* the spec fixes: parsing a grant, deciding whether it
%%% covers a (verb, scope) pair, and reading its ceiling. Issuance, rotation and identity
%%% providers live in the hosting org's infra (§5) — the router is a relying party, never an
%%% issuer, so it accepts a presented grant at face value and enforces what the grant says.
%%%
%%% Two deliberate choices:
%%%
%%% * **A missing grant is a refusal, not an unbounded permission.** `subscribe' with no grant
%%%   is `403', exactly as an unparseable `budget_units' ceiling is a `422' rather than "no
%%%   ceiling" ({@link apr_cost:parse_ceiling/1}). Both are the same rule: an authorization
%%%   input the caller failed to state can never widen what the caller may do.
%%% * **The ceiling is parsed by {@link apr_cost:parse_ceiling/1}**, so a grant's spend limit
%%%   and a request's spend limit are the same scalar, read the same way, clamped the same way.
%%%   A cross-project chain (§5) is only bounded if the two agree on what a unit is.
-module(apr_grant).

-export([parse/1, permits/3, required_scope/1, verb/1, scope/1, ceiling/1, token/1]).

-type grant() :: #{verb := binary(), scope := binary(), budget_units := float() | undefined}.

-export_type([grant/0]).

%% The verbs of §4. `discover' and `describe' are unauthenticated reads and never appear in a
%% grant the router checks, but they parse so an over-broad token is rejected as "not covering
%% this scope" rather than as a syntax error the caller cannot act on.
-define(VERBS, [<<"subscribe">>, <<"fetch">>, <<"invoke">>, <<"discover">>, <<"describe">>]).

%% @doc Parse a presented grant: a token binary (`<<"subscribe:world/x">>') or an object
%% carrying `scope' (optionally split into `verb' + `scope') and an optional `budget_units'.
%%
%% The error carries the HTTP status the surface should answer with: a grant that is absent or
%% too narrow is `403' (the caller is not authorized), a grant that is malformed is `422' (the
%% caller sent something unreadable).
-spec parse(term()) -> {ok, grant()} | {error, 403 | 422, binary()}.
parse(undefined) -> {error, 403, missing_message()};
parse(null) -> {error, 403, missing_message()};
parse(<<>>) -> {error, 403, missing_message()};
parse(Token) when is_binary(Token) ->
    from_token(Token, undefined);
parse(Object) when is_map(Object); is_tuple(Object) ->
    case grant_token(Object) of
        undefined ->
            {error, 422, <<"a grant must carry a \"scope\" like \"subscribe:world/<world>\"">>};
        Token ->
            try apr_cost:parse_ceiling(apr_json:get(<<"budget_units">>, Object)) of
                Ceiling -> from_token(Token, Ceiling)
            catch
                throw:{ceiling_error, Message} -> {error, 422, Message}
            end
    end;
parse(_Other) ->
    {error, 422, <<"a grant must be a capability token or an object">>}.

%% `{"scope": "subscribe:world/x"}' and `{"verb": "subscribe", "scope": "world/x"}' are the
%% same grant spelled two ways — the bus accepts both so a caller need not know which half of
%% the token the router splits on.
grant_token(Object) ->
    case apr_json:get(<<"scope">>, Object) of
        Scope when is_binary(Scope), Scope =/= <<>> ->
            case apr_json:get(<<"verb">>, Object) of
                Verb when is_binary(Verb), Verb =/= <<>> -> <<Verb/binary, ":", Scope/binary>>;
                _ -> Scope
            end;
        _ -> undefined
    end.

from_token(Token, Ceiling) ->
    case binary:split(Token, <<":">>) of
        [Verb, Scope] when Scope =/= <<>> ->
            case lists:member(Verb, ?VERBS) of
                true -> {ok, #{verb => Verb, scope => Scope, budget_units => Ceiling}};
                false -> {error, 422, <<"unknown grant verb \"", Verb/binary, "\"">>}
            end;
        _ ->
            {error, 422, <<"a grant token is \"<verb>:<scope>\", not \"", Token/binary, "\"">>}
    end.

missing_message() ->
    <<"a capability grant is required (capability-bus.md §5)"/utf8>>.

%% @doc Whether `Grant' covers `Verb' on `Scope'.
%%
%% A granted scope of `*' covers everything and one ending `/*' covers its subtree — the same
%% `world_pattern' spelling the manifest publishes for a world-agnostic producer (delta J), so
%% "subscribe to every world" is expressible without enumerating worlds.
-spec permits(grant(), binary(), binary()) -> boolean().
permits(#{verb := Granted, scope := Scope}, Verb, Wanted) ->
    Granted =:= Verb andalso scope_matches(Scope, Wanted).

scope_matches(<<"*">>, _Wanted) -> true;
scope_matches(Scope, Wanted) ->
    Size = byte_size(Scope),
    case Size >= 2 andalso binary:part(Scope, Size - 2, 2) =:= <<"/*">> of
        true ->
            Prefix = binary:part(Scope, 0, Size - 1),
            binary:longest_common_prefix([Prefix, Wanted]) =:= byte_size(Prefix);
        false ->
            Scope =:= Wanted
    end.

%% @doc The scope a subscription to `Topic' needs granting for: a world topic keeps its
%% `world/<world>' spelling (§5's own example), a capability topic reduces to the capability
%% name (`subscribe:generate.image'), matching how `invoke' grants are spelled in the manifest.
-spec required_scope(binary()) -> binary().
required_scope(<<"world/", _Rest/binary>> = Topic) -> Topic;
required_scope(<<"capability/", Name/binary>>) -> Name;
required_scope(Topic) -> Topic.

-spec verb(grant()) -> binary().
verb(#{verb := Verb}) -> Verb.

-spec scope(grant()) -> binary().
scope(#{scope := Scope}) -> Scope.

%% @doc The grant's spend ceiling in budget units, or `undefined' for an unbounded grant.
-spec ceiling(grant()) -> float() | undefined.
ceiling(#{budget_units := Ceiling}) -> Ceiling.

%% @doc The grant back in its token spelling — what a log line or a refusal quotes.
-spec token(grant()) -> binary().
token(#{verb := Verb, scope := Scope}) -> <<Verb/binary, ":", Scope/binary>>.
