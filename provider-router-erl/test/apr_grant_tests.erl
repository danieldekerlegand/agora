%%% @doc eunit: capability grants and bus topics — `capability-bus.md' §4/§5, the pure half.
%%%
%%% The fan-out itself is a ct concern (it needs a running tree); what is asserted here is the
%%% part that decides whether anything is delivered at all.
-module(apr_grant_tests).
-include_lib("eunit/include/eunit.hrl").

%% --- parsing ----------------------------------------------------------------

a_token_grant_parses_test() ->
    {ok, Grant} = apr_grant:parse(<<"subscribe:world/consensus-reality">>),
    ?assertEqual(<<"subscribe">>, apr_grant:verb(Grant)),
    ?assertEqual(<<"world/consensus-reality">>, apr_grant:scope(Grant)),
    ?assertEqual(undefined, apr_grant:ceiling(Grant)),
    ?assertEqual(<<"subscribe:world/consensus-reality">>, apr_grant:token(Grant)).

an_object_grant_carries_a_ceiling_test() ->
    {ok, Grant} = apr_grant:parse({obj, [{<<"scope">>, <<"subscribe:world/x">>},
                                         {<<"budget_units">>, 250}]}),
    ?assertEqual(<<"world/x">>, apr_grant:scope(Grant)),
    ?assert(apr_grant:ceiling(Grant) == 250.0).

verb_and_scope_may_be_split_test() ->
    {ok, Grant} = apr_grant:parse({obj, [{<<"verb">>, <<"fetch">>}, {<<"scope">>, <<"asset">>}]}),
    ?assertEqual(<<"fetch:asset">>, apr_grant:token(Grant)).

%% §5's whole point: an authorization input the caller failed to state cannot widen what the
%% caller may do. A missing grant is a refusal, not an unbounded permission.
a_missing_grant_is_a_403_test() ->
    ?assertMatch({error, 403, _}, apr_grant:parse(undefined)),
    ?assertMatch({error, 403, _}, apr_grant:parse(null)),
    ?assertMatch({error, 403, _}, apr_grant:parse(<<>>)).

a_malformed_grant_is_a_422_test() ->
    ?assertMatch({error, 422, _}, apr_grant:parse(<<"world/x">>)),
    ?assertMatch({error, 422, _}, apr_grant:parse(<<"teleport:world/x">>)),
    ?assertMatch({error, 422, _}, apr_grant:parse({obj, [{<<"budget_units">>, 1}]})),
    ?assertMatch({error, 422, _}, apr_grant:parse(42)).

%% The same rule as `cost.py::parse_ceiling`: junk is an error, never a silent absence.
an_unreadable_grant_ceiling_is_refused_test() ->
    ?assertMatch({error, 422, _},
                 apr_grant:parse({obj, [{<<"scope">>, <<"subscribe:world/x">>},
                                        {<<"budget_units">>, <<"lots">>}]})),
    %% ...and a negative one clamps to zero rather than being ignored.
    {ok, Clamped} = apr_grant:parse({obj, [{<<"scope">>, <<"subscribe:world/x">>},
                                           {<<"budget_units">>, -5}]}),
    ?assert(apr_grant:ceiling(Clamped) == 0.0).

%% --- scope matching ---------------------------------------------------------

a_grant_covers_only_its_own_scope_test() ->
    {ok, Grant} = apr_grant:parse(<<"subscribe:world/consensus-reality">>),
    ?assert(apr_grant:permits(Grant, <<"subscribe">>, <<"world/consensus-reality">>)),
    ?assertNot(apr_grant:permits(Grant, <<"subscribe">>, <<"world/other">>)),
    %% The verb is half the token — a subscribe grant is not a fetch grant.
    ?assertNot(apr_grant:permits(Grant, <<"fetch">>, <<"world/consensus-reality">>)).

a_wildcard_grant_covers_its_subtree_test() ->
    {ok, Subtree} = apr_grant:parse(<<"subscribe:world/*">>),
    ?assert(apr_grant:permits(Subtree, <<"subscribe">>, <<"world/anything">>)),
    ?assertNot(apr_grant:permits(Subtree, <<"subscribe">>, <<"generate.text">>)),
    {ok, Everything} = apr_grant:parse(<<"subscribe:*">>),
    ?assert(apr_grant:permits(Everything, <<"subscribe">>, <<"generate.text">>)).

required_scope_follows_the_topic_kind_test() ->
    ?assertEqual(<<"world/x">>, apr_grant:required_scope(<<"world/x">>)),
    ?assertEqual(<<"generate.image">>, apr_grant:required_scope(<<"capability/generate.image">>)).

%% --- topics -----------------------------------------------------------------

topics_are_worlds_or_capabilities_test() ->
    ?assertEqual({ok, <<"world/consensus-reality">>},
                 apr_bus:parse_topic(<<"world/consensus-reality">>)),
    ?assertEqual({ok, <<"world/*">>}, apr_bus:parse_topic(<<"world/*">>)),
    ?assertEqual({ok, <<"capability/generate.video">>},
                 apr_bus:parse_topic(<<"capability/generate.video">>)),
    ?assertMatch({error, 422, _}, apr_bus:parse_topic(<<"anything-else">>)),
    ?assertMatch({error, 422, _}, apr_bus:parse_topic(<<"world/">>)),
    ?assertMatch({error, 422, _}, apr_bus:parse_topic(42)).

%% A capability nobody offers would be a stream that never emits — say so at registration.
an_unoffered_capability_is_not_a_topic_test() ->
    ?assertMatch({error, 422, _}, apr_bus:parse_topic(<<"capability/generate.smell">>)).

capability_topics_round_trip_the_manifest_name_test() ->
    ?assertEqual(<<"capability/generate.text">>, apr_bus:capability_topic(text)),
    ?assertEqual(<<"world/dune">>, apr_bus:world_topic(<<"dune">>)).

%% --- event identity ---------------------------------------------------------

%% Content-addressed by construction: the same event is the same id, which is what lets the
%% fan-out redeliver freely instead of promising exactly-once (§4).
an_event_id_is_a_function_of_its_content_test() ->
    Event = {obj, [{<<"kind">>, <<"delta">>}, {<<"basis">>, <<"pack-1">>}]},
    Reordered = {obj, [{<<"basis">>, <<"pack-1">>}, {<<"kind">>, <<"delta">>}]},
    ?assertEqual(apr_bus:event_id(Event), apr_bus:event_id(Reordered)),
    ?assertNotEqual(apr_bus:event_id(Event),
                    apr_bus:event_id({obj, [{<<"kind">>, <<"delta">>}]})),
    ?assertMatch(<<"kcb:event:sha256:", _/binary>>, apr_bus:event_id(Event)).

a_producers_own_claim_id_wins_test() ->
    ?assertEqual(<<"kgp:claim:sha256:abc">>,
                 apr_bus:event_id({obj, [{<<"claim_id">>, <<"kgp:claim:sha256:abc">>}]})).

an_envelope_carries_id_topic_kind_and_cost_test() ->
    Event = {obj, [{<<"kind">>, <<"media">>}, {<<"cost_units">>, 12}]},
    Envelope = apr_bus:envelope(<<"world/x">>, Event),
    ?assertEqual(<<"world/x">>, maps:get(topic, Envelope)),
    ?assertEqual(<<"media">>, maps:get(kind, Envelope)),
    ?assert(maps:get(cost_units, Envelope) == 12.0),
    %% The producer's payload is nested verbatim, never rewritten.
    ?assertEqual(Event, apr_json:get(<<"data">>, maps:get(json, Envelope))).

%% --- asset ids --------------------------------------------------------------

an_asset_id_is_its_hash_test() ->
    Id = apr_assets:id_for(<<"bytes">>),
    ?assertMatch(<<"kinp:asset:sha256:", _/binary>>, Id),
    ?assertEqual(Id, apr_assets:id_for(<<"bytes">>)),
    ?assertNotEqual(Id, apr_assets:id_for(<<"other">>)),
    %% The fetch address is the digest, so the id survives a URL path segment intact.
    ?assertEqual(<<"/v1/assets/", (apr_assets:digest_of(Id))/binary>>,
                 apr_assets:fetch_path(Id)),
    ?assertEqual(apr_assets:digest_of(Id), apr_assets:digest_of(apr_assets:digest_of(Id))).
