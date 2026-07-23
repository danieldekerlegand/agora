%%% @doc A tiny JSON codec — enough for the router's surface, with the guarantees the
%%% byte-for-byte contract needs.
%%%
%%% **Objects are ordered.** A JSON object is `{obj, [{Key, Value}, ...]}' and keeps the
%%% order it was authored (or decoded) in. That is what makes a response body reproducible:
%%% Starlette's `JSONResponse' emits a dict in *insertion* order with compact separators and
%%% `ensure_ascii=False', and an upstream provider's body must be relayed exactly as it
%%% arrived. A bare `map()' is still accepted and encoded with its keys **sorted** — the
%%% canonical form `placeholder.py::digest' hashes, and the only place order is not observed.
%%%
%%% {@link canonical/1} converts either representation into that sorted-key form, so a digest
%%% is computed over the same bytes Python's
%%% `json.dumps(payload, sort_keys=True, separators=(",", ":"))' produces.
%%%
%%% Not a general JSON library: it encodes the shapes the router emits (binaries for
%%% strings, integers, floats, booleans, `null', lists, maps and ordered objects) and decodes
%%% the shapes a caller or an upstream provider sends.
-module(apr_json).

-export([encode/1, decode/1, canonical/1]).
-export([get/2, get/3, is_key/2, put/3, put_front/3, remove/2, keys/1, kvs/1, from_map/1]).

-type object() :: {obj, [{binary(), term()}]}.
-export_type([object/0]).

%% --- encoding ---------------------------------------------------------------

-spec encode(term()) -> binary().
encode(Term) -> iolist_to_binary(enc(Term)).

enc(true) -> <<"true">>;
enc(false) -> <<"false">>;
enc(null) -> <<"null">>;
enc(undefined) -> <<"null">>;
enc(V) when is_integer(V) -> integer_to_binary(V);
enc(V) when is_float(V) -> python_float(V);
enc(V) when is_binary(V) -> enc_string(V);
enc({obj, KVs}) when is_list(KVs) -> enc_object(KVs);
enc(V) when is_map(V) ->
    %% A bare map has no inherent order — sort the keys so the bytes are canonical.
    enc_object([{K, maps:get(K, V)} || K <- lists:sort(maps:keys(V))]);
enc(V) when is_list(V) -> enc_array(V);
enc(V) when is_atom(V) -> enc_string(atom_to_binary(V, utf8)).

enc_array(List) -> [$[, lists:join($,, [enc(E) || E <- List]), $]].

%% `json.dumps' spells a float with Python's `repr'. Erlang's `[short]' picks the same
%% shortest round-tripping DIGITS but a different fixed-vs-exponential threshold, so
%% `1000.0' comes out `1.0e3' — two bytes that break a byte-for-byte manifest. This takes
%% the digits Erlang computed and re-renders them by CPython's rule: exponential only when
%% the decimal point sits at or left of position -4, or right of position 16.
python_float(F) ->
    {Sign, Digits, Decpt} = float_parts(F),
    case Digits of
        "0" -> <<Sign/binary, "0.0">>;
        _ when Decpt =< -4; Decpt > 16 -> <<Sign/binary, (exponential(Digits, Decpt))/binary>>;
        _ -> <<Sign/binary, (fixed(Digits, Decpt))/binary>>
    end.

%% `{Sign, Digits, Decpt}': the significant digits with no leading or trailing zeros, and
%% where the decimal point falls relative to their start (`1000.0' -> `"1"', 4).
float_parts(F) ->
    Short = binary_to_list(float_to_binary(F, [short])),
    {Sign, Unsigned} = case Short of
                           [$- | Rest] -> {<<"-">>, Rest};
                           _ -> {<<>>, Short}
                       end,
    {Mantissa, Exponent} = case string:split(Unsigned, "e") of
                               [M, E] -> {M, list_to_integer(E)};
                               [M] -> {M, 0}
                           end,
    {Int, Frac} = case string:split(Mantissa, ".") of
                      [I, Fr] -> {I, Fr};
                      [I] -> {I, ""}
                  end,
    {Digits, Decpt} = strip_leading_zeros(Int ++ Frac, length(Int) + Exponent),
    {Sign, strip_trailing_zeros(Digits), Decpt}.

strip_leading_zeros([$0, Next | Rest], Decpt) -> strip_leading_zeros([Next | Rest], Decpt - 1);
strip_leading_zeros(Digits, Decpt) -> {Digits, Decpt}.

strip_trailing_zeros(Digits) ->
    case lists:reverse(Digits) of
        [$0 | _] = Reversed ->
            case string:trim(Reversed, leading, "0") of
                "" -> "0";
                Trimmed -> lists:reverse(Trimmed)
            end;
        _ -> Digits
    end.

fixed(Digits, Decpt) when Decpt =< 0 ->
    list_to_binary("0." ++ lists:duplicate(-Decpt, $0) ++ Digits);
fixed(Digits, Decpt) when Decpt >= length(Digits) ->
    list_to_binary(Digits ++ lists:duplicate(Decpt - length(Digits), $0) ++ ".0");
fixed(Digits, Decpt) ->
    list_to_binary(lists:sublist(Digits, Decpt) ++ "." ++ lists:nthtail(Decpt, Digits)).

exponential([Lead | Rest], Decpt) ->
    Exponent = Decpt - 1,
    Fraction = case Rest of
                   "" -> "";
                   _ -> "." ++ Rest
               end,
    Marker = case Exponent < 0 of
                 true -> "e-";
                 false -> "e+"
             end,
    Magnitude = integer_to_list(abs(Exponent)),
    Padded = case length(Magnitude) of
                 1 -> "0" ++ Magnitude;
                 _ -> Magnitude
             end,
    list_to_binary([Lead | Fraction] ++ Marker ++ Padded).

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

%% --- decoding ---------------------------------------------------------------

%% @doc Decode a JSON document. Objects come back as {@type object()} in wire order, so a
%% relayed body can be re-encoded byte-identically. Never raises: a malformed document is
%% `{error, Reason}', which the generation handler turns into a 422.
-spec decode(binary()) -> {ok, term()} | {error, term()}.
decode(Bin) when is_binary(Bin) ->
    try
        {Value, Rest} = value(skip_ws(Bin)),
        case skip_ws(Rest) of
            <<>> -> {ok, Value};
            _ -> {error, trailing_data}
        end
    catch
        throw:{json, Reason} -> {error, Reason};
        error:_ -> {error, malformed_json}
    end.

value(<<${, R/binary>>) -> object_members(skip_ws(R), []);
value(<<$[, R/binary>>) -> array_elements(skip_ws(R), []);
value(<<$", R/binary>>) -> string_body(R, []);
value(<<"true", R/binary>>) -> {true, R};
value(<<"false", R/binary>>) -> {false, R};
value(<<"null", R/binary>>) -> {null, R};
value(<<>>) -> throw({json, empty_document});
value(B) -> number_token(B).

object_members(<<$}, R/binary>>, Acc) -> {{obj, lists:reverse(Acc)}, R};
object_members(<<$", R0/binary>>, Acc) ->
    {Key, R1} = string_body(R0, []),
    case skip_ws(R1) of
        <<$:, R2/binary>> ->
            {Value, R3} = value(skip_ws(R2)),
            case skip_ws(R3) of
                <<$,, R4/binary>> -> object_members(skip_ws(R4), [{Key, Value} | Acc]);
                <<$}, R4/binary>> -> {{obj, lists:reverse([{Key, Value} | Acc])}, R4};
                _ -> throw({json, expected_comma_or_brace})
            end;
        _ -> throw({json, expected_colon})
    end;
object_members(_Other, _Acc) -> throw({json, expected_object_key}).

array_elements(<<$], R/binary>>, Acc) -> {lists:reverse(Acc), R};
array_elements(B, Acc) ->
    {Value, R1} = value(B),
    case skip_ws(R1) of
        <<$,, R2/binary>> -> array_elements(skip_ws(R2), [Value | Acc]);
        <<$], R2/binary>> -> {lists:reverse([Value | Acc]), R2};
        _ -> throw({json, expected_comma_or_bracket})
    end.

%% Raw bytes accumulate untouched, so a UTF-8 string survives the round trip verbatim.
string_body(<<$", R/binary>>, Acc) -> {iolist_to_binary(lists:reverse(Acc)), R};
string_body(<<$\\, $u, A, B, C, D, R/binary>>, Acc) ->
    unescape_codepoint(hex4([A, B, C, D]), R, Acc);
string_body(<<$\\, C, R/binary>>, Acc) -> string_body(R, [unescape(C) | Acc]);
string_body(<<>>, _Acc) -> throw({json, unterminated_string});
string_body(<<C, R/binary>>, Acc) -> string_body(R, [C | Acc]).

%% A lead surrogate is only meaningful paired with its trail — join them before encoding.
unescape_codepoint(Lead, <<$\\, $u, A, B, C, D, R/binary>>, Acc)
  when Lead >= 16#D800, Lead =< 16#DBFF ->
    Trail = hex4([A, B, C, D]),
    case Trail >= 16#DC00 andalso Trail =< 16#DFFF of
        true ->
            Cp = 16#10000 + ((Lead - 16#D800) bsl 10) + (Trail - 16#DC00),
            string_body(R, [utf8(Cp) | Acc]);
        false ->
            string_body(<<$\\, $u, A, B, C, D, R/binary>>, [utf8(16#FFFD) | Acc])
    end;
unescape_codepoint(Cp, R, Acc) when Cp >= 16#D800, Cp =< 16#DFFF ->
    string_body(R, [utf8(16#FFFD) | Acc]);
unescape_codepoint(Cp, R, Acc) ->
    string_body(R, [utf8(Cp) | Acc]).

utf8(Cp) -> <<Cp/utf8>>.

hex4(Digits) ->
    try list_to_integer(Digits, 16)
    catch error:_ -> throw({json, bad_unicode_escape})
    end.

unescape($") -> $";
unescape($\\) -> $\\;
unescape($/) -> $/;
unescape($b) -> 8;
unescape($f) -> 12;
unescape($n) -> $\n;
unescape($r) -> $\r;
unescape($t) -> $\t;
unescape(_) -> throw({json, bad_escape}).

%% Integers stay integers and decimals stay floats, exactly as `json.loads' distinguishes
%% them — `apr_cost:measure/2' reads either, but the two re-encode differently (`1' vs `1.0').
number_token(B) ->
    {Token, Rest} = take_number(B, <<>>),
    case Token of
        <<>> -> throw({json, unexpected_token});
        _ -> {parse_number(binary_to_list(Token)), Rest}
    end.

take_number(<<C, R/binary>>, Acc) when C >= $0, C =< $9 -> take_number(R, <<Acc/binary, C>>);
take_number(<<C, R/binary>>, Acc)
  when C =:= $-; C =:= $+; C =:= $.; C =:= $e; C =:= $E ->
    take_number(R, <<Acc/binary, C>>);
take_number(R, Acc) -> {Acc, R}.

parse_number(Str) ->
    case lists:any(fun(C) -> lists:member(C, ".eE") end, Str) of
        true ->
            case string:to_float(exponent_safe(Str)) of
                {Float, []} -> Float;
                _ -> throw({json, bad_number})
            end;
        false ->
            case string:to_integer(Str) of
                {Int, []} -> Int;
                _ -> throw({json, bad_number})
            end
    end.

%% `string:to_float/1' needs a decimal point, so `1e5' becomes `1.0e5' before parsing.
exponent_safe(Str) ->
    case lists:member($., Str) of
        true -> Str;
        false ->
            case string:split(Str, "e") of
                [Mantissa, Exp] -> Mantissa ++ ".0e" ++ Exp;
                _ ->
                    case string:split(Str, "E") of
                        [Mantissa2, Exp2] -> Mantissa2 ++ ".0e" ++ Exp2;
                        _ -> Str
                    end
            end
    end.

skip_ws(<<C, R/binary>>) when C =:= $\s; C =:= $\t; C =:= $\n; C =:= $\r -> skip_ws(R);
skip_ws(B) -> B.

%% --- accessors --------------------------------------------------------------
%%
%% Every accessor takes either representation, so a payload that arrived over the wire (an
%% ordered object) and one authored in a test (a bare map) are read the same way.

%% @doc Recursively sort every object's keys — the canonical form a digest hashes.
-spec canonical(term()) -> term().
canonical({obj, KVs}) -> {obj, lists:sort([{K, canonical(V)} || {K, V} <- KVs])};
canonical(Map) when is_map(Map) -> canonical({obj, maps:to_list(Map)});
canonical(List) when is_list(List) -> [canonical(E) || E <- List];
canonical(Other) -> Other.

%% @doc `Key''s value, or `undefined' when absent.
-spec get(binary(), term()) -> term().
get(Key, Object) -> get(Key, Object, undefined).

-spec get(binary(), term(), term()) -> term().
get(Key, {obj, KVs}, Default) ->
    case lists:keyfind(Key, 1, KVs) of
        {_, Value} -> Value;
        false -> Default
    end;
get(Key, Map, Default) when is_map(Map) -> maps:get(Key, Map, Default);
get(_Key, _Other, Default) -> Default.

-spec is_key(binary(), term()) -> boolean().
is_key(Key, {obj, KVs}) -> lists:keymember(Key, 1, KVs);
is_key(Key, Map) when is_map(Map) -> maps:is_key(Key, Map);
is_key(_Key, _Other) -> false.

%% @doc Set `Key', keeping its existing position when it is already present.
-spec put(binary(), term(), term()) -> object().
put(Key, Value, Object) ->
    KVs = kvs(Object),
    case lists:keymember(Key, 1, KVs) of
        true -> {obj, lists:keyreplace(Key, 1, KVs, {Key, Value})};
        false -> {obj, KVs ++ [{Key, Value}]}
    end.

%% @doc Set `Key' at the head — but keep the value already there, mirroring Python's
%% `{"model": Model, **payload}': the literal fixes the *position*, the spread wins the
%% *value*, so a caller-supplied `model' is neither dropped nor moved.
-spec put_front(binary(), term(), term()) -> object().
put_front(Key, Value, Object) ->
    KVs = kvs(Object),
    case lists:keyfind(Key, 1, KVs) of
        {_, Existing} -> {obj, [{Key, Existing} | lists:keydelete(Key, 1, KVs)]};
        false -> {obj, [{Key, Value} | KVs]}
    end.

-spec remove(binary(), term()) -> object().
remove(Key, Object) -> {obj, lists:keydelete(Key, 1, kvs(Object))}.

-spec keys(term()) -> [binary()].
keys(Object) -> [K || {K, _} <- kvs(Object)].

%% @doc The `{Key, Value}' list behind either representation. A map's keys are sorted, since
%% it has no order of its own to preserve.
-spec kvs(term()) -> [{binary(), term()}].
kvs({obj, KVs}) when is_list(KVs) -> KVs;
kvs(Map) when is_map(Map) -> [{K, maps:get(K, Map)} || K <- lists:sort(maps:keys(Map))];
kvs(_Other) -> [].

%% @doc A map as an ordered object (keys sorted) — the bridge for map-authored fixtures.
-spec from_map(map()) -> object().
from_map(Map) when is_map(Map) -> {obj, kvs(Map)}.
