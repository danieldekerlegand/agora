%%% @doc One invocation, three transports — the Erlang mirror of `invoke.py'.
%%%
%%% KCB §4 maps the **invoke** verb onto an MCP tool call and an A2A task ({@link apr_mcp},
%%% {@link apr_a2a}). Both arrive loosely shaped — a tool's `arguments' object, a message's
%%% text and data parts — and both have to end up calling the same {@link
%%% apr_router:complete/3} the `/v1' routes call, with the same ladder, the same ceiling and
%%% the same always-completes contract. This module is that translation, kept in one place so
%%% the two transports cannot disagree about what `generate.image' takes or what came back.
%%%
%%% Three rules it holds to, carried over verbatim:
%%%
%%% * **The capability name is the modality.** `generate.<modality>' is what the manifest
%%%   advertises (KCB §2), so it is what an MCP tool is named and what an A2A message selects.
%%%   There is no second vocabulary to keep in step.
%%% * **Ids are derived, never drawn.** An MCP resource uri, an A2A task id and an artifact id
%%%   are all functions of the request or of the bytes they name. A random id would make two
%%%   identical requests differ on the wire, and `apr_conformance_SUITE' could not hold both
%%%   routers to one surface.
%%% * **Artifacts travel with a content digest.** `sha256:<hex>' over the decoded bytes —
%%%   self-verifying (KCB §4 `fetch', delta G), and *not* the placeholder's own `digest'
%%%   field, which fingerprints the request rather than the response.
%%%
%%% Nothing here dials anything or reaches for the network; it is pure shape.
-module(apr_invoke).

-export([capability_prefix/0, capabilities/0, capability_name/1, qualify/1, modality_for/1,
         known/0, prompt_key/1, prompt_aliases/0, payload_for/2, payload_for/3,
         identifier/3, artifacts_of/2, artifact_uri/1, artifact_filename/1,
         text_of/1, fallback_text/1, is_object/1]).
-export([parse_error/0, invalid_request/0, method_not_found/0, invalid_params/0,
         rpc_result/2, rpc_error/3]).

-export_type([artifact/0]).

-type modality() :: atom().

%% One media-plane output of a generation, by media type, digest and inline bytes. `data' is
%% base64 exactly as the upstream body carried it; `digest' is `sha256:<hex>' over the
%% DECODED bytes, so integrity self-verifies (KCB §4, delta G).
-type artifact() :: #{media_type := binary(), digest := binary(), data := binary()}.

%% Capability names are `generate.<modality>' — the KCB §2 manifest's own vocabulary. Spelled
%% as a string literal so it can stand in a binary PATTERN as well as in a construction.
-define(CAPABILITY_PREFIX, "generate.").

%% The scheme of an artifact reference. A content id, deliberately *not* an `http' address:
%% this router serves no CAS fetch route on the mirrored surface, and a manifest-shaped
%% promise it cannot answer is worse than none (ADR-0001 decision 3). The bytes ride alongside.
-define(ARTIFACT_SCHEME, "agora:artifact:").

%% --- the capability vocabulary ----------------------------------------------

-spec capability_prefix() -> binary().
capability_prefix() -> <<?CAPABILITY_PREFIX>>.

%% @doc Every capability this router offers, in ladder-modality order.
-spec capabilities() -> [binary()].
capabilities() -> [capability_name(M) || M <- apr_ladder:modalities()].

%% @doc The KCB capability a modality is invoked as.
-spec capability_name(modality()) -> binary().
capability_name(Modality) ->
    <<?CAPABILITY_PREFIX, (atom_to_binary(Modality, utf8))/binary>>.

%% @doc A selector spelled either as a capability or as a bare modality, as a capability.
-spec qualify(binary()) -> binary().
qualify(<<?CAPABILITY_PREFIX, _/binary>> = Named) -> Named;
qualify(Named) -> <<?CAPABILITY_PREFIX, Named/binary>>.

%% @doc The modality a capability name selects, or a refusal that names the ones that exist.
-spec modality_for(term()) -> {ok, modality()} | {error, binary()}.
modality_for(<<?CAPABILITY_PREFIX, Rest/binary>> = Capability) ->
    case [M || M <- apr_ladder:modalities(), atom_to_binary(M, utf8) =:= Rest] of
        [Modality] -> {ok, Modality};
        [] -> {error, unknown_capability(Capability)}
    end;
modality_for(Capability) ->
    {error, unknown_capability(Capability)}.

%% @doc The capability vocabulary, for a refusal message.
-spec known() -> binary().
known() -> iolist_to_binary(lists:join(<<", ">>, capabilities())).

unknown_capability(Capability) ->
    iolist_to_binary([<<"unknown capability ">>, apr_json:python_repr(Capability),
                      <<" — this router offers "/utf8>>, known()]).

%% --- the request ------------------------------------------------------------

%% @doc modality -> the OpenAI-shaped key its prompt belongs under, once translated.
-spec prompt_key(modality()) -> binary().
prompt_key(text) -> <<"messages">>;
prompt_key(image) -> <<"prompt">>;
prompt_key(speech) -> <<"input">>;
prompt_key(music) -> <<"prompt">>;
prompt_key(video) -> <<"prompt">>.

%% @doc Argument keys a caller may hand a prompt under. A transport client that knows only the
%% manifest's port shapes (`prompt-text', `chat-messages') is as welcome as one that knows
%% OpenAI's spelling; whichever it uses lands under {@link prompt_key/1}.
-spec prompt_aliases() -> [binary()].
prompt_aliases() ->
    [<<"prompt">>, <<"input">>, <<"text">>, <<"prompt-text">>, <<"chat-messages">>].

-spec payload_for(modality(), term()) -> apr_json:object().
payload_for(Modality, Arguments) -> payload_for(Modality, Arguments, <<>>).

%% @doc The OpenAI-shaped body `Arguments' (plus any `Prompt') mean for `Modality'.
%%
%% Every key that is not a prompt alias survives verbatim — `model', `size', `voice',
%% `budget_units' — so a caller on MCP or A2A can steer a generation exactly as one on `/v1'
%% can. An explicitly OpenAI-spelled value always wins over a translated alias, and a request
%% that carries no prompt at all is passed on as-is rather than invented for.
-spec payload_for(modality(), term(), binary()) -> apr_json:object().
payload_for(Modality, Arguments, Prompt) ->
    Key = prompt_key(Modality),
    Aliases = prompt_aliases(),
    Kept = {obj, [{K, V} || {K, V} <- apr_json:kvs(Arguments), not lists:member(K, Aliases)]},
    case apr_json:is_key(Key, Arguments) of
        true ->
            %% `payload[key] = arguments[key]': an OpenAI-spelled value keeps the position it
            %% already holds (`messages') or lands at the end (`prompt', `input').
            apr_json:put(Key, apr_json:get(Key, Arguments), Kept);
        false ->
            case spoken(Prompt, Arguments, Aliases) of
                <<>> -> Kept;
                Spoken -> apr_json:put(Key, prompt_value(Modality, Spoken), Kept)
            end
    end.

prompt_value(text, Spoken) ->
    [{obj, [{<<"role">>, <<"user">>}, {<<"content">>, Spoken}]}];
prompt_value(_Modality, Spoken) ->
    Spoken.

spoken(<<>>, Arguments, Aliases) -> first_string(Aliases, Arguments);
spoken(Prompt, _Arguments, _Aliases) -> Prompt.

first_string([], _Arguments) -> <<>>;
first_string([Key | Rest], Arguments) ->
    case apr_json:get(Key, Arguments) of
        Value when is_binary(Value), Value =/= <<>> -> Value;
        _Other -> first_string(Rest, Arguments)
    end.

%% @doc A stable id for one request — the same request always names itself the same way.
%%
%% The fingerprint is taken over the canonical (sorted-key, compact) JSON of
%% `{"modality": ..., "payload": ...}', the exact bytes `invoke.py::identifier' hashes.
-spec identifier(binary(), modality(), term()) -> binary().
identifier(Prefix, Modality, Payload) ->
    Canonical = apr_json:encode(
                  apr_json:canonical(
                    {obj, [{<<"modality">>, atom_to_binary(Modality, utf8)},
                           {<<"payload">>, Payload}]})),
    Fingerprint = bin_to_hex(crypto:hash(sha256, Canonical)),
    <<Prefix/binary, "-", (binary:part(Fingerprint, 0, 16))/binary>>.

%% --- the response -----------------------------------------------------------

%% @doc The text an OpenAI-shaped response carries, joined across its choices.
-spec text_of(term()) -> binary().
text_of(Response) ->
    case apr_json:get(<<"choices">>, Response) of
        Choices when is_list(Choices) ->
            iolist_to_binary(
              lists:join(<<"\n">>,
                         [Content || Choice <- Choices,
                                     Content <- [content_of(Choice)],
                                     is_binary(Content), Content =/= <<>>]));
        _NotAList -> <<>>
    end.

%% A choice speaks either through a `message' object or through a bare `text'.
content_of(Choice) ->
    Message = apr_json:get(<<"message">>, Choice),
    case is_object(Message) of
        true -> apr_json:get(<<"content">>, Message);
        false -> apr_json:get(<<"text">>, Choice)
    end.

%% @doc The inline media outputs of a response, digested. Entries without bytes are skipped.
-spec artifacts_of(modality(), term()) -> [artifact()].
artifacts_of(Modality, Response) ->
    case apr_json:get(<<"data">>, Response) of
        Data when is_list(Data) -> lists:flatmap(fun(E) -> artifact(Modality, E) end, Data);
        _NotAList -> []
    end.

artifact(Modality, Entry) ->
    case apr_json:get(<<"b64_json">>, Entry) of
        Encoded when is_binary(Encoded) ->
            case decode_base64(Encoded) of
                {ok, Raw} ->
                    [#{media_type => media_type(Modality, Entry),
                       digest => <<"sha256:", (bin_to_hex(crypto:hash(sha256, Raw)))/binary>>,
                       data => Encoded}];
                error ->
                    %% Not decodable, so not describable — a digest over bytes we do not have
                    %% would be a lie. The upstream body still reaches the caller via
                    %% {@link fallback_text/1}.
                    []
            end;
        _NotBytes -> []
    end.

media_type(Modality, Entry) ->
    case apr_json:get(<<"media_type">>, Entry) of
        Declared when is_binary(Declared), Declared =/= <<>> -> Declared;
        _Absent -> apr_placeholder:media_type(Modality)
    end.

decode_base64(Encoded) ->
    try {ok, base64:decode(Encoded)}
    catch _Class:_Reason -> error
    end.

%% @doc The content id a transport references an artifact by.
-spec artifact_uri(artifact()) -> binary().
artifact_uri(#{digest := Digest}) -> <<?ARTIFACT_SCHEME, Digest/binary>>.

%% @doc A file name a client can save an artifact under, keyed by its own digest.
-spec artifact_filename(artifact()) -> binary().
artifact_filename(#{digest := Digest, media_type := MediaType}) ->
    Suffix = case lists:last(binary:split(MediaType, <<"/">>, [global])) of
                 <<>> -> <<"bin">>;
                 Tail -> Tail
             end,
    <<(dashed(Digest))/binary, ".", Suffix/binary>>.

%% `sha256:<hex>' as it is spelled inside an id — a colon is not a filename character.
dashed(Digest) -> binary:replace(Digest, <<":">>, <<"-">>, [global]).

%% @doc The upstream body itself, when it carried neither text nor inline artifacts.
%%
%% A backend that answers with hosted URLs rather than bytes (a real image vendor does) would
%% otherwise reach an MCP or A2A caller as an empty result. Handing back what the provider
%% actually said is the honest degrade; the keys are sorted so the rendering is the same on
%% every host and in every language.
-spec fallback_text(term()) -> binary().
fallback_text(Response) -> apr_json:encode(apr_json:canonical(Response)).

%% @doc Whether a decoded JSON value is an object — what both surfaces require of a request.
-spec is_object(term()) -> boolean().
is_object({obj, KVs}) when is_list(KVs) -> true;
is_object(Map) when is_map(Map) -> true;
is_object(_Other) -> false.

%% --- JSON-RPC ----------------------------------------------------------------
%% Both transports are JSON-RPC 2.0 over one POST, so the envelope is shared: a transport that
%% spelled an error differently from its sibling would make the same refusal read as two
%% different contracts.

-spec parse_error() -> integer().
parse_error() -> -32700.

-spec invalid_request() -> integer().
invalid_request() -> -32600.

-spec method_not_found() -> integer().
method_not_found() -> -32601.

-spec invalid_params() -> integer().
invalid_params() -> -32602.

%% @doc A JSON-RPC success envelope.
-spec rpc_result(term(), apr_json:object()) -> apr_json:object().
rpc_result(Id, Payload) ->
    {obj, [{<<"jsonrpc">>, <<"2.0">>}, {<<"id">>, Id}, {<<"result">>, Payload}]}.

%% @doc A JSON-RPC failure envelope. The reason is the provider's own, never a bare code.
-spec rpc_error(term(), integer(), binary()) -> apr_json:object().
rpc_error(Id, Code, Message) ->
    {obj, [{<<"jsonrpc">>, <<"2.0">>}, {<<"id">>, Id},
           {<<"error">>, {obj, [{<<"code">>, Code}, {<<"message">>, Message}]}}]}.

bin_to_hex(Bin) -> << <<(nibble(N))>> || <<N:4>> <= Bin >>.

nibble(N) when N < 10 -> $0 + N;
nibble(N) -> ($a - 10) + N.
