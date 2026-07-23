%%% @doc The terminal tier: deterministic, offline, free — the Erlang mirror of
%%% `placeholder.py'.
%%%
%%% A pure function of the request: the same payload yields byte-identical output on any
%%% node, which is what makes the always-completes tier something a conformance scenario can
%%% pin. Responses are OpenAI-shaped so a caller cannot tell the tier from the envelope; the
%%% resolved tier is reported out of band (the `agora'/`X-Agora-Tier' surface). Every media
%%% artifact is self-declaring — it carries `"placeholder": true' — so a stand-in can never
%%% be mistaken for a real render.
-module(apr_placeholder).

-export([complete/3, digest/1, media_type/1]).

%% Bytes of synthetic payload a media placeholder emits — a stand-in artifact, not a render.
-define(MEDIA_BYTES, 256).

%% @doc A stable lowercase-hex sha256 of `Payload', over its canonical JSON form (sorted
%% keys, compact separators) — the exact bytes `placeholder.py::digest' hashes.
%%
%% The digest is the one place key ORDER is deliberately discarded: two callers who send the
%% same fields in a different order must get the same stand-in back.
-spec digest(term()) -> binary().
digest(Payload) ->
    bin_to_hex(crypto:hash(sha256, apr_json:encode(apr_json:canonical(Payload)))).

%% @doc modality -> the media type of its stand-in artifact (KMI §2 `media_type').
-spec media_type(atom()) -> binary().
media_type(image) -> <<"image/png">>;
media_type(speech) -> <<"audio/wav">>;
media_type(music) -> <<"audio/wav">>;
media_type(video) -> <<"video/mp4">>;
media_type(_) -> <<"application/octet-stream">>.

%% @doc The deterministic response for `Modality'. Never raises, never spends.
%%
%% An ordered object, in `placeholder.py''s literal key order — the response body is relayed
%% to the caller verbatim, so its bytes are part of the contract.
-spec complete(atom(), term(), binary()) -> apr_json:object().
complete(text, Payload, Model) -> text_response(Payload, Model);
complete(Modality, Payload, Model) -> media_response(Modality, Payload, Model).

text_response(Payload, Model) ->
    Fp = digest(Payload),
    Short = binary:part(Fp, 0, 12),
    Content = <<"[agora placeholder] no paid, mlx-serve or local backend was available; "
                "this is a deterministic stand-in for request ", Short/binary, ".">>,
    {obj,
     [{<<"id">>, <<"chatcmpl-placeholder-", (binary:part(Fp, 0, 16))/binary>>},
      {<<"object">>, <<"chat.completion">>},
      {<<"created">>, 0},
      {<<"model">>, Model},
      {<<"choices">>,
       [{obj, [{<<"index">>, 0},
               {<<"message">>, {obj, [{<<"role">>, <<"assistant">>},
                                      {<<"content">>, Content}]}},
               {<<"finish_reason">>, <<"stop">>}]}]},
      %% Zero, not absent: the placeholder consumes no tokens, and a cost estimator must be
      %% able to read that off the response like any other tier's.
      {<<"usage">>, {obj, [{<<"prompt_tokens">>, 0},
                           {<<"completion_tokens">>, 0},
                           {<<"total_tokens">>, 0}]}}]}.

media_response(Modality, Payload, Model) ->
    Fp = digest(Payload),
    Seed = crypto:hash(sha256, Fp),
    Repeat = (?MEDIA_BYTES div byte_size(Seed)) + 1,
    Body = binary:part(binary:copy(Seed, Repeat), 0, ?MEDIA_BYTES),
    {obj,
     [{<<"id">>, <<"gen-placeholder-", (binary:part(Fp, 0, 16))/binary>>},
      {<<"object">>, <<(atom_to_binary(Modality, utf8))/binary, ".generation">>},
      {<<"created">>, 0},
      {<<"model">>, Model},
      {<<"data">>,
       [{obj, [{<<"b64_json">>, base64:encode(Body)},
               {<<"media_type">>, media_type(Modality)},
               {<<"placeholder">>, true},
               {<<"digest">>, Fp}]}]}]}.

bin_to_hex(Bin) -> << <<(nibble(N))>> || <<N:4>> <= Bin >>.

nibble(N) when N < 10 -> $0 + N;
nibble(N) -> ($a - 10) + N.
