%%% @doc The binding to the Rust translation library (agora:60) — a supervised external port
%%% program, driven on the generation hot path.
%%%
%%% Seven paid vendors do not speak OpenAI's wire format (`backends.py''s `wire = "native"':
%%% anthropic, gemini, replicate, elevenlabs, runway, luma, minimax). Until this module they
%%% resolved to `pending-adapter' — recognised, reported, never dialed. The conversion itself
%%% lives in Rust (`translation/crates/wire'), because it is CPU-bound serde on a request
%%% path; this module is how the BEAM reaches it.
%%%
%%% **A port, not a NIF, and that is the point.** The router's invariant is that no rung can
%%% take down the node. A NIF runs inside the BEAM's address space, where a panic or a
%%% segfault in third-party wire-format code would be exactly the failure the sacred ladder
%%% exists to make impossible; "fail-safe" would be a claim about the Rust rather than a
%%% property of the design. An OS process cannot do that. Here the worst case costs one pipe:
%%% the port dies, {@link handle_info/2} clears it, this call answers `{error, _}', the rung
%%% worker records an undialed attempt and the walk continues to a cheaper — ultimately
%%% zero-cost — rung. Always-completes and ZERO-SPEND hold with the translator absent,
%%% crashed, hung or wrong.
%%%
%%% **Absent is a supported deployment.** {@link enabled/0} is a pure question — an
%%% environment switch and a stat — with no process behind it, so {@link apr_backends} can ask
%%% it while resolving a rung without dialing anything. A node built without cargo simply has
%%% no executable in `priv/', every native vendor stays `pending-adapter', and the router
%%% behaves exactly as the Python one it mirrors does.
%%%
%%% Conversions are serialized through this one process, which is what keeps the port's
%%% request/reply framing unambiguous. The ladder is already the narrower constraint: a rung
%%% worker holds its caller for the whole dial, so at most one conversion per (modality, tier)
%%% is ever in flight.
-module(apr_translate).
-behaviour(gen_server).

-export([start_link/0, enabled/0, executable/0, to_native/4, from_native/4]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2]).

%% The port program built from `translation/crates/wire' by `build-translator.sh'.
-define(EXECUTABLE, "agora-translation-port").

%% How long the port gets to answer one frame, and how long a caller waits on this process.
%% The caller's deadline is the longer of the two: a conversion that times out must be
%% reported as a translator failure, not as a `gen_server' exit the router has to guess at.
-define(PORT_TIMEOUT, 5000).
-define(CALL_TIMEOUT, 10000).

-type state() :: #{port := port() | undefined}.

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

%% --- is there a translator at all? -------------------------------------------

%% @doc Whether this node can convert native-wire vendors. Pure: no port is opened, nothing
%% is dialed, so a rung resolution may ask freely.
-spec enabled() -> boolean().
enabled() -> executable() =/= undefined.

%% @doc The port program's path, or `undefined' when the node has none (or has been told not
%% to use it via `AGORA_TRANSLATOR=off'). `AGORA_TRANSLATOR_BIN' names a specific build.
-spec executable() -> string() | undefined.
executable() ->
    case switched_off() of
        true -> undefined;
        false ->
            Path = configured_path(),
            case filelib:is_regular(Path) of
                true -> Path;
                false -> undefined
            end
    end.

switched_off() ->
    lists:member(string:lowercase(string:trim(os:getenv("AGORA_TRANSLATOR", "on"))),
                 ["off", "0", "false", "no"]).

configured_path() ->
    case os:getenv("AGORA_TRANSLATOR_BIN") of
        false -> default_path();
        "" -> default_path();
        Configured -> Configured
    end.

default_path() ->
    case code:priv_dir(agora_provider_router) of
        {error, _} -> filename:join("priv", ?EXECUTABLE);
        Dir -> filename:join(Dir, ?EXECUTABLE)
    end.

%% --- the two directions ------------------------------------------------------

%% @doc An OpenAI-shaped request out to `Provider''s native wire: `{ok, Path, Body}', where
%% `Path' is vendor-relative (where a request goes is part of a vendor's wire format).
-spec to_native(binary(), atom(), binary(), term()) ->
          {ok, binary(), term()} | {error, binary()}.
to_native(Provider, Modality, Model, Body) ->
    case convert(request(<<"to_native">>, Provider, Modality, Model, Body)) of
        {ok, Reply} ->
            case {apr_json:get(<<"path">>, Reply), apr_json:get(<<"body">>, Reply)} of
                {Path, Native} when is_binary(Path), Native =/= undefined ->
                    {ok, Path, Native};
                _ ->
                    {error, <<"the translator returned no native request">>}
            end;
        {error, Reason} ->
            {error, Reason}
    end.

%% @doc `Provider''s native response back into the OpenAI envelope for `Modality'.
-spec from_native(binary(), atom(), binary(), term()) -> {ok, term()} | {error, binary()}.
from_native(Provider, Modality, Model, Body) ->
    case convert(request(<<"from_native">>, Provider, Modality, Model, Body)) of
        {ok, Reply} ->
            case apr_json:get(<<"body">>, Reply) of
                undefined -> {error, <<"the translator returned no response body">>};
                Translated -> {ok, Translated}
            end;
        {error, Reason} ->
            {error, Reason}
    end.

%% The `created' the OpenAI envelope will report is supplied here rather than read from a
%% clock in Rust, so the port program stays a pure function of its input.
request(Op, Provider, Modality, Model, Body) ->
    {obj, [{<<"op">>, Op},
           {<<"provider">>, Provider},
           {<<"modality">>, atom_to_binary(Modality, utf8)},
           {<<"model">>, Model},
           {<<"created">>, erlang:system_time(second)},
           {<<"body">>, Body}]}.

convert(Request) ->
    try gen_server:call(?MODULE, {convert, apr_json:encode(Request)}, ?CALL_TIMEOUT) of
        {ok, Frame} -> reply(Frame);
        {error, Reason} -> {error, Reason}
    catch
        %% Not started, restarting, or overwhelmed — a missing translator, no different in
        %% kind from an unreachable vendor.
        exit:Reason -> {error, describe(<<"the translator is unavailable">>, Reason)}
    end.

reply(Frame) ->
    case apr_json:decode(Frame) of
        {ok, Decoded} ->
            case apr_json:get(<<"ok">>, Decoded) of
                true -> {ok, Decoded};
                _ -> {error, refusal(apr_json:get(<<"error">>, Decoded))}
            end;
        {error, _Reason} ->
            {error, <<"the translator's reply could not be read">>}
    end.

refusal(Reason) when is_binary(Reason), byte_size(Reason) > 0 -> Reason;
refusal(_Other) -> <<"the translator refused the conversion">>.

%% --- the port ----------------------------------------------------------------

-spec init([]) -> {ok, state()}.
init([]) ->
    %% Trapping exits is what turns a dead port into a state change instead of a crash: the
    %% next conversion reopens it, and a node whose translator keeps dying keeps serving.
    process_flag(trap_exit, true),
    {ok, #{port => undefined}}.

handle_call({convert, Frame}, _From, State) ->
    case ensure_port(State) of
        {error, Reason, Failed} ->
            {reply, {error, Reason}, Failed};
        {ok, Port, Open} ->
            Port ! {self(), {command, Frame}},
            await(Port, Open)
    end;
handle_call(_Request, _From, State) ->
    {reply, {error, <<"unknown request">>}, State}.

handle_cast(_Message, State) ->
    {noreply, State}.

%% A port that dies between calls is simply forgotten; the next conversion opens a new one.
handle_info({'EXIT', Port, _Reason}, #{port := Port} = State) ->
    {noreply, State#{port => undefined}};
handle_info({Port, {exit_status, _Status}}, #{port := Port} = State) ->
    {noreply, close(State)};
handle_info(_Message, State) ->
    {noreply, State}.

terminate(_Reason, State) ->
    _ = close(State),
    ok.

await(Port, State) ->
    receive
        {Port, {data, Frame}} ->
            {reply, {ok, Frame}, State};
        {Port, {exit_status, Status}} ->
            {reply, {error, exited(Status)}, forget(State)};
        {'EXIT', Port, Reason} ->
            {reply, {error, describe(<<"the translator died">>, Reason)}, forget(State)}
    after ?PORT_TIMEOUT ->
        %% A hung translator is worse than an absent one — close it so the next request gets
        %% a fresh process rather than queueing behind this one's silence.
        {reply, {error, <<"the translator did not answer in time">>}, close(State)}
    end.

ensure_port(#{port := Port} = State) when is_port(Port) ->
    {ok, Port, State};
ensure_port(State) ->
    case executable() of
        undefined ->
            {error, <<"no translator is available on this node">>, State};
        Executable ->
            try open_port({spawn_executable, Executable},
                          [{packet, 4}, binary, exit_status, hide]) of
                Port -> {ok, Port, State#{port => Port}}
            catch
                _Class:Reason ->
                    {error, describe(<<"the translator could not be started">>, Reason), State}
            end
    end.

close(#{port := Port} = State) when is_port(Port) ->
    try erlang:port_close(Port) catch _:_ -> ok end,
    forget(State);
close(State) ->
    State.

%% Drain whatever the departing port still had to say, so a stale frame can never be read as
%% the answer to the next request.
forget(#{port := Port} = State) when is_port(Port) ->
    flush(Port),
    State#{port => undefined};
forget(State) ->
    State#{port => undefined}.

flush(Port) ->
    receive
        {Port, _Any} -> flush(Port);
        {'EXIT', Port, _Reason} -> flush(Port)
    after 0 ->
        ok
    end.

exited(Status) ->
    unicode:characters_to_binary(
      io_lib:format("the translator exited with status ~p", [Status])).

describe(Prefix, Reason) ->
    unicode:characters_to_binary(io_lib:format("~ts: ~p", [Prefix, Reason])).
