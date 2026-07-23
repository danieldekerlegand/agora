%%% @doc A tiny JSON encoder — enough for the router's surface, with two guarantees the
%%% byte-for-byte contract needs.
%%%
%%% * **Canonical form for digests.** A bare `map()' is encoded with its keys *sorted* and
%%%   compact separators (`","'/`":"'), matching Python's
%%%   `json.dumps(payload, sort_keys=True, separators=(",", ":"))' — the exact bytes
%%%   `placeholder.py::digest' hashes.
%%% * **Insertion order for responses.** An `{obj, [{Key, Value}, ...]}' tuple preserves the
%%%   given key order, matching Starlette's `JSONResponse` (compact separators,
%%%   `ensure_ascii=False', insertion order) so a response body can be reproduced verbatim.
%%%
%%% Not a general JSON library: it encodes only the shapes the router emits (binaries for
%%% strings, integers, floats, booleans, `null', lists, maps and ordered objects).
-module(apr_json).

-export([encode/1]).

-spec encode(term()) -> binary().
encode(Term) -> iolist_to_binary(enc(Term)).

enc(true) -> <<"true">>;
enc(false) -> <<"false">>;
enc(null) -> <<"null">>;
enc(undefined) -> <<"null">>;
enc(V) when is_integer(V) -> integer_to_binary(V);
enc(V) when is_float(V) -> float_to_binary(V, [short]);
enc(V) when is_binary(V) -> enc_string(V);
enc({obj, KVs}) when is_list(KVs) -> enc_object(KVs);
enc(V) when is_map(V) ->
    %% A bare map has no inherent order — sort the keys so the bytes are canonical.
    enc_object([{K, maps:get(K, V)} || K <- lists:sort(maps:keys(V))]);
enc(V) when is_list(V) -> enc_array(V);
enc(V) when is_atom(V) -> enc_string(atom_to_binary(V, utf8)).

enc_array(List) -> [$[, lists:join($,, [enc(E) || E <- List]), $]].

enc_object(KVs) ->
    [${, lists:join($,, [[enc_key(K), $:, enc(V)] || {K, V} <- KVs]), $}].

enc_key(K) when is_binary(K) -> enc_string(K);
enc_key(K) when is_atom(K) -> enc_string(atom_to_binary(K, utf8)).

enc_string(B) -> [$", escape(B), $"].

%% Bytes >= 16#20 (including every UTF-8 continuation byte) pass through untouched, so a
%% non-ASCII string is emitted as raw UTF-8 — Starlette's `ensure_ascii=False'.
escape(<<>>) -> [];
escape(<<$", R/binary>>) -> [$\\, $" | escape(R)];
escape(<<$\\, R/binary>>) -> [$\\, $\\ | escape(R)];
escape(<<$\n, R/binary>>) -> [$\\, $n | escape(R)];
escape(<<$\r, R/binary>>) -> [$\\, $r | escape(R)];
escape(<<$\t, R/binary>>) -> [$\\, $t | escape(R)];
escape(<<C, R/binary>>) when C < 16#20 ->
    [io_lib:format("\\u~4.16.0b", [C]) | escape(R)];
escape(<<C, R/binary>>) -> [C | escape(R)].
