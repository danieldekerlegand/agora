%%% @doc eunit: the sacred-ladder resolution, ported from `tests/test_ladder.py'.
%%%
%%% Pure over an explicit env map — no server, no process env. Pins the four behaviours the
%%% contract rests on: the default order, `AGORA_<MODALITY>_LADDER' overriding it,
%%% `AGORA_PREFER_LOCAL' fronting the zero-spend tiers, the `placeholder' token being inert,
%%% and a broken variable degrading to the default while surfacing its rejection.
-module(apr_ladder_tests).
-include_lib("eunit/include/eunit.hrl").

tiers(Env) -> element(1, apr_ladder:safe_resolve(text, Env)).

default_order_test() ->
    ?assertEqual([paid, mlx, local], tiers(#{})).

override_reorders_test() ->
    ?assertEqual([local, mlx], tiers(#{"AGORA_TEXT_LADDER" => "local,mlx"})).

override_dedups_keeping_first_position_test() ->
    ?assertEqual([mlx, paid], tiers(#{"AGORA_TEXT_LADDER" => "mlx,paid,mlx"})).

placeholder_token_is_inert_test() ->
    %% Naming the terminal tier is redundant, not a rejection — it is dropped.
    ?assertEqual([paid], tiers(#{"AGORA_TEXT_LADDER" => "paid,placeholder"})).

prefer_local_fronts_zero_spend_tiers_test() ->
    ?assertEqual([mlx, local, paid], tiers(#{"AGORA_PREFER_LOCAL" => "1"})).

prefer_local_applies_on_top_of_override_test() ->
    ?assertEqual([local, paid],
                 tiers(#{"AGORA_TEXT_LADDER" => "paid,local", "AGORA_PREFER_LOCAL" => "yes"})).

broken_variable_degrades_to_default_test() ->
    {Resolved, Error} = apr_ladder:safe_resolve(text, #{"AGORA_TEXT_LADDER" => "not-a-tier"}),
    ?assertEqual([paid, mlx, local], Resolved),
    ?assertNotEqual(nomatch, binary:match(Error, <<"not-a-tier">>)),
    ?assertNotEqual(nomatch, binary:match(Error, <<"AGORA_TEXT_LADDER">>)).

empty_variable_is_the_default_test() ->
    ?assertEqual([paid, mlx, local], tiers(#{"AGORA_TEXT_LADDER" => "  "})).

resolve_all_covers_every_modality_test() ->
    {obj, Entries} = apr_ladder:resolve_all(#{}),
    ?assertEqual(5, length(Entries)),
    Keys = [K || {K, _V} <- Entries],
    ?assertEqual([<<"text">>, <<"image">>, <<"speech">>, <<"music">>, <<"video">>], Keys).
