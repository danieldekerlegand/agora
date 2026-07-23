%%% @doc common_test: the KCB `subscribe' fan-out and the `fetch' verb — `capability-bus.md'
%%% §4/§5, realized as BEAM processes.
%%%
%%% What these cases are actually about:
%%%
%%% * **Isolation is the design claim, so it is measured.** A subscription is a process so
%%%   that a consumer which cannot keep up costs only itself. `a_slow_subscriber...' proves
%%%   that with a stopwatch: while one subscription is four seconds behind, the publisher
%%%   returns immediately, the other subscribers finish, and a generation still serves.
%%% * **A refusal must happen before delivery, not instead of it.** Every authorization case
%%%   asserts the consumer's inbox is empty, not merely that an error came back — a stream
%%%   that leaks one event before closing has already leaked it.
%%% * **At-least-once plus content addressing is the ordering story.** Nothing asserts an
%%%   order and nothing asserts exactly-once; what is asserted is that a redelivery is
%%%   invisible and an out-of-order arrival is unremarkable, which is what §4 actually
%%%   promises.
-module(apr_subscribe_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, init_per_suite/1, end_per_suite/1, init_per_testcase/2, end_per_testcase/2]).
-export([n_concurrent_subscribers_each_receive_every_delta/1,
         a_slow_subscriber_isolates_its_own_back_pressure/1,
         an_ungranted_subscribe_is_refused_without_delivering/1,
         an_over_ceiling_subscribe_is_refused_before_registering/1,
         the_grants_ceiling_is_enforced_on_the_stream/1,
         redelivery_is_idempotent_and_arrival_order_is_irrelevant/1,
         a_dangling_asset_reference_is_tolerated_and_fetched_lazily/1,
         the_fetch_verb_requires_a_fetch_asset_grant/1,
         a_generation_announces_itself_on_its_capability_and_world/1,
         the_openai_surface_is_unchanged_while_subscriptions_are_active/1,
         the_subscribe_endpoint_streams_server_sent_events/1]).

-define(WORLD, <<"world/consensus-reality">>).
-define(GRANT, <<"subscribe:world/consensus-reality">>).
-define(FETCH_GRANT, "fetch:asset").
-define(KEY_VAR, "AGORA_PROVIDER_OPENAI_API_KEY").

all() ->
    [n_concurrent_subscribers_each_receive_every_delta,
     a_slow_subscriber_isolates_its_own_back_pressure,
     an_ungranted_subscribe_is_refused_without_delivering,
     an_over_ceiling_subscribe_is_refused_before_registering,
     the_grants_ceiling_is_enforced_on_the_stream,
     redelivery_is_idempotent_and_arrival_order_is_irrelevant,
     a_dangling_asset_reference_is_tolerated_and_fetched_lazily,
     the_fetch_verb_requires_a_fetch_asset_grant,
     a_generation_announces_itself_on_its_capability_and_world,
     the_openai_surface_is_unchanged_while_subscriptions_are_active,
     the_subscribe_endpoint_streams_server_sent_events].

init_per_suite(Config) ->
    %% A bare, keyless node: every ladder resolves to the free placeholder, so a capability
    %% stream costs nothing and a generation is deterministic.
    lists:foreach(fun os:unsetenv/1,
                  [?KEY_VAR, "OPENAI_API_KEY", "AGORA_TEXT_LADDER", "AGORA_PREFER_LOCAL",
                   "AGORA_PUBLIC_BASE_URL"]),
    ok = application:set_env(agora_provider_router, port, 0),
    {ok, _Started} = application:ensure_all_started(agora_provider_router),
    {ok, _Inets} = application:ensure_all_started(inets),
    [{port, ranch:get_port(agora_provider_router_listener)} | Config].

end_per_suite(_Config) ->
    ok = application:stop(agora_provider_router),
    ok.

init_per_testcase(_Case, Config) ->
    Config.

%% Every case leaves the bus empty, so "nothing was delivered" in the next one means what it
%% says rather than "delivered to somebody else's leftover subscription".
end_per_testcase(_Case, _Config) ->
    os:unsetenv(?KEY_VAR),
    lists:foreach(fun(Ref) -> ok = apr_bus:unsubscribe(Ref) end, apr_bus:refs()),
    ok = await(fun() -> apr_bus:subscription_count() =:= 0 end),
    ok.

%% --- fan-out ----------------------------------------------------------------

n_concurrent_subscribers_each_receive_every_delta(_Config) ->
    Consumers = [collector(0) || _N <- lists:seq(1, 25)],
    Refs = [begin
                {ok, #{ref := Ref}} = apr_bus:subscribe(?WORLD, ?GRANT, #{deliver_to => Pid}),
                Ref
            end || Pid <- Consumers],
    25 = length(Refs),

    Ids = [publish_delta(?WORLD, N) || N <- lists:seq(1, 20)],
    %% Each subscription is its own process, so "everyone got everything" is 25 independent
    %% facts rather than one shared cursor.
    lists:foreach(fun(Pid) -> Ids = await_ids(Pid, 20) end, Consumers),
    lists:foreach(fun stop_collector/1, Consumers),
    ok.

a_slow_subscriber_isolates_its_own_back_pressure(Config) ->
    Fast = [collector(0) || _N <- lists:seq(1, 12)],
    lists:foreach(fun(Pid) ->
                          {ok, _} = apr_bus:subscribe(?WORLD, ?GRANT, #{deliver_to => Pid})
                  end, Fast),

    %% The slow consumer's delay runs INSIDE its subscription process (a `deliver' fun), so
    %% the back-pressure is genuinely the subscriber's and not merely its mailbox's.
    Self = self(),
    Slow = fun(Envelope) ->
                   timer:sleep(200),
                   Self ! {slow, maps:get(id, Envelope)}
           end,
    {ok, _} = apr_bus:subscribe(?WORLD, ?GRANT, #{deliver => Slow}),

    Started = erlang:monotonic_time(millisecond),
    Ids = [publish_delta(?WORLD, N) || N <- lists:seq(1, 20)],
    Published = erlang:monotonic_time(millisecond) - Started,
    %% 20 events x 200 ms = four seconds of work queued in one process. Publishing is a cast
    %% per subscriber, so it costs the producer none of it.
    true = Published < 1000,

    lists:foreach(fun(Pid) -> Ids = await_ids(Pid, 20) end, Fast),
    FastDone = erlang:monotonic_time(millisecond) - Started,
    true = FastDone < 4000,

    %% ...and the ladder is untouched while the slow subscription is still four seconds deep.
    {200, Body} = post(Config, "/v1/chat/completions", <<"{\"messages\":[]}">>, []),
    {ok, Decoded} = apr_json:decode(Body),
    <<"placeholder">> = apr_json:get(<<"tier">>, apr_json:get(<<"agora">>, Decoded)),
    true = (erlang:monotonic_time(millisecond) - Started) < 4000,

    %% Slow, but never dropped: back-pressure delays a consumer, it does not lose its stream.
    Ids = drain_slow(20, []),
    lists:foreach(fun stop_collector/1, Fast),
    ok.

%% --- authorization (§5) -----------------------------------------------------

an_ungranted_subscribe_is_refused_without_delivering(_Config) ->
    Consumer = collector(0),
    %% No grant at all, a grant for another world, and a grant for another verb.
    {error, 403, _} = apr_bus:subscribe(?WORLD, undefined, #{deliver_to => Consumer}),
    {error, 403, _} = apr_bus:subscribe(?WORLD, <<"subscribe:world/elsewhere">>,
                                        #{deliver_to => Consumer}),
    {error, 403, _} = apr_bus:subscribe(?WORLD, <<"fetch:asset">>, #{deliver_to => Consumer}),
    %% ...and an unreadable one is a 422 rather than a silently unbounded subscription.
    {error, 422, _} = apr_bus:subscribe(?WORLD,
                                        {obj, [{<<"scope">>, ?GRANT},
                                               {<<"budget_units">>, <<"lots">>}]},
                                        #{deliver_to => Consumer}),

    [] = apr_bus:subscribers(?WORLD),
    {ok, 0} = publish(?WORLD, delta(1)),
    %% Refused means refused: nothing was registered, so nothing was delivered. The sleep is
    %% the assertion — "no event yet" on an asynchronous bus proves nothing without one.
    timer:sleep(250),
    [] = await_ids(Consumer, 0),
    stop_collector(Consumer),
    ok.

an_over_ceiling_subscribe_is_refused_before_registering(_Config) ->
    %% A keyed node advertises the paid tier for `generate.text' at 60 units per nominal
    %% request (the number the manifest publishes). A grant that cannot afford one delivery is
    %% refused at registration rather than admitted to a stream that would close on its first
    %% event.
    true = os:putenv(?KEY_VAR, "sk-test-only"),
    Consumer = collector(0),
    Topic = <<"capability/generate.text">>,
    Stingy = {obj, [{<<"scope">>, <<"subscribe:generate.text">>}, {<<"budget_units">>, 1}]},
    {error, 403, Message} = apr_bus:subscribe(Topic, Stingy, #{deliver_to => Consumer}),
    true = binary:match(Message, <<"ceiling">>) =/= nomatch,
    [] = apr_bus:subscribers(Topic),

    %% The control: the same grant with a ceiling that covers an event is admitted, so the
    %% refusal above is about the ceiling and not about capability topics being unreachable.
    Generous = {obj, [{<<"scope">>, <<"subscribe:generate.text">>},
                      {<<"budget_units">>, 100000}]},
    {ok, #{ref := Ref}} = apr_bus:subscribe(Topic, Generous, #{deliver_to => Consumer}),
    ok = apr_bus:unsubscribe(Ref),
    stop_collector(Consumer),
    ok.

the_grants_ceiling_is_enforced_on_the_stream(_Config) ->
    %% A grant bounds the whole stream (§5), not each event: 4 + 4 fits under 10, the third
    %% would not, and the stream closes instead of delivering it.
    Consumer = collector(0),
    Grant = {obj, [{<<"scope">>, ?GRANT}, {<<"budget_units">>, 10}]},
    {ok, #{pid := Pid}} = apr_bus:subscribe(?WORLD, Grant, #{deliver_to => Consumer}),
    First = publish_priced(?WORLD, 1, 4),
    Second = publish_priced(?WORLD, 2, 4),
    _Third = publish_priced(?WORLD, 3, 4),

    [First, Second, {closed, budget_exhausted}] = await_ids(Consumer, 3),
    ok = await(fun() -> not is_process_alive(Pid) end),
    %% The exhausted subscription deregisters itself, so it cannot be published to again.
    ok = await(fun() -> apr_bus:subscribers(?WORLD) =:= [] end),
    stop_collector(Consumer),
    ok.

%% --- ordering-independence and dangling references (delta L) ----------------

redelivery_is_idempotent_and_arrival_order_is_irrelevant(_Config) ->
    Consumer = collector(0),
    {ok, #{pid := Pid}} = apr_bus:subscribe(?WORLD, ?GRANT, #{deliver_to => Consumer}),

    A = publish_delta(?WORLD, 1),
    %% Sequence 7 before sequence 3 — the bus never inspects an ordering it was never
    %% promised, so a "late" delta is just a delta.
    Late = publish_seq(?WORLD, 7),
    Early = publish_seq(?WORLD, 3),
    %% ...and the exact same content-addressed event again. At-least-once plus idempotence is
    %% what §4 offers in place of exactly-once.
    A = publish_delta(?WORLD, 1),

    [A, Late, Early] = await_ids(Consumer, 3),
    #{delivered := 3, dropped := 1} = apr_subscriber:status(Pid),
    stop_collector(Consumer),
    ok.

a_dangling_asset_reference_is_tolerated_and_fetched_lazily(Config) ->
    Consumer = collector(0),
    {ok, _} = apr_bus:subscribe(?WORLD, ?GRANT, #{deliver_to => Consumer}),

    Bytes = <<"the bytes that have not propagated yet">>,
    Id = apr_assets:id_for(Bytes),
    false = apr_assets:exists(Id),
    Event = {obj, [{<<"kind">>, <<"delta">>},
                   {<<"claim_id">>, <<"kgp:claim:sha256:dangling">>},
                   {<<"asset">>, {obj, [{<<"id">>, Id}]}}]},
    {ok, 1} = publish(?WORLD, Event),
    %% The delta is delivered as it stands. A producer "MUST NOT assume bytes are
    %% pre-propagated", so a reference with nothing behind it is a normal delta, not an error.
    [<<"kgp:claim:sha256:dangling">>] = await_ids(Consumer, 1),

    Path = binary_to_list(apr_assets:fetch_path(Id)),
    {404, Pending} = get(Config, Path, [{"X-Agora-Grant", ?FETCH_GRANT}]),
    {ok, Decoded} = apr_json:decode(Pending),
    %% "Not yet" and "never" are different answers — a consumer needs to know it may retry.
    true = apr_json:get(<<"pending">>, Decoded),

    Id = apr_assets:put(Bytes, <<"application/octet-stream">>),
    {200, Bytes} = get(Config, Path, [{"X-Agora-Grant", ?FETCH_GRANT}]),
    stop_collector(Consumer),
    ok.

the_fetch_verb_requires_a_fetch_asset_grant(Config) ->
    Id = apr_assets:put(<<"guarded bytes">>, <<"application/octet-stream">>),
    Path = binary_to_list(apr_assets:fetch_path(Id)),
    %% §4: "Requires a `fetch:asset` grant (§5)."
    {403, _} = get(Config, Path, []),
    {403, _} = get(Config, Path, [{"X-Agora-Grant", "subscribe:world/consensus-reality"}]),
    {422, _} = get(Config, Path, [{"X-Agora-Grant", "not-a-token"}]),
    {200, <<"guarded bytes">>} = get(Config, Path, [{"X-Agora-Grant", ?FETCH_GRANT}]),
    ok.

%% --- the router as a producer -----------------------------------------------

a_generation_announces_itself_on_its_capability_and_world(Config) ->
    ByCapability = collector(0),
    ByWorld = collector(0),
    {ok, _} = apr_bus:subscribe(<<"capability/generate.image">>,
                                <<"subscribe:generate.image">>,
                                #{deliver_to => ByCapability}),
    {ok, _} = apr_bus:subscribe(<<"world/dune">>, <<"subscribe:world/dune">>,
                                #{deliver_to => ByWorld}),

    {200, _Body} = post(Config, "/v1/images/generations",
                        <<"{\"prompt\":\"a sietch\",\"world\":\"dune\"}">>, []),

    [Envelope] = await_events(ByCapability, 1),
    [Same] = await_events(ByWorld, 1),
    %% One generation, one content-addressed claim, two topics — the world subscriber and the
    %% capability subscriber are looking at the same event, not at two versions of it.
    Claim = maps:get(id, Envelope),
    Claim = maps:get(id, Same),
    <<"kgp:claim:sha256:", _Digest/binary>> = Claim,

    Data = apr_json:get(<<"data">>, maps:get(json, Envelope)),
    <<"media">> = apr_json:get(<<"kind">>, Data),
    <<"generate.image">> = apr_json:get(<<"capability">>, Data),
    <<"placeholder">> = apr_json:get(<<"tier">>, Data),
    <<"dune">> = apr_json:get(<<"world">>, Data),
    %% A free tier costs a grant nothing — the ZERO-SPEND path stays zero on the bus too.
    true = apr_json:get(<<"cost_units">>, Data) == 0.0,

    %% The artifact travels by reference and is fetchable by its hash.
    Asset = apr_json:get(<<"asset">>, Data),
    AssetId = apr_json:get(<<"id">>, Asset),
    <<"image/png">> = apr_json:get(<<"media_type">>, Asset),
    FetchPath = binary_to_list(apr_json:get(<<"fetch">>, Asset)),
    {200, Artifact} = get(Config, FetchPath, [{"X-Agora-Grant", ?FETCH_GRANT}]),
    AssetId = apr_assets:id_for(Artifact),

    lists:foreach(fun stop_collector/1, [ByCapability, ByWorld]),
    ok.

%% --- the contract is untouched ----------------------------------------------

the_openai_surface_is_unchanged_while_subscriptions_are_active(Config) ->
    Quiet = surface(Config),

    Consumers = [collector(0) || _N <- lists:seq(1, 30)],
    lists:foreach(
      fun({Pid, N}) ->
              {Topic, Grant} =
                  case N rem 3 of
                      0 -> {?WORLD, ?GRANT};
                      1 -> {<<"world/*">>, <<"subscribe:world/*">>};
                      _ -> {<<"capability/generate.text">>, <<"subscribe:generate.text">>}
                  end,
              {ok, _} = apr_bus:subscribe(Topic, Grant, #{deliver_to => Pid})
      end,
      lists:zip(Consumers, lists:seq(1, 30))),
    30 = apr_bus:subscription_count(),

    %% Byte-for-byte, with thirty subscriptions live and every generation announcing to them.
    Busy = surface(Config),
    Quiet = Busy,
    lists:foreach(fun stop_collector/1, Consumers),
    ok.

%% The eleven mirrored paths that answer with a body, captured as raw bytes.
surface(Config) ->
    Reads = [get(Config, "/health", []),
             get(Config, binary_to_list(apr_manifest:manifest_path()), [])],
    Writes = [post(Config, Path, <<"{\"prompt\":\"hi\",\"messages\":[]}">>, [])
              || Path <- ["/v1/chat/completions", "/v1/images/generations",
                          "/v1/audio/speech", "/v1/audio/music-generations",
                          "/v1/video/generations"]],
    Reads ++ Writes.

%% --- the streaming surface --------------------------------------------------

the_subscribe_endpoint_streams_server_sent_events(Config) ->
    %% Refused over HTTP exactly as in-process, and with a JSON body a client can act on.
    {403, Denied} = post(Config, "/v1/subscribe", <<"{\"topic\":\"world/sse\"}">>, []),
    {ok, DeniedBody} = apr_json:decode(Denied),
    true = is_binary(apr_json:get(<<"detail">>, DeniedBody)),
    {422, _} = post(Config, "/v1/subscribe",
                    <<"{\"topic\":\"nowhere\",\"grant\":\"subscribe:nowhere\"}">>, []),

    Socket = open_stream(Config, <<"{\"topic\":\"world/sse\","
                                   "\"grant\":\"subscribe:world/sse\"}">>),
    Head = read_until(Socket, <<"event: subscribed">>, <<>>),
    %% A2A streaming is server-sent events over a POST (§4).
    true = binary:match(Head, <<"HTTP/1.1 200 ">>) =/= nomatch,
    true = binary:match(Head, <<"text/event-stream">>) =/= nomatch,
    nomatch = binary:match(Head, <<"event: delta">>),

    Id = publish_delta(<<"world/sse">>, 42),
    Frame = read_until(Socket, Id, <<>>),
    true = binary:match(Frame, <<"event: delta">>) =/= nomatch,
    ok = gen_tcp:close(Socket),
    ok.

%% --- helpers ---

%% A consumer process: accumulates the ids it was handed, in arrival order.
collector(Delay) ->
    spawn_link(fun() -> collect([], Delay) end).

collect(Acc, Delay) ->
    receive
        {kcb_event, _Ref, Envelope} ->
            ok = sleep(Delay),
            collect([Envelope | Acc], Delay);
        {kcb_closed, _Ref, Reason} ->
            collect([{closed, Reason} | Acc], Delay);
        {events, From} ->
            From ! {events, self(), lists:reverse(Acc)},
            collect(Acc, Delay);
        stop ->
            ok
    end.

sleep(0) -> ok;
sleep(Delay) -> timer:sleep(Delay).

stop_collector(Pid) -> Pid ! stop, ok.

%% Poll until `Count' entries have arrived (or the deadline passes) — the fan-out is
%% asynchronous by design, so nothing here may assume a delivery has already happened.
await_events(Pid, Count) -> await_events(Pid, Count, 8000).

await_events(Pid, Count, Budget) ->
    Pid ! {events, self()},
    receive
        {events, Pid, Events} when length(Events) >= Count -> Events;
        {events, Pid, Events} when Budget =< 0 -> Events;
        {events, Pid, _Partial} ->
            timer:sleep(25),
            await_events(Pid, Count, Budget - 25)
    after 5000 ->
        exit(collector_unresponsive)
    end.

await_ids(Pid, Count) ->
    [case Event of
         {closed, Reason} -> {closed, Reason};
         Envelope -> maps:get(id, Envelope)
     end || Event <- await_events(Pid, Count)].

%% Poll a condition the bus reaches asynchronously (a monitor firing, an index entry going).
await(Predicate) -> await(Predicate, 100).

await(Predicate, 0) ->
    case Predicate() of
        true -> ok;
        false -> exit(condition_never_held)
    end;
await(Predicate, Remaining) ->
    case Predicate() of
        true -> ok;
        false ->
            timer:sleep(20),
            await(Predicate, Remaining - 1)
    end.

drain_slow(0, Acc) -> lists:reverse(Acc);
drain_slow(Remaining, Acc) ->
    receive
        {slow, Id} -> drain_slow(Remaining - 1, [Id | Acc])
    after 10000 ->
        exit({slow_subscriber_lost, Remaining})
    end.

delta(N) ->
    {obj, [{<<"kind">>, <<"delta">>},
           {<<"claim_id">>, <<"kgp:claim:sha256:", (integer_to_binary(N))/binary>>},
           {<<"basis">>, <<"kgp:pack:sha256:basis">>}]}.

publish(Topic, Event) -> apr_bus:publish(Topic, Event).

publish_delta(Topic, N) ->
    Event = delta(N),
    {ok, _Count} = publish(Topic, Event),
    apr_bus:event_id(Event).

publish_seq(Topic, Seq) ->
    Event = {obj, [{<<"kind">>, <<"delta">>},
                   {<<"claim_id">>, <<"kgp:claim:sha256:seq-", (integer_to_binary(Seq))/binary>>},
                   {<<"seq">>, Seq}]},
    {ok, _Count} = publish(Topic, Event),
    apr_bus:event_id(Event).

publish_priced(Topic, N, Units) ->
    Event = {obj, [{<<"kind">>, <<"delta">>},
                   {<<"claim_id">>, <<"kgp:claim:sha256:priced-", (integer_to_binary(N))/binary>>},
                   {<<"cost_units">>, Units}]},
    {ok, _Count} = publish(Topic, Event),
    apr_bus:event_id(Event).

%% --- HTTP ---

get(Config, Path, Headers) ->
    request({url(Config, Path), Headers}, get).

post(Config, Path, Body, Headers) ->
    request({url(Config, Path), Headers, "application/json", Body}, post).

request(Request, Method) ->
    {ok, {{_Vsn, Status, _Reason}, _Headers, Body}} =
        httpc:request(Method, Request, [{autoredirect, false}], [{body_format, binary}]),
    {Status, Body}.

url(Config, Path) ->
    "http://127.0.0.1:" ++ integer_to_list(?config(port, Config)) ++ Path.

%% A raw socket rather than `httpc': an SSE response never ends, so the assertion has to be
%% "these bytes arrived by now", which needs the stream itself and not a completed request.
open_stream(Config, Body) ->
    Port = ?config(port, Config),
    {ok, Socket} = gen_tcp:connect("127.0.0.1", Port,
                                   [binary, {active, false}, {packet, raw}], 5000),
    Request = ["POST /v1/subscribe HTTP/1.1\r\n",
               "Host: 127.0.0.1\r\n",
               "Content-Type: application/json\r\n",
               "Content-Length: ", integer_to_list(byte_size(Body)), "\r\n\r\n",
               Body],
    ok = gen_tcp:send(Socket, Request),
    Socket.

read_until(Socket, Marker, Acc) ->
    case binary:match(Acc, Marker) of
        nomatch ->
            case gen_tcp:recv(Socket, 0, 5000) of
                {ok, Data} -> read_until(Socket, Marker, <<Acc/binary, Data/binary>>);
                {error, Reason} -> exit({stream_closed, Reason, Acc})
            end;
        _Found ->
            Acc
    end.
