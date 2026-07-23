%%% @doc eunit: the translator binding as a *configuration* question — which vendors this
%%% node can dial, and what it does when it cannot dial any of them.
%%%
%%% Nothing here runs the port program. That is the point: whether a native-wire vendor is
%%% dialable has to be answerable while resolving a rung, with no process started and nothing
%%% contacted, or `/doctor' would be a dial. The end-to-end conversions live in
%%% `apr_translate_SUITE', which drives the real Rust binary.
-module(apr_translate_tests).
-include_lib("eunit/include/eunit.hrl").

-define(ANTHROPIC_KEY, "AGORA_PROVIDER_ANTHROPIC_API_KEY").

%% Any regular file will do to answer "is there a translator here": these cases ask what the
%% router RESOLVES, which happens before anything is executed.
stand_in_binary() -> code:which(?MODULE).

with_env(Vars, Body) ->
    Previous = [{Name, os:getenv(Name)} || {Name, _} <- Vars],
    lists:foreach(fun({Name, Value}) -> os:putenv(Name, Value) end, Vars),
    try Body()
    after
        lists:foreach(fun({Name, false}) -> os:unsetenv(Name);
                         ({Name, Value}) -> os:putenv(Name, Value)
                      end, Previous)
    end.

resolution() -> apr_backends:resolve_tier(paid, text, apr_config:from_env()).

%% --- which vendors need the translator at all -------------------------------

native_vendors_are_the_seven_pending_adapter_ones_test() ->
    ?assertEqual([<<"anthropic">>, <<"elevenlabs">>, <<"gemini">>, <<"luma">>, <<"minimax">>,
                  <<"replicate">>, <<"runway">>],
                 apr_backends:native_providers()).

%% Every native vendor the ladder can reach must serve the modality it is listed for —
%% otherwise it could never be more than `pending-adapter' no matter what the translator does.
every_listed_native_vendor_serves_its_modality_test() ->
    lists:foreach(
      fun(Modality) ->
              lists:foreach(
                fun(Name) ->
                        Vendor = maps:get(Name, apr_backends:paid_vendors()),
                        case maps:get(wire, Vendor) of
                            openai -> ok;
                            native ->
                                Model = maps:get(Modality, maps:get(models, Vendor), undefined),
                                ?assert(is_binary(Model))
                        end
                end, apr_backends:paid_providers(Modality))
      end, apr_ladder:modalities()).

%% --- the switch -------------------------------------------------------------

the_translator_can_be_switched_off_from_the_environment_test() ->
    lists:foreach(
      fun(Value) ->
              with_env([{"AGORA_TRANSLATOR", Value},
                        {"AGORA_TRANSLATOR_BIN", stand_in_binary()}],
                       fun() -> ?assertNot(apr_translate:enabled()) end)
      end, ["off", "OFF", "0", "false", "no", " off "]).

a_named_binary_that_is_not_there_is_no_translator_test() ->
    with_env([{"AGORA_TRANSLATOR", "on"},
              {"AGORA_TRANSLATOR_BIN", "/nonexistent/agora-translation-port"}],
             fun() ->
                     ?assertNot(apr_translate:enabled()),
                     ?assertEqual(undefined, apr_translate:executable())
             end).

a_named_binary_that_is_there_is_the_translator_test() ->
    Binary = stand_in_binary(),
    with_env([{"AGORA_TRANSLATOR", "on"}, {"AGORA_TRANSLATOR_BIN", Binary}],
             fun() ->
                     ?assert(apr_translate:enabled()),
                     ?assertEqual(Binary, apr_translate:executable())
             end).

%% --- what a rung resolution makes of it -------------------------------------

without_a_translator_a_native_vendor_stays_pending_adapter_test() ->
    with_env([{"AGORA_TRANSLATOR", "off"}, {?ANTHROPIC_KEY, "sk-ant-test"}],
             fun() ->
                     Resolved = resolution(),
                     ?assertEqual('pending-adapter', maps:get(status, Resolved)),
                     ?assertEqual(undefined, maps:get(backend, Resolved)),
                     %% The wording is `backends.py''s, unchanged: an unbuilt translator and
                     %% an unwritten adapter are the same fact to a caller.
                     Reason = maps:get(reason, Resolved),
                     ?assertNotEqual(nomatch, binary:match(Reason, <<"anthropic">>)),
                     ?assertNotEqual(nomatch, binary:match(Reason, <<"adapter">>))
             end).

with_a_translator_a_native_vendor_becomes_ready_test() ->
    with_env([{"AGORA_TRANSLATOR", "on"}, {"AGORA_TRANSLATOR_BIN", stand_in_binary()},
              {?ANTHROPIC_KEY, "sk-ant-test"}],
             fun() ->
                     Resolved = resolution(),
                     ?assertEqual(ready, maps:get(status, Resolved)),
                     Backend = maps:get(backend, Resolved),
                     ?assertEqual(<<"anthropic">>, maps:get(provider, Backend)),
                     ?assertEqual(native, maps:get(wire, Backend)),
                     ?assertEqual(<<"https://api.anthropic.com/v1">>,
                                  maps:get(base_url, Backend))
             end).

%% A translator makes a vendor dialable for the modalities it actually serves, and for no
%% others: replicate covers image and music, and a key for it buys nothing on a text ladder.
a_translator_widens_a_vendor_only_where_it_serves_test() ->
    with_env([{"AGORA_TRANSLATOR", "on"}, {"AGORA_TRANSLATOR_BIN", stand_in_binary()},
              {"AGORA_PROVIDER_REPLICATE_API_KEY", "r8-test"}],
             fun() ->
                     Config = apr_config:from_env(),
                     lists:foreach(
                       fun(Modality) ->
                               Resolved = apr_backends:resolve_tier(paid, Modality, Config),
                               ?assertEqual(ready, maps:get(status, Resolved)),
                               ?assertEqual(<<"replicate">>,
                                            maps:get(provider, maps:get(backend, Resolved)))
                       end, [image, music]),
                     %% Not a text vendor at all — no rung to widen.
                     ?assertEqual(unconfigured,
                                  maps:get(status, apr_backends:resolve_tier(
                                                     paid, text, Config)))
             end).

%% --- the URL a converted request goes to ------------------------------------

a_translated_request_goes_to_the_path_the_translator_chose_test() ->
    Backend = #{tier => paid, provider => <<"anthropic">>, modality => text,
                model => <<"claude">>, base_url => <<"https://api.anthropic.com/v1/">>,
                api_key => <<"sk">>, wire => native, path => <<"/messages">>},
    ?assertEqual(<<"https://api.anthropic.com/v1/messages">>,
                 apr_backends:backend_url(Backend)),
    %% Before a conversion there is no path, and the modality's own route stands.
    ?assertEqual(<<"https://api.anthropic.com/v1/chat/completions">>,
                 apr_backends:backend_url(Backend#{path := undefined})).

%% --- with no translator, a conversion is an error and never a crash ---------

a_conversion_without_a_translator_is_a_reportable_error_test() ->
    with_env([{"AGORA_TRANSLATOR", "off"}],
             fun() ->
                     ?assertMatch({error, Reason} when is_binary(Reason),
                                  apr_translate:to_native(<<"anthropic">>, text, <<"m">>,
                                                          {obj, [{<<"prompt">>, <<"hi">>}]})),
                     ?assertMatch({error, Reason} when is_binary(Reason),
                                  apr_translate:from_native(<<"anthropic">>, text, <<"m">>,
                                                            {obj, []}))
             end).
