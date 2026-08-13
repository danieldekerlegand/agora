%%% @doc eunit: the migrated agora:50 cost table, the two safety rules and the `budget_units'
%%% denomination, ported from `provider-router/tests/test_cost.py'.
%%%
%%% All pure — no env, no network, no supervision tree. The ceiling's behaviour *on the
%%% ladder* (a rung refused without being dialed) is the ct suite `apr_budget_SUITE'.
-module(apr_cost_tests).
-include_lib("eunit/include/eunit.hrl").

-define(NO_ENV, #{}).

%% --- the table --------------------------------------------------------------

unit_of_names_what_a_rate_is_charged_against_test() ->
    ?assertEqual(<<"token">>, apr_cost:unit_of(text)),
    ?assertEqual(<<"image">>, apr_cost:unit_of(image)),
    ?assertEqual(<<"character">>, apr_cost:unit_of(speech)),
    ?assertEqual(<<"generation">>, apr_cost:unit_of(music)),
    ?assertEqual(<<"second">>, apr_cost:unit_of(video)).

the_shipped_rates_are_the_python_sheet_test() ->
    ?assertEqual({0.06, false}, apr_cost:rate_for(text, <<"openai">>, ?NO_ENV)),
    ?assertEqual({1.5, false}, apr_cost:rate_for(text, <<"anthropic">>, ?NO_ENV)),
    ?assertEqual({0.03, false}, apr_cost:rate_for(text, <<"gemini">>, ?NO_ENV)),
    ?assertEqual({8000.0, false}, apr_cost:rate_for(image, <<"openai">>, ?NO_ENV)),
    ?assertEqual({30.0, false}, apr_cost:rate_for(speech, <<"elevenlabs">>, ?NO_ENV)),
    ?assertEqual({5000.0, false}, apr_cost:rate_for(music, <<"replicate">>, ?NO_ENV)),
    ?assertEqual({4300.0, false}, apr_cost:rate_for(video, <<"minimax">>, ?NO_ENV)).

the_zero_spend_tiers_are_free_not_unpriced_test() ->
    lists:foreach(
      fun(Provider) ->
              ?assertEqual({0.0, false}, apr_cost:rate_for(text, Provider, ?NO_ENV))
      end, [<<"mlx-serve">>, <<"ollama">>, <<"placeholder">>]),
    ?assertEqual([<<"mlx-serve">>, <<"ollama">>, <<"placeholder">>],
                 apr_cost:free_providers()).

an_unknown_provider_is_unpriced_not_free_test() ->
    %% The distinction the whole ceiling rests on: "we don't know" must never read as "free".
    ?assertEqual({0.0, true}, apr_cost:rate_for(text, <<"some-new-vendor">>, ?NO_ENV)).

%% --- the per-rate override --------------------------------------------------

price_env_var_uses_the_python_spelling_test() ->
    ?assertEqual("AGORA_PRICE_VIDEO_RUNWAY", apr_cost:price_env_var(video, <<"runway">>)),
    %% Non-alphanumerics become `_`, so a dashed provider name is still a legal var name.
    ?assertEqual("AGORA_PRICE_TEXT_MLX_SERVE", apr_cost:price_env_var(text, <<"mlx-serve">>)).

an_override_wins_over_the_table_test() ->
    Env = #{"AGORA_PRICE_TEXT_OPENAI" => "0.5"},
    ?assertEqual({0.5, false}, apr_cost:rate_for(text, <<"openai">>, Env)).

an_override_can_price_an_unknown_provider_test() ->
    Env = #{"AGORA_PRICE_TEXT_SOME_NEW_VENDOR" => "2"},
    ?assertEqual({2.0, false}, apr_cost:rate_for(text, <<"some-new-vendor">>, Env)).

an_override_can_price_a_free_provider_test() ->
    %% A user pricing their own electricity beats the FREE_PROVIDERS shortcut.
    Env = #{"AGORA_PRICE_TEXT_OLLAMA" => "0.01"},
    ?assertEqual({0.01, false}, apr_cost:rate_for(text, <<"ollama">>, Env)).

a_malformed_override_leaves_the_table_rate_standing_test() ->
    lists:foreach(
      fun(Raw) ->
              Env = #{"AGORA_PRICE_TEXT_OPENAI" => Raw},
              ?assertEqual({0.06, false}, apr_cost:rate_for(text, <<"openai">>, Env))
      end, ["lots", "-1", "   ", ""]).

%% --- measurement ------------------------------------------------------------

text_measures_prompt_plus_completion_test() ->
    Payload = {obj, [{<<"messages">>, [{obj, [{<<"role">>, <<"user">>},
                                              {<<"content">>, <<"1234567">>}]}]},
                     {<<"max_tokens">>, 100}]},
    %% 7 chars / 3.5 = 2 tokens of prompt, plus the stated 100 completion tokens.
    ?assertEqual(102.0, apr_cost:measure(text, Payload)).

text_errs_high_when_no_size_is_stated_test() ->
    ?assertEqual(1024.0, apr_cost:measure(text, {obj, []})).

speech_measures_characters_test() ->
    ?assertEqual(5.0, apr_cost:measure(speech, {obj, [{<<"input">>, <<"hello">>}]})),
    ?assertEqual(3.0, apr_cost:measure(speech, {obj, [{<<"text">>, <<"abc">>}]})),
    ?assertEqual(200.0, apr_cost:measure(speech, {obj, []})).

image_and_music_measure_the_count_test() ->
    ?assertEqual(3.0, apr_cost:measure(image, {obj, [{<<"n">>, 3}]})),
    ?assertEqual(1.0, apr_cost:measure(image, {obj, []})),
    %% A zero count is one generation, not a free one.
    ?assertEqual(1.0, apr_cost:measure(music, {obj, [{<<"n">>, 0}]})).

video_measures_seconds_times_count_test() ->
    ?assertEqual(10.0, apr_cost:measure(video, {obj, [{<<"duration">>, 5}, {<<"n">>, 2}]})),
    ?assertEqual(5.0, apr_cost:measure(video, {obj, []})).

a_map_payload_measures_the_same_as_a_decoded_one_test() ->
    %% The accessors read either representation, so a test fixture and a wire body agree.
    ?assertEqual(apr_cost:measure(speech, {obj, [{<<"input">>, <<"hello">>}]}),
                 apr_cost:measure(speech, #{<<"input">> => <<"hello">>})).

%% --- projection and settlement ----------------------------------------------

projection_is_rate_times_quantity_test() ->
    Cost = apr_cost:project(text, <<"openai">>, {obj, [{<<"max_tokens">>, 1000}]}, ?NO_ENV),
    ?assertEqual(60.0, maps:get(units, Cost)),
    ?assertEqual(1000.0, maps:get(quantity, Cost)),
    ?assertEqual(<<"token">>, maps:get(unit, Cost)),
    ?assertEqual(false, maps:get(unpriced, Cost)),
    ?assertEqual(true, maps:get(estimate, Cost)).

the_placeholder_projects_to_nothing_test() ->
    Cost = apr_cost:project(video, <<"placeholder">>, {obj, [{<<"duration">>, 30}]}, ?NO_ENV),
    ?assertEqual(0.0, maps:get(units, Cost)),
    ?assertEqual(false, maps:get(unpriced, Cost)).

settling_reads_the_quantity_off_the_response_test() ->
    Response = {obj, [{<<"usage">>, {obj, [{<<"total_tokens">>, 42}]}}]},
    Cost = apr_cost:settle(text, <<"openai">>, {obj, [{<<"max_tokens">>, 1000}]},
                           Response, ?NO_ENV),
    ?assertEqual(42.0, maps:get(quantity, Cost)),
    %% Measured, not guessed.
    ?assertEqual(false, maps:get(estimate, Cost)).

settling_falls_back_to_the_projection_test() ->
    Cost = apr_cost:settle(text, <<"openai">>, {obj, [{<<"max_tokens">>, 1000}]},
                           {obj, []}, ?NO_ENV),
    ?assertEqual(1000.0, maps:get(quantity, Cost)),
    ?assertEqual(true, maps:get(estimate, Cost)).

the_placeholder_settles_as_a_measured_zero_test() ->
    Response = apr_placeholder:complete(text, {obj, []}, <<"placeholder-text">>),
    Cost = apr_cost:settle(text, <<"placeholder">>, {obj, []}, Response, ?NO_ENV),
    ?assertEqual(0.0, maps:get(units, Cost)),
    ?assertEqual(0.0, maps:get(quantity, Cost)),
    ?assertEqual(false, maps:get(estimate, Cost)).

%% --- safety rule 1: an unpriceable rung never passes a ceiling ---------------

no_ceiling_means_no_constraint_test() ->
    Expensive = apr_cost:project(image, <<"openai">>, {obj, [{<<"n">>, 100}]}, ?NO_ENV),
    ?assert(apr_cost:within(Expensive, undefined)),
    %% Even the unpriced rung is allowed when nobody stated a ceiling.
    Unknown = apr_cost:project(text, <<"some-new-vendor">>, {obj, []}, ?NO_ENV),
    ?assert(apr_cost:within(Unknown, undefined)).

an_unpriced_rung_is_refused_under_any_ceiling_test() ->
    Unknown = apr_cost:project(text, <<"some-new-vendor">>, {obj, []}, ?NO_ENV),
    ?assertEqual(0.0, maps:get(units, Unknown)),
    %% Zero units and still refused: the flag, not the total, is what `within` reads.
    ?assertNot(apr_cost:within(Unknown, 0.0)),
    ?assertNot(apr_cost:within(Unknown, 1000000.0)).

a_priced_rung_is_allowed_up_to_the_ceiling_test() ->
    Cost = apr_cost:project(text, <<"openai">>, {obj, [{<<"max_tokens">>, 1000}]}, ?NO_ENV),
    ?assert(apr_cost:within(Cost, 60.0)),
    ?assertNot(apr_cost:within(Cost, 59.9)).

the_refusal_says_which_rule_refused_it_test() ->
    Unknown = apr_cost:project(text, <<"some-new-vendor">>, {obj, []}, ?NO_ENV),
    Unpriced = apr_cost:refusal(Unknown, 5.0, text, <<"some-new-vendor">>),
    ?assertMatch({_, _}, binary:match(Unpriced, <<"no published text rate">>)),
    Priced = apr_cost:project(text, <<"openai">>, {obj, [{<<"max_tokens">>, 1000}]}, ?NO_ENV),
    Over = apr_cost:refusal(Priced, 5.0, text, <<"openai">>),
    ?assertMatch({_, _}, binary:match(Over, <<"projected 60 budget units">>)),
    ?assertMatch({_, _}, binary:match(Over, <<"exceeds the 5-unit ceiling">>)).

%% --- safety rule 2: a ceiling only ever fails safe ---------------------------

a_ceiling_reads_numbers_and_numeric_strings_test() ->
    ?assertEqual(5.0, apr_cost:parse_ceiling(5)),
    ?assertEqual(5.5, apr_cost:parse_ceiling(5.5)),
    ?assertEqual(0.0, apr_cost:parse_ceiling(0)),
    ?assertEqual(2.5, apr_cost:parse_ceiling(<<"2.5">>)),
    ?assertEqual(undefined, apr_cost:parse_ceiling(null)),
    ?assertEqual(undefined, apr_cost:parse_ceiling(undefined)).

a_negative_ceiling_clamps_to_zero_test() ->
    %% A below-zero budget is a zero budget, not an unlimited one.
    ?assertEqual(0.0, apr_cost:parse_ceiling(-5)),
    ?assertEqual(0.0, apr_cost:parse_ceiling(<<"-5">>)).

junk_is_an_error_not_an_absent_ceiling_test() ->
    %% Silently dropping it would turn a typo into unlimited spend authority.
    lists:foreach(
      fun(Raw) ->
              ?assertThrow({ceiling_error, _}, apr_cost:parse_ceiling(Raw))
      end, [<<"lots">>, true, false, {obj, []}, [1, 2]]).

taking_the_ceiling_strips_it_from_the_payload_test() ->
    Payload = {obj, [{<<"messages">>, []}, {<<"budget_units">>, 0}]},
    {Body, Ceiling} = apr_cost:take_ceiling(Payload),
    ?assertEqual(0.0, Ceiling),
    %% Never forwarded upstream: it is an agora extension a provider would reject.
    ?assertEqual([<<"messages">>], apr_json:keys(Body)).

taking_an_absent_ceiling_leaves_the_payload_alone_test() ->
    Payload = {obj, [{<<"messages">>, []}]},
    ?assertEqual({Payload, undefined}, apr_cost:take_ceiling(Payload)).

%% --- the denomination: the cost model's, never a rate source's ---------------

the_dollar_anchor_is_stated_both_ways_round_test() ->
    %% One number, two spellings — the sheet documents `1 unit = US$0.00001', a conversion
    %% needs its reciprocal, and a drift between them would silently reprice every ceiling.
    Product = apr_cost:unit_anchor_usd() * apr_cost:budget_units_per_usd(),
    ?assert(abs(Product - 1.0) < 1.0e-9).

a_dollar_rate_becomes_budget_units_here_test() ->
    %% `$0.05/second of video = 5000 units/second' — the worked example the module doc and
    %% `prices.toml' are both written around, and the rate the shipped table already carries.
    ?assertEqual(5000.0, apr_cost:from_usd(0.05)),
    ?assertEqual(maps:get(<<"runway">>, apr_cost:rates(video)), apr_cost:from_usd(0.05)),
    %% $2 per million output tokens, the shape a per-model source answers in.
    ?assertEqual(0.2, apr_cost:from_usd(2.0e-6)),
    %% Rounded the nine places Python rounds a converted rate to, not left at 5000.000000000001.
    ?assertEqual("5000", apr_cost:fmt_g(apr_cost:from_usd(0.05))).

zero_dollars_is_zero_units_and_nothing_else_test() ->
    %% The conversion prices what it is handed. It is never how a *missing* rate is answered:
    %% that stays a fall-through, and ends at `unpriced' rather than at a free rung.
    ?assertEqual(0.0, apr_cost:from_usd(0)),
    ?assertEqual(0.0, apr_cost:from_usd(0.0)),
    ?assertEqual({0.0, true}, apr_cost:rate_for(text, <<"some-new-vendor">>, ?NO_ENV)).

%% --- the `g` number spelling ------------------------------------------------

fmt_g_matches_pythons_g_format_test() ->
    ?assertEqual("0", apr_cost:fmt_g(0.0)),
    ?assertEqual("60", apr_cost:fmt_g(60.0)),
    ?assertEqual("0.06", apr_cost:fmt_g(0.06)),
    ?assertEqual("5000", apr_cost:fmt_g(5000.0)),
    ?assertEqual("2.5", apr_cost:fmt_g(2.5)),
    ?assertEqual("0", apr_cost:fmt_g(0)).
