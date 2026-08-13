%%% @doc eunit: the Erlang route table equals the exact `app.py` surface, and the
%%% `/health` body is byte-identical — both asserted without booting a server.
-module(apr_routes_tests).
-include_lib("eunit/include/eunit.hrl").

%% The thirteen paths of `app.py`, verbatim. If the Python surface changes, this list and the
%% route table must change together — that is the point of pinning it here.
%%
%% Both `.well-known` paths are `app.py`'s: `MANIFEST_PATH` serves the AgentCard the KCB
%% manifest was folded onto (capability-bus.md §6) and `LEGACY_MANIFEST_PATH` 308s onto it.
%% US-1 registered only the legacy path and deferred the reconciliation to the manifest story.
%%
%% `/mcp` and `/a2a` are the KCB §4 `invoke` transports. They belong in THIS list rather than
%% beside it: the Python router serves them too, so they are mirrored contract — and the
%% manifest advertises both, which makes a missing route a promise the fabric cannot keep.
-define(PYTHON_SURFACE,
        [<<"/health">>,
         <<"/doctor">>,
         <<"/v1/models">>,
         <<"/v1/providers">>,
         <<"/.well-known/agent-card.json">>,
         <<"/.well-known/kcb-manifest.json">>,
         <<"/mcp">>,
         <<"/a2a">>,
         <<"/v1/chat/completions">>,
         <<"/v1/images/generations">>,
         <<"/v1/audio/speech">>,
         <<"/v1/audio/music-generations">>,
         <<"/v1/video/generations">>]).

%% The KCB verbs of `capability-bus.md` §4 that the Python router never surfaced. They are
%% listed apart from `?PYTHON_SURFACE` on purpose: the contract set is what US-6's fixture
%% pins byte-for-byte, and an addition beside it must never be mistaken for a change to it.
-define(BUS_SURFACE,
        [<<"/v1/subscribe">>,
         <<"/v1/assets/:id">>]).

route_table_matches_python_surface_test() ->
    ?assertEqual(lists:sort(?PYTHON_SURFACE), lists:sort(apr_routes:contract_paths())).

bus_routes_are_additions_beside_the_contract_test() ->
    ?assertEqual(lists:sort(?BUS_SURFACE), lists:sort(apr_routes:bus_paths())),
    ?assertEqual(lists:sort(?PYTHON_SURFACE ++ ?BUS_SURFACE), lists:sort(apr_routes:paths())).

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

%% Every address the manifest publishes is one this router actually serves — the same guard
%% `test_manifest.py::TestEveryAdvertisedAddressAnswers` puts on the Python side, taken here
%% at the route table so it holds without booting anything. An advertised address is a promise
%% a peer will dial directly (ADR-0001 decision 3); a dead one is worse than an absent one.
every_advertised_endpoint_is_a_registered_path_test() ->
    Base = apr_manifest:base_url(apr_config:from_env(#{})),
    Endpoints = apr_json:get(<<"endpoints">>, apr_manifest:body(apr_config:from_env(#{}))),
    Paths = apr_routes:paths(),
    lists:foreach(
      fun({Name, Address}) ->
              Size = byte_size(Base),
              <<Base:Size/binary, Path/binary>> = Address,
              %% `/v1` is the OpenAI prefix rather than a route of its own — the five
              %% generation POSTs hang off it, and the manifest names the prefix.
              Registered = lists:member(Path, Paths)
                  orelse lists:any(fun(P) -> binary:longest_common_prefix([P, Path]) =:=
                                                 byte_size(Path) end, Paths),
              ?assertEqual({Name, Path, true}, {Name, Path, Registered})
      end, apr_json:kvs(Endpoints)).
