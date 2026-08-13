%%% @doc Cost estimation and the spend ceiling — the router's half of KCB's `budget_units'
%%% (`koine/specs/capability-bus.md' §5). The Erlang mirror of `cost.py' and the price sheet
%%% it ships (`prices.toml'), migrated as-is.
%%%
%%% Everything here is **pure**: no network, no clock, no process env — the `AGORA_*' mapping
%%% the config keeps is passed in. It prices a request **before** dispatch so the router can
%%% refuse a rung that would exceed the caller's ceiling ({@link project/4}, {@link within/2}),
%%% and prices it again **after** so the response reports what was actually spent
%%% ({@link settle/5}).
%%%
%%% The unit
%%% --------
%%% Costs are denominated in KCB **budget units**, not currency: a grant's ceiling travels
%%% between projects that do not share a billing account, so the bus needs one comparable
%%% scalar. The table is anchored at **1 unit = US$0.00001** (so $0.05/second of video = 5000
%%% units/second), which keeps whole numbers for media and sub-unit rates for tokens. All
%%% rates are conservative ESTIMATES, not quotes; every cost carries the inputs it was
%%% computed from (`quantity' x `rate') so a caller can check the arithmetic rather than trust
%%% the total. Override a single rate with `AGORA_PRICE_<MODALITY>_<PROVIDER>'
%%% (e.g. `AGORA_PRICE_VIDEO_RUNWAY=4000'); the provider part uppercases with
%%% non-alphanumerics replaced by `_' ({@link price_env_var/2}).
%%%
%%% The two safety rules
%%% --------------------
%%% * **An unpriceable rung never passes a ceiling.** A provider with no published rate prices
%%%   as `unpriced', and {@link within/2} refuses it whenever a ceiling is set — "we don't
%%%   know" must not read as "free", or an unknown vendor becomes the cheapest route.
%%% * **A ceiling only ever fails safe.** A negative ceiling clamps to zero rather than being
%%%   ignored, and an unparseable one is an error ({@link parse_ceiling/1} throws, which the
%%%   HTTP surface turns into a 422) rather than a silent absence — treating a malformed
%%%   ceiling as "no ceiling" would authorise unlimited spend on a typo.
%%%
%%% Rates may be sourced; the rules may not
%%% ---------------------------------------
%%% Rates are data and can come from anywhere maintained — the Python router layers LiteLLM's
%%% per-model price map in under its deployer-set layers
%%% (`agora_provider_router/litellm_prices.py', off unless `AGORA_PRICE_LITELLM=1'; the
%%% canonical router carries no LiteLLM at all, see `docs/litellm-dispatch-adapter.md'). What
%%% a source may never supply is the three things above it: the `unpriced' rule (a model a
%%% source does not price is a *missing rate*, which falls through and stays refusable, never
%%% a rate of zero), the {@link measure/2} sizing of the non-text modalities, and the
%%% denomination — a source speaks its vendor's currency and {@link from_usd/1} converts,
%%% here, because a source that could name the denomination would be a cost model wearing a
%%% source's name. Both routers' cost models therefore spell the conversion identically, and
%%% `apr_conformance_SUITE' pins this module's anchor to the Python cost model's across the
%%% language boundary the same way it pins the KCB version — bump one and the other goes red.
-module(apr_cost).

-export([budget_key/0, budget_header/0, unit_anchor_usd/0, budget_units_per_usd/0,
         from_usd/1, unit_of/1, rates/1, free_providers/0, price_env_var/2, rate_for/3,
         measure/2, project/4, settle/5, within/2, refusal/4,
         take_ceiling/1, parse_ceiling/1, describe/1, units/1, fmt_g/1]).

-type modality() :: atom().
-type env() :: #{string() => string()}.
-type cost() :: #{units := float(), unit := binary(), quantity := float(),
                  rate := float(), unpriced := boolean(), estimate := boolean()}.

-export_type([cost/0]).

%% The request-body key and header carrying a per-request spend ceiling (KCB §5).
-define(BUDGET_KEY, <<"budget_units">>).
-define(BUDGET_HEADER, <<"X-Agora-Budget-Units">>).

%% Prefix of a per-(modality, provider) rate override, read from the `AGORA_*' env.
-define(PRICE_ENV_PREFIX, "AGORA_PRICE_").

%% Characters per token when sizing a prompt. Deliberately low (real English is ~4) so the
%% projection over-counts rather than under-counts against a ceiling.
-define(CHARS_PER_TOKEN, 3.5).

%% Sizes assumed when the request does not state one. Each errs high, for the same reason.
-define(DEFAULT_COMPLETION_TOKENS, 1024.0).
-define(DEFAULT_SPEECH_CHARS, 200.0).
-define(DEFAULT_VIDEO_SECONDS, 5.0).

-spec budget_key() -> binary().
budget_key() -> ?BUDGET_KEY.

-spec budget_header() -> binary().
budget_header() -> ?BUDGET_HEADER.

%% @doc What one budget unit is worth, restated so the shipped numbers stay self-explaining.
-spec unit_anchor_usd() -> float().
unit_anchor_usd() -> 0.00001.

%% @doc What one US dollar is worth in budget units — {@link unit_anchor_usd/0} the way a
%% conversion needs it, and the number `cost.py' pins as `BUDGET_UNITS_PER_USD'.
-spec budget_units_per_usd() -> float().
budget_units_per_usd() -> 100000.0.

%% @doc A US-dollar rate in KCB budget units, rounded the nine places Python's `round' takes
%% it to (`cost.py::rate_for').
%%
%% The one place a currency becomes a denomination: a rate source answers in its vendor's
%% currency and the cost model states what a budget unit is, never the other way round. Zero
%% dollars converts to zero units and to nothing else — an absent rate is not a number, it is
%% a fall-through to the layer below and, failing that, `unpriced'.
-spec from_usd(number()) -> float().
from_usd(Usd) -> round9(Usd * budget_units_per_usd()).

%% @doc What one unit of `quantity' is, per modality — the thing a rate is charged against.
-spec unit_of(modality()) -> binary().
unit_of(text) -> <<"token">>;
unit_of(image) -> <<"image">>;
unit_of(speech) -> <<"character">>;
unit_of(music) -> <<"generation">>;
unit_of(video) -> <<"second">>;
unit_of(_Other) -> <<"unit">>.

%% @doc modality -> provider -> budget units per the {@link unit_of/1} unit. Conservative
%% ESTIMATES (output-side rates where a vendor bills input and output differently).
%%
%% The zero-spend tiers (mlx-serve, ollama, placeholder) are deliberately NOT listed: they
%% are held in {@link free_providers/0} so a table edit can never accidentally price the
%% always-completes ladder, and any provider absent from the table prices as `unpriced'.
-spec rates(modality()) -> #{binary() => float()}.
rates(text) ->
    #{<<"openai">> => 0.06, <<"anthropic">> => 1.5, <<"groq">> => 0.06, <<"gemini">> => 0.03};
rates(image) ->
    #{<<"openai">> => 8000.0, <<"replicate">> => 4000.0};
rates(speech) ->
    #{<<"elevenlabs">> => 30.0, <<"openai">> => 1.5};
rates(music) ->
    #{<<"replicate">> => 5000.0};
rates(video) ->
    #{<<"runway">> => 5000.0, <<"luma">> => 5000.0, <<"minimax">> => 4300.0};
rates(_Other) ->
    #{}.

%% @doc Providers that genuinely cost nothing — priced `0.0' and NOT flagged unpriced. These
%% are the zero-spend tiers the always-completes invariant rests on: self-hosted compute and
%% the offline placeholder. An `AGORA_PRICE_*' override still wins over this set.
-spec free_providers() -> [binary()].
free_providers() ->
    [apr_backends:mlx_provider(), apr_backends:local_provider(), <<"placeholder">>].

%% @doc `{video, <<"runway">>}' -> `"AGORA_PRICE_VIDEO_RUNWAY"'.
-spec price_env_var(modality(), binary()) -> string().
price_env_var(Modality, Provider) ->
    Safe = [safe_char(C) || C <- string:uppercase(binary_to_list(Provider))],
    ?PRICE_ENV_PREFIX ++ string:uppercase(atom_to_list(Modality)) ++ "_" ++ Safe.

safe_char(C) when C >= $A, C =< $Z -> C;
safe_char(C) when C >= $0, C =< $9 -> C;
safe_char(_C) -> $_.

%% @doc `{Rate, Unpriced}' in budget units per the {@link unit_of/1} unit.
%%
%% A known paid provider gets its table rate, a free provider `0.0', and anything else `0.0'
%% **flagged unpriced** — see the module doc for why that flag matters. A malformed override
%% is ignored so the table rate still stands.
-spec rate_for(modality(), binary(), env()) -> {float(), boolean()}.
rate_for(Modality, Provider, Env) ->
    case override(maps:get(price_env_var(Modality, Provider), Env, "")) of
        {ok, Override} ->
            {Override, false};
        none ->
            case lists:member(Provider, free_providers()) of
                true -> {0.0, false};
                false ->
                    case maps:get(Provider, rates(Modality), undefined) of
                        undefined -> {0.0, true};
                        Rate -> {Rate, false}
                    end
            end
    end.

override(Raw) ->
    case string:trim(Raw) of
        "" -> none;
        Trimmed ->
            case to_float(Trimmed) of
                {ok, Value} when Value >= 0.0 -> {ok, Value};
                _ -> none
            end
    end.

%% @doc How many {@link unit_of/1} units `Payload' asks for. Never raises.
-spec measure(modality(), term()) -> float().
measure(text, Payload) ->
    Completion = case apr_json:get(<<"max_completion_tokens">>, Payload) of
                     undefined -> apr_json:get(<<"max_tokens">>, Payload);
                     Value -> Value
                 end,
    Tokens = non_negative(Completion, ?DEFAULT_COMPLETION_TOKENS),
    round6(prompt_chars(Payload) / ?CHARS_PER_TOKEN + Tokens);
measure(speech, Payload) ->
    case first_string([<<"input">>, <<"text">>], Payload) of
        undefined -> ?DEFAULT_SPEECH_CHARS;
        Text -> float(string:length(Text))
    end;
measure(video, Payload) ->
    Seconds = case apr_json:get(<<"duration">>, Payload) of
                  undefined -> apr_json:get(<<"seconds">>, Payload);
                  Value -> Value
              end,
    round6(non_negative(Seconds, ?DEFAULT_VIDEO_SECONDS) * count(Payload));
measure(_Modality, Payload) ->
    count(Payload).

first_string([], _Payload) -> undefined;
first_string([Key | Rest], Payload) ->
    case apr_json:get(Key, Payload) of
        Text when is_binary(Text) -> Text;
        _ -> first_string(Rest, Payload)
    end.

%% `n: 0' is one generation, not a free one — Python's `... or 1.0'. Written as a comparison
%% rather than a `0.0' pattern, which would not match `-0.0'.
count(Payload) ->
    case non_negative(apr_json:get(<<"n">>, Payload), 1.0) of
        Count when Count > 0.0 -> Count;
        _Zero -> 1.0
    end.

%% @doc The cost this request *would* incur on `Provider' — computed before dispatch.
-spec project(modality(), binary(), term(), env()) -> cost().
project(Modality, Provider, Payload, Env) ->
    {Rate, Unpriced} = rate_for(Modality, Provider, Env),
    Quantity = measure(Modality, Payload),
    cost(Rate, Quantity, Modality, Unpriced, true).

%% @doc The cost the request *did* incur, read off the response where the provider reports it.
%%
%% Falls back to the projection when it does not (`estimate' stays `true' so the difference is
%% visible). The placeholder reports a zero-token `usage' block, so the zero-spend tier
%% settles as a *measured* zero rather than an assumed one.
-spec settle(modality(), binary(), term(), term(), env()) -> cost().
settle(Modality, Provider, Payload, Response, Env) ->
    {Rate, Unpriced} = rate_for(Modality, Provider, Env),
    case reported_quantity(Modality, Response) of
        undefined -> cost(Rate, measure(Modality, Payload), Modality, Unpriced, true);
        Reported -> cost(Rate, Reported, Modality, Unpriced, false)
    end.

cost(Rate, Quantity, Modality, Unpriced, Estimate) ->
    #{units => round6(Rate * Quantity), unit => unit_of(Modality), quantity => Quantity,
      rate => Rate, unpriced => Unpriced, estimate => Estimate}.

%% @doc Whether `Cost' may be spent under `Ceiling'. No ceiling means no constraint.
-spec within(cost(), float() | undefined) -> boolean().
within(_Cost, undefined) -> true;
within(#{unpriced := true}, _Ceiling) -> false;
within(#{units := Units}, Ceiling) -> Units =< Ceiling.

%% @doc Why a rung was skipped — the reason recorded on the attempt, for the caller to read.
-spec refusal(cost(), float(), modality(), binary()) -> binary().
refusal(#{unpriced := true}, Ceiling, Modality, Provider) ->
    unicode:characters_to_binary(
      ["no published ", atom_to_list(Modality), " rate for ", Provider, " ", [16#2014],
       " cannot prove it fits the ", fmt_g(Ceiling), "-unit budget ceiling"]);
refusal(Cost, Ceiling, _Modality, _Provider) ->
    #{units := Units, quantity := Quantity, unit := Unit, rate := Rate} = Cost,
    unicode:characters_to_binary(
      ["projected ", fmt_g(Units), " budget units (", fmt_g(Quantity), " ", Unit, " @ ",
       fmt_g(Rate), ") exceeds the ", fmt_g(Ceiling), "-unit ceiling"]).

%% @doc `Cost''s total, for a caller that only wants the scalar.
-spec units(cost()) -> float().
units(#{units := Units}) -> Units.

%% @doc The reportable view of a cost (`cost.py::Cost.describe'), in Python's key order.
-spec describe(cost()) -> apr_json:object().
describe(Cost) ->
    #{units := Units, unit := Unit, quantity := Quantity,
      rate := Rate, unpriced := Unpriced, estimate := Estimate} = Cost,
    {obj, [{<<"units">>, Units}, {<<"unit">>, Unit}, {<<"quantity">>, Quantity},
           {<<"rate">>, Rate}, {<<"unpriced">>, Unpriced}, {<<"estimate">>, Estimate}]}.

%% @doc Split `budget_units' off the request body.
%%
%% Returns a copy WITHOUT the key, so the ceiling — an agora extension, not an OpenAI field —
%% is never forwarded to an upstream provider that would reject it. Throws
%% `{ceiling_error, Message}' on an unreadable value.
-spec take_ceiling(term()) -> {term(), float() | undefined}.
take_ceiling(Payload) ->
    case apr_json:is_key(?BUDGET_KEY, Payload) of
        false -> {Payload, undefined};
        true -> {apr_json:remove(?BUDGET_KEY, Payload),
                 parse_ceiling(apr_json:get(?BUDGET_KEY, Payload))}
    end.

%% @doc A ceiling from a request value. `undefined'/`null' passes through; junk throws.
%%
%% Negatives clamp to zero (a below-zero budget is a zero budget, not an unlimited one).
%% Refusing junk is deliberate: silently dropping an unreadable ceiling would turn a typo into
%% unlimited spend authority.
-spec parse_ceiling(term()) -> float() | undefined.
parse_ceiling(undefined) -> undefined;
parse_ceiling(null) -> undefined;
parse_ceiling(Raw) when is_boolean(Raw) -> throw({ceiling_error, ceiling_message(Raw)});
parse_ceiling(Raw) when is_integer(Raw) -> max(float(Raw), 0.0);
parse_ceiling(Raw) when is_float(Raw) -> max(Raw, 0.0);
parse_ceiling(Raw) when is_binary(Raw) ->
    case to_float(string:trim(binary_to_list(Raw))) of
        {ok, Value} -> max(Value, 0.0);
        error -> throw({ceiling_error, ceiling_message(Raw)})
    end;
parse_ceiling(Raw) -> throw({ceiling_error, ceiling_message(Raw)}).

%% The refused value is quoted the way CPython's `repr' quotes it — `cost.py' interpolates
%% one, and this message is a response body, so its spelling is contract (US-6).
ceiling_message(Raw) ->
    unicode:characters_to_binary(
      [?BUDGET_KEY, <<" must be a number of budget units, got ">>, apr_json:python_repr(Raw)]).

%% @doc Python's `format(x, "g")': six significant digits, trailing zeros stripped.
%%
%% Reproduced here because it is the spelling every budget string and the `X-Agora-Cost-Units'
%% header uses — `0' not `0.0', `60' not `60.0000', `0.06' unchanged.
-spec fmt_g(number()) -> string().
fmt_g(N) when is_integer(N) -> integer_to_list(N);
fmt_g(F) when is_float(F) ->
    Abs = abs(F),
    Exponent = case Abs == 0.0 of
                   true -> 0;
                   false -> trunc(math:floor(math:log10(Abs)))
               end,
    case Exponent < -4 orelse Exponent >= 6 of
        true -> exponent_form(F, Exponent);
        false -> strip_zeros(float_to_list(F, [{decimals, decimals_for(Exponent)}]))
    end.

decimals_for(Exponent) -> max(0, min(15, 5 - Exponent)).

exponent_form(F, Exponent) ->
    Mantissa = strip_zeros(float_to_list(F / math:pow(10, Exponent), [{decimals, 5}])),
    Digits = integer_to_list(abs(Exponent)),
    Padded = case length(Digits) of
                 1 -> "0" ++ Digits;
                 _ -> Digits
             end,
    Sign = case Exponent < 0 of
               true -> "-";
               false -> "+"
           end,
    Mantissa ++ "e" ++ Sign ++ Padded.

strip_zeros(Str) ->
    case lists:member($., Str) of
        false -> Str;
        true -> string:trim(string:trim(Str, trailing, "0"), trailing, ".")
    end.

%% --- request measurement ----------------------------------------------------

%% Characters of prompt in a chat- or completion-shaped body.
prompt_chars(Payload) ->
    Prompt = case apr_json:get(<<"prompt">>, Payload) of
                 Text when is_binary(Text) -> string:length(Text);
                 _ -> 0
             end,
    Messages = case apr_json:get(<<"messages">>, Payload) of
                   List when is_list(List) ->
                       lists:sum([content_chars(apr_json:get(<<"content">>, M))
                                  || M <- List, is_object(M)]);
                   _ -> 0
               end,
    float(Prompt + Messages).

%% A chat message's content length — a string, or the text parts of a multimodal list.
content_chars(Content) when is_binary(Content) -> string:length(Content);
content_chars(Content) when is_list(Content) ->
    lists:sum([part_chars(Part) || Part <- Content, is_object(Part)]);
content_chars(_Content) -> 0.

part_chars(Part) ->
    case apr_json:get(<<"text">>, Part) of
        Text when is_binary(Text) -> string:length(Text);
        _ -> 0
    end.

is_object({obj, KVs}) when is_list(KVs) -> true;
is_object(Term) -> is_map(Term).

%% The billable quantity the provider itself reported, or `undefined' if it did not.
reported_quantity(text, Response) ->
    case apr_json:get(<<"total_tokens">>, apr_json:get(<<"usage">>, Response)) of
        Total when is_integer(Total) -> float(Total);
        Total when is_float(Total) -> Total;
        _ -> undefined
    end;
reported_quantity(Modality, Response) when Modality =:= image; Modality =:= music ->
    case apr_json:get(<<"data">>, Response) of
        [_ | _] = Data -> float(length(Data));
        _ -> undefined
    end;
reported_quantity(_Modality, _Response) ->
    undefined.

%% --- numbers ----------------------------------------------------------------

%% Python rounds every unit total to 6 decimal places; `0.06 * 1000' is `60.000000000000006'
%% in both languages, and both must report `60.0'.
round6(Value) -> erlang:round(Value * 1000000) / 1000000.

%% A converted rate is rounded finer than a total, because it is multiplied by a quantity
%% afterwards: `cost.py' takes it to 9 places, so `$0.05/second' is `5000.0' and not
%% `5000.000000000001'.
round9(Value) -> erlang:round(Value * 1000000000) / 1000000000.

non_negative(Value, Default) when is_boolean(Value) -> Default;
non_negative(Value, _Default) when is_integer(Value), Value >= 0 -> float(Value);
non_negative(Value, _Default) when is_float(Value), Value >= 0.0 -> Value;
non_negative(Value, Default) when is_binary(Value) ->
    case to_float(string:trim(binary_to_list(Value))) of
        {ok, Number} when Number >= 0.0 -> Number;
        _ -> Default
    end;
non_negative(_Value, Default) -> Default.

to_float(Str) ->
    case string:to_float(Str) of
        {Float, []} -> {ok, Float};
        _ ->
            case string:to_integer(Str) of
                {Int, []} -> {ok, float(Int)};
                _ ->
                    case string:to_float(exponent_safe(Str)) of
                        {Float2, []} -> {ok, Float2};
                        _ -> error
                    end
            end
    end.

%% `string:to_float/1' needs a decimal point: `1e5' is a number to Python and not to it.
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
