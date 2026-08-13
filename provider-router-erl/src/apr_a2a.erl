%%% @doc The A2A server surface — the `invoke' verb as a task (KCB §4/§6). The Erlang mirror
%%% of `a2a.py'.
%%%
%%% The other half of the transport pair ({@link apr_mcp} is the first): a peer reads this
%%% router's AgentCard, dials the address the card carries, and sends one JSON-RPC
%%% `message/send'. It gets back a **completed Task** — this router does no long-running work,
%%% so a task is finished the moment it is answered and there is no task store to poll. The
%%% wire shapes are A2A's own (camelCase keys, `kind'-tagged parts, a kebab-case task state),
%%% which is what lets the console's A2A wire (`console/src/kcs/a2a-wire.ts') read the reply
%%% unchanged.
%%%
%%% **Which capability.** A2A carries no capability field, so the message says which one it
%%% wants: `metadata.capability' (or `metadata.modality'), else the same key on a `data' part,
%%% else `generate.text' — the reading a conversational message deserves. Text parts become the
%%% prompt; data parts become the rest of the request, so `size', `voice' and a `budget_units'
%%% ceiling all reach the ladder exactly as they do on `/v1'.
%%%
%%% **It never relays.** A message addressed to somebody else (`toAgent' naming another peer)
%%% is *refused*, not forwarded: the fabric's rule is that peers dial each other directly at
%%% the address their own manifest advertises, and nothing routes through a middle (ADR-0001
%%% decisions 3/7). A router that quietly forwarded would make itself exactly the hub the
%%% topology forbids.
%%%
%%% **Always completes.** The task state is `completed' whenever the ladder answered, which is
%%% always — the placeholder is terminal, offline and free. A JSON-RPC error means the
%%% *request* was malformed, which is the only thing {@link apr_router:complete/3} refuses.
-module(apr_a2a).

-export([path/0, protocol_version/0, send_method/0, capability_keys/0, default_modality/0,
         handle/1, handle/2]).

-type modality() :: atom().

%% Where the A2A surface is served — the AgentCard's own `url', and the manifest's
%% `endpoints.a2a'.
-define(A2A_PATH, <<"/a2a">>).

%% The A2A protocol revision this surface answers in. Matches the newest the console's wire
%% advertises (`A2A_PROTOCOL_VERSIONS' in `console/src/kcs/a2a-wire.ts').
-define(A2A_PROTOCOL_VERSION, <<"1.1">>).

%% The one method served. `message/stream', `tasks/get' and the rest are refused by name rather
%% than stubbed: a task here is complete when it is answered, so there is nothing to stream and
%% nothing to look up later.
-define(SEND_METHOD, <<"message/send">>).

%% The modality a message that names none is read as — a message is conversation by default.
-define(DEFAULT_MODALITY, text).

-spec path() -> binary().
path() -> ?A2A_PATH.

-spec protocol_version() -> binary().
protocol_version() -> ?A2A_PROTOCOL_VERSION.

-spec send_method() -> binary().
send_method() -> ?SEND_METHOD.

%% @doc Message-metadata keys that select a capability, in the order they are consulted.
-spec capability_keys() -> [binary()].
capability_keys() -> [<<"capability">>, <<"modality">>].

-spec default_modality() -> modality().
default_modality() -> ?DEFAULT_MODALITY.

-spec handle(term()) -> {reply, apr_json:object()} | no_reply.
handle(Request) -> handle(Request, undefined).

%% @doc Answer one JSON-RPC request. `no_reply' means a notification — say nothing back.
-spec handle(term(), float() | undefined) -> {reply, apr_json:object()} | no_reply.
handle(Request, Ceiling) ->
    case apr_invoke:is_object(Request) of
        false ->
            {reply, apr_invoke:rpc_error(null, apr_invoke:invalid_request(),
                                         <<"a JSON-RPC request must be an object">>)};
        true ->
            requested(apr_json:get(<<"method">>, Request), Request, Ceiling)
    end.

requested(Method, Request, Ceiling) when is_binary(Method) ->
    case apr_json:is_key(<<"id">>, Request) of
        false -> no_reply;
        true -> {reply, method(Method, apr_json:get(<<"id">>, Request), Request, Ceiling)}
    end;
requested(_NotAMethod, Request, _Ceiling) ->
    {reply, apr_invoke:rpc_error(apr_json:get(<<"id">>, Request, null),
                                 apr_invoke:invalid_request(),
                                 <<"a JSON-RPC request must name a method">>)}.

method(?SEND_METHOD, Id, Request, Ceiling) ->
    send(Id, params(Request), Ceiling);
method(Method, Id, _Request, _Ceiling) ->
    apr_invoke:rpc_error(
      Id, apr_invoke:method_not_found(),
      iolist_to_binary([<<"this router serves no A2A method ">>, apr_json:python_repr(Method),
                        <<" — it serves "/utf8>>, ?SEND_METHOD,
                        <<", and a task is complete when it is answered, so there is none to "
                          "stream or fetch later">>])).

params(Request) ->
    Params = apr_json:get(<<"params">>, Request),
    case apr_invoke:is_object(Params) of
        true -> Params;
        false -> {obj, []}
    end.

send(Id, Params, Ceiling) ->
    Message = apr_json:get(<<"message">>, Params),
    case apr_invoke:is_object(Message) of
        false ->
            apr_invoke:rpc_error(Id, apr_invoke:invalid_params(),
                                 <<?SEND_METHOD/binary, " must carry a message">>);
        true ->
            addressed(Id, Message, Ceiling)
    end.

%% A message for somebody else is refused here, before anything is read out of it.
addressed(Id, Message, Ceiling) ->
    Identity = apr:identity(),
    case apr_json:get(<<"toAgent">>, Message) of
        Addressee when is_binary(Addressee), Addressee =/= <<>>, Addressee =/= Identity ->
            apr_invoke:rpc_error(
              Id, apr_invoke:invalid_params(),
              iolist_to_binary([<<"this is ">>, Identity, <<", not ">>,
                                apr_json:python_repr(Addressee),
                                <<" — dial that peer directly at the address its own manifest "
                                  "advertises; this router relays nothing (ADR-0001 "
                                  "decision 3)"/utf8>>]));
        _Ours ->
            dispatch(Id, Message, Ceiling)
    end.

dispatch(Id, Message, HeaderCeiling) ->
    Metadata = object_or_empty(apr_json:get(<<"metadata">>, Message)),
    {Arguments, Prompt} = read_parts(Message),
    case selected(Metadata, Arguments, HeaderCeiling) of
        {error, Reason} ->
            apr_invoke:rpc_error(Id, apr_invoke:invalid_params(), Reason);
        {ok, Modality, Rest, Ceiling} ->
            complete(Id, Modality, apr_invoke:payload_for(Modality, Rest, Prompt),
                     Ceiling, Message)
    end.

%% Which ladder this message walks, and under what ceiling — both refusable, both refused
%% before the walk starts.
selected(Metadata, Arguments, HeaderCeiling) ->
    try
        {Modality, Rest} = take_modality(Metadata, Arguments),
        {ok, Modality, Rest, ceiling(Metadata, HeaderCeiling)}
    catch
        throw:{invoke_error, Reason} -> {error, Reason};
        throw:{ceiling_error, Reason} -> {error, Reason}
    end.

complete(Id, Modality, Payload, Ceiling, Message) ->
    try apr_router:complete(Modality, Payload, options(Ceiling)) of
        Completion -> apr_invoke:rpc_result(Id, task(Modality, Payload, Completion, Message))
    catch
        throw:{ceiling_error, Reason} ->
            apr_invoke:rpc_error(Id, apr_invoke:invalid_params(), Reason)
    end.

options(undefined) -> #{};
options(Ceiling) -> #{budget_units => Ceiling}.

%% One completion as a finished A2A Task.
%%
%% The ids are derived from the request rather than drawn at random, so the same request always
%% names the same task — a stateless surface has nothing to hand a random id to, and the
%% conformance corpus needs the bytes to be a function of the request.
task(Modality, Payload, Completion, Request) ->
    Response = apr_router:response(Completion),
    Artifacts = apr_invoke:artifacts_of(Modality, Response),
    Spoken = spoken(apr_invoke:text_of(Response), Artifacts, Response),
    Status = status(Modality, Payload, Spoken),
    Task = {obj, [{<<"id">>, apr_invoke:identifier(<<"task">>, Modality, Payload)},
                  {<<"contextId">>, context(Request, Modality, Payload)},
                  {<<"kind">>, <<"task">>},
                  {<<"status">>, Status},
                  {<<"metadata">>,
                   {obj, [{<<"agora">>, apr_router:routing(Completion)},
                          {<<"protocolVersion">>, ?A2A_PROTOCOL_VERSION}]}}]},
    case Artifacts of
        [] -> Task;
        _ -> apr_json:put(<<"artifacts">>, [artifact(Modality, A) || A <- Artifacts], Task)
    end.

%% A response that spoke neither text nor bytes still has to say something.
spoken(<<>>, [], Response) -> apr_invoke:fallback_text(Response);
spoken(Text, _Artifacts, _Response) -> Text.

status(_Modality, _Payload, <<>>) ->
    {obj, [{<<"state">>, <<"completed">>}]};
status(Modality, Payload, Spoken) ->
    {obj, [{<<"state">>, <<"completed">>},
           {<<"message">>,
            {obj, [{<<"role">>, <<"agent">>},
                   {<<"parts">>, [{obj, [{<<"kind">>, <<"text">>}, {<<"text">>, Spoken}]}]},
                   {<<"messageId">>, apr_invoke:identifier(<<"msg">>, Modality, Payload)},
                   {<<"kind">>, <<"message">>},
                   {<<"fromAgent">>, apr:identity()}]}}]}.

context(Request, Modality, Payload) ->
    case apr_json:get(<<"contextId">>, Request) of
        Context when is_binary(Context), Context =/= <<>> -> Context;
        _Absent -> apr_invoke:identifier(<<"ctx">>, Modality, Payload)
    end.

%% A media output as an A2A Artifact: the bytes as a file part, the digest alongside.
%%
%% `file' carries bytes rather than a uri because the two are alternatives in A2A and a uri
%% would have to be an address this router serves — it serves no artifact-fetch route on the
%% mirrored surface (ADR-0001 decision 3, no promise it cannot answer). The content id rides in
%% the artifact's own metadata instead, where it stays verifiable against the bytes.
artifact(Modality, #{media_type := MediaType, digest := Digest, data := Data} = Artifact) ->
    {obj, [{<<"artifactId">>,
            <<"artifact-", (binary:replace(Digest, <<":">>, <<"-">>, [global]))/binary>>},
           {<<"name">>, apr_invoke:capability_name(Modality)},
           {<<"parts">>,
            [{obj, [{<<"kind">>, <<"file">>},
                    {<<"file">>, {obj, [{<<"name">>, apr_invoke:artifact_filename(Artifact)},
                                        {<<"mimeType">>, MediaType},
                                        {<<"bytes">>, Data}]}}]}]},
           {<<"metadata">>, {obj, [{<<"digest">>, Digest}]}}]}.

%% `{Arguments, Prompt}' — data parts merged into a request, text parts joined.
read_parts(Message) ->
    Parts = case apr_json:get(<<"parts">>, Message) of
                List when is_list(List) -> List;
                _NotAList -> []
            end,
    {Arguments, Spoken} = lists:foldl(fun read_part/2, {{obj, []}, []}, Parts),
    {Arguments, iolist_to_binary(lists:join(<<"\n">>, lists:reverse(Spoken)))}.

read_part(Part, {Arguments, Spoken} = Acc) ->
    case apr_invoke:is_object(Part) andalso apr_json:get(<<"kind">>, Part) of
        <<"text">> ->
            case apr_json:get(<<"text">>, Part) of
                Text when is_binary(Text), Text =/= <<>> -> {Arguments, [Text | Spoken]};
                _Empty -> Acc
            end;
        <<"data">> ->
            Data = apr_json:get(<<"data">>, Part),
            case apr_invoke:is_object(Data) of
                true -> {merge(Data, Arguments), Spoken};
                false -> Acc
            end;
        _Other ->
            Acc
    end.

%% `dict.update': a repeated key keeps its position and takes the new value.
merge(Data, Arguments) ->
    lists:foldl(fun({Key, Value}, Acc) -> apr_json:put(Key, Value, Acc) end,
                Arguments, apr_json:kvs(Data)).

%% The capability this message selects, named in the metadata or on a data part.
%%
%% A selector on a data part is *taken out* of the request as it is read: it is agora's own
%% extension, like `budget_units', naming which ladder to walk rather than anything an upstream
%% vendor asked for. Leaving it in would forward a key no provider declares.
take_modality(Metadata, Arguments) ->
    case selector(capability_keys(), Metadata) of
        {ok, _Key, Named} ->
            {capability(Named), Arguments};
        none ->
            case selector(capability_keys(), Arguments) of
                {ok, Key, Named} -> {capability(Named), apr_json:remove(Key, Arguments)};
                none -> {?DEFAULT_MODALITY, Arguments}
            end
    end.

selector([], _Object) -> none;
selector([Key | Rest], Object) ->
    case apr_json:get(Key, Object) of
        Named when is_binary(Named), Named =/= <<>> -> {ok, Key, Named};
        _Other -> selector(Rest, Object)
    end.

%% The modality behind a selector, spelled either as a capability or as a bare modality.
capability(Named) ->
    case apr_invoke:modality_for(apr_invoke:qualify(Named)) of
        {ok, Modality} -> Modality;
        {error, Reason} -> throw({invoke_error, Reason})
    end.

%% The KCB §5 spend ceiling a message carried, header spelling or plain.
%%
%% The console's A2A wire keys message metadata by the header name the manifest advertises (A2A
%% has no headers of its own to put it in), so both spellings are read — and the match is
%% case-insensitive, because a header name is.
ceiling(Metadata, HeaderCeiling) ->
    %% Reversed, so a metadata object that spelled the same key twice resolves to the last one
    %% — which is the entry a Python dict comprehension would have kept.
    Lowered = lists:reverse([{string:lowercase(Key), Value}
                             || {Key, Value} <- apr_json:kvs(Metadata)]),
    Spellings = [string:lowercase(apr_cost:budget_header()), apr_cost:budget_key()],
    case stated(Spellings, Lowered) of
        {ok, Stated} -> apr_cost:parse_ceiling(Stated);
        none -> HeaderCeiling
    end.

stated([], _Lowered) -> none;
stated([Key | Rest], Lowered) ->
    case lists:keyfind(Key, 1, Lowered) of
        {_Key, Value} -> {ok, Value};
        false -> stated(Rest, Lowered)
    end.

object_or_empty(Value) ->
    case apr_invoke:is_object(Value) of
        true -> Value;
        false -> {obj, []}
    end.
