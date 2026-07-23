%%% @doc eunit: the JSON codec's two contracts — ordered objects for relayed bodies, and
%%% number/string spellings identical to Python's `json.dumps'.
%%%
%%% The float cases are the ones that bite: Erlang's own `[short]' formatting picks the same
%%% shortest round-tripping digits as Python's `repr' but a different fixed-vs-exponential
%%% threshold, so `1000.0' spells as `1.0e3' unless it is re-rendered. Two bytes, and the
%%% manifest is no longer byte-identical.
-module(apr_json_tests).
-include_lib("eunit/include/eunit.hrl").

%% --- floats spell exactly as Python's repr ----------------------------------

floats_spell_as_python_repr_test() ->
    Cases = [{0.0, <<"0.0">>},
             {1.0, <<"1.0">>},
             {60.0, <<"60.0">>},
             {1000.0, <<"1000.0">>},
             {5000.0, <<"5000.0">>},
             {0.06, <<"0.06">>},
             {1.5, <<"1.5">>},
             {0.001, <<"0.001">>},
             {0.0001, <<"0.0001">>},
             {61.44, <<"61.44">>},
             {1.0e16, <<"1e+16">>},
             {1.0e-5, <<"1e-05">>},
             {1.5e20, <<"1.5e+20">>},
             {-0.5, <<"-0.5">>},
             {-1000.0, <<"-1000.0">>}],
    lists:foreach(fun({Float, Expected}) -> ?assertEqual(Expected, apr_json:encode(Float)) end,
                  Cases).

integers_stay_integers_test() ->
    ?assertEqual(<<"0">>, apr_json:encode(0)),
    ?assertEqual(<<"1000">>, apr_json:encode(1000)).

%% --- objects keep their order -----------------------------------------------

an_object_encodes_in_insertion_order_test() ->
    ?assertEqual(<<"{\"b\":1,\"a\":2}">>,
                 apr_json:encode({obj, [{<<"b">>, 1}, {<<"a">>, 2}]})).

a_bare_map_encodes_sorted_test() ->
    %% A map has no order of its own, so it takes the canonical one.
    ?assertEqual(<<"{\"a\":2,\"b\":1}">>, apr_json:encode(#{<<"b">> => 1, <<"a">> => 2})).

canonical_sorts_recursively_test() ->
    Nested = {obj, [{<<"b">>, {obj, [{<<"z">>, 1}, {<<"y">>, 2}]}}, {<<"a">>, [3]}]},
    ?assertEqual(<<"{\"a\":[3],\"b\":{\"y\":2,\"z\":1}}">>,
                 apr_json:encode(apr_json:canonical(Nested))).

%% --- decoding ---------------------------------------------------------------

decoding_preserves_wire_order_test() ->
    {ok, Decoded} = apr_json:decode(<<"{\"z\":1,\"a\":2}">>),
    ?assertEqual([<<"z">>, <<"a">>], apr_json:keys(Decoded)).

a_body_round_trips_byte_for_byte_test() ->
    %% What relaying an upstream response depends on.
    Wire = <<"{\"id\":\"x\",\"choices\":[{\"index\":0}],\"usage\":{\"total_tokens\":0}}">>,
    {ok, Decoded} = apr_json:decode(Wire),
    ?assertEqual(Wire, apr_json:encode(Decoded)).

numbers_keep_their_python_type_test() ->
    {ok, Decoded} = apr_json:decode(<<"{\"i\":1,\"f\":1.0,\"e\":1e3,\"neg\":-2.5}">>),
    ?assertEqual(1, apr_json:get(<<"i">>, Decoded)),
    ?assertEqual(1.0, apr_json:get(<<"f">>, Decoded)),
    ?assertEqual(1000.0, apr_json:get(<<"e">>, Decoded)),
    ?assertEqual(-2.5, apr_json:get(<<"neg">>, Decoded)).

literals_and_strings_decode_test() ->
    {ok, Decoded} = apr_json:decode(
                      <<"{\"t\":true,\"f\":false,\"n\":null,\"s\":\"a\\\"b\\nc\"}">>),
    ?assertEqual(true, apr_json:get(<<"t">>, Decoded)),
    ?assertEqual(false, apr_json:get(<<"f">>, Decoded)),
    ?assertEqual(null, apr_json:get(<<"n">>, Decoded)),
    ?assertEqual(<<"a\"b\nc">>, apr_json:get(<<"s">>, Decoded)).

unicode_survives_the_round_trip_test() ->
    %% `ensure_ascii=False`: raw UTF-8 out, and a `\u` escape in decodes to the same bytes.
    {ok, Escaped} = apr_json:decode(<<"{\"s\":\"\\u00a7\"}">>),
    ?assertEqual(<<"§"/utf8>>, apr_json:get(<<"s">>, Escaped)),
    ?assertEqual(<<"{\"s\":\"§\"}"/utf8>>, apr_json:encode(Escaped)).

a_surrogate_pair_decodes_to_one_codepoint_test() ->
    {ok, Decoded} = apr_json:decode(<<"{\"s\":\"\\ud83d\\ude00\"}">>),
    ?assertEqual(<<128512/utf8>>, apr_json:get(<<"s">>, Decoded)).

malformed_json_is_an_error_not_a_crash_test() ->
    lists:foreach(fun(Bad) -> ?assertMatch({error, _}, apr_json:decode(Bad)) end,
                  [<<"{oops">>, <<"">>, <<"{\"a\":}">>, <<"[1,2">>, <<"{\"a\":1}trailing">>]).

%% --- accessors --------------------------------------------------------------

put_front_keeps_the_callers_value_test() ->
    %% Python's `{"model": M, **payload}`: the literal fixes the position, the spread wins
    %% the value.
    Payload = {obj, [{<<"messages">>, []}, {<<"model">>, <<"caller-choice">>}]},
    Result = apr_json:put_front(<<"model">>, <<"ladder-choice">>, Payload),
    ?assertEqual([<<"model">>, <<"messages">>], apr_json:keys(Result)),
    ?assertEqual(<<"caller-choice">>, apr_json:get(<<"model">>, Result)).

put_front_prepends_an_absent_key_test() ->
    Result = apr_json:put_front(<<"model">>, <<"m">>, {obj, [{<<"messages">>, []}]}),
    ?assertEqual([<<"model">>, <<"messages">>], apr_json:keys(Result)).

put_keeps_an_existing_keys_position_test() ->
    Result = apr_json:put(<<"a">>, 9, {obj, [{<<"a">>, 1}, {<<"b">>, 2}]}),
    ?assertEqual([<<"a">>, <<"b">>], apr_json:keys(Result)),
    ?assertEqual(9, apr_json:get(<<"a">>, Result)).

put_appends_a_new_key_test() ->
    Result = apr_json:put(<<"agora">>, 1, {obj, [{<<"id">>, <<"x">>}]}),
    ?assertEqual([<<"id">>, <<"agora">>], apr_json:keys(Result)).

%% --- values spell as Python's repr, for the messages that quote them --------

python_repr_spells_the_json_scalars_test() ->
    %% An unreadable `budget_units' answers 422 quoting the value it refused, and `cost.py'
    %% builds that message from a Python `repr'. The spelling is response bytes.
    Cases = [{null, <<"None">>},
             {true, <<"True">>},
             {false, <<"False">>},
             {0, <<"0">>},
             {-5, <<"-5">>},
             {1000.0, <<"1000.0">>},
             {<<"abc">>, <<"'abc'">>},
             {<<>>, <<"''">>}],
    lists:foreach(fun({Value, Expected}) ->
                          ?assertEqual(Expected, apr_json:python_repr(Value))
                  end, Cases).

python_repr_quotes_the_way_python_quotes_test() ->
    %% Python reaches for `"' only to avoid escaping a lone `''.
    ?assertEqual(<<"\"it's\"">>, apr_json:python_repr(<<"it's">>)),
    ?assertEqual(<<"'say \"hi\"'">>, apr_json:python_repr(<<"say \"hi\"">>)),
    ?assertEqual(<<"'it\\'s \"both\"'">>, apr_json:python_repr(<<"it's \"both\"">>)),
    ?assertEqual(<<"'a\\nb'">>, apr_json:python_repr(<<"a\nb">>)),
    ?assertEqual(<<"'\\x00'">>, apr_json:python_repr(<<0>>)).

python_repr_spells_containers_test() ->
    ?assertEqual(<<"[1, 'a', None]">>, apr_json:python_repr([1, <<"a">>, null])),
    ?assertEqual(<<"{'k': 1}">>, apr_json:python_repr({obj, [{<<"k">>, 1}]})),
    ?assertEqual(<<"[]">>, apr_json:python_repr([])).
