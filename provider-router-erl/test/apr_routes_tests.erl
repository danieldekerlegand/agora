%%% @doc eunit: the Erlang route table equals the exact `app.py` surface, and the
%%% `/health` body is byte-identical — both asserted without booting a server.
-module(apr_routes_tests).
-include_lib("eunit/include/eunit.hrl").

%% The ten paths of `app.py`, verbatim. If the Python surface changes, this list and the
%% route table must change together — that is the point of pinning it here.
-define(PYTHON_SURFACE,
        [<<"/health">>,
         <<"/doctor">>,
         <<"/v1/models">>,
         <<"/v1/providers">>,
         <<"/.well-known/kcb-manifest.json">>,
         <<"/v1/chat/completions">>,
         <<"/v1/images/generations">>,
         <<"/v1/audio/speech">>,
         <<"/v1/audio/music-generations">>,
         <<"/v1/video/generations">>]).

route_table_matches_python_surface_test() ->
    ?assertEqual(lists:sort(?PYTHON_SURFACE), lists:sort(apr_routes:paths())).

route_table_has_no_duplicates_test() ->
    Paths = apr_routes:paths(),
    ?assertEqual(length(Paths), length(lists:usort(Paths))).

dispatch_compiles_test() ->
    %% cowboy_router:compile/1 returns an opaque rules term; asserting it does not throw
    %% is enough to know the table is well-formed.
    ?assert(is_list(apr_routes:dispatch())).

health_body_is_byte_identical_test() ->
    ?assertEqual(
       <<"{\"status\":\"ok\",\"identity\":\"agora:agent:provider-router\","
         "\"version\":\"0.1.0\",\"kcb_version\":\"0.2.0\"}">>,
       apr_health:body()).
