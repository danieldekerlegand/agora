%%% @doc Tier -> concrete backend: what a ladder rung actually dials, and why it might not.
%%% The Erlang mirror of `backends.py'.
%%%
%%% Every dispatchable backend speaks the OpenAI wire format — or is made to. Vendors whose
%%% HTTP surface is not OpenAI-shaped are declared `wire => native'; a native rung is dialable
%%% only where the Rust translator (agora:60, bound by {@link apr_translate}) can convert for
%%% it, and stays `pending-adapter' otherwise. A backend therefore carries its `wire', and —
%%% once the translator has converted a request — the vendor-relative `path' that request goes
%%% to, since where a request goes is as much a part of a wire format as what it looks like.
%%%
%%% Nothing here dials: availability is a *configuration* question, and so is whether this
%%% node was built with a translator ({@link apr_translate:enabled/0} is a switch and a stat,
%%% not a process). Whether a configured backend actually answers is a dispatch-time question
%%% handled in {@link apr_rung_worker}.
-module(apr_backends).

-export([paid_providers/1, endpoints/1, mlx_provider/0, local_provider/0,
         local_providers/0, paid_vendors/0, native_providers/0,
         placeholder_backend/1, resolve_tier/3, resolve_tier/4,
         backend_url/1, dispatch_url/1, dispatch_headers/1, local_bind/1,
         backend_describe/1, resolution_describe/1]).

-type modality() :: atom().
-type tier() :: paid | mlx | local | placeholder.
-type dialable_tier() :: paid | mlx | local.
-type wire() :: openai | native.
-type backend() :: #{tier := tier(), provider := binary(), modality := modality(),
                    model := binary(), base_url := binary() | undefined,
                    api_key := binary() | undefined, wire := wire(),
                    path := binary() | undefined}.
-type status() :: ready | unconfigured | 'pending-adapter'.
-type resolution() :: #{tier := tier(), status := status(),
                       backend := backend() | undefined,
                       reason := binary() | undefined}.
-type rank() :: fun((backend()) -> number()) | undefined.
%% Where a local backend's configured address puts it: on this machine's loopback interface,
%% or somewhere a packet has to leave the box to reach.
-type local_bind() :: loopback | remote.

-export_type([backend/0, resolution/0, local_bind/0]).

%% @doc modality -> paid vendors in preference order (`backends.py::PAID_PROVIDERS').
-spec paid_providers(modality()) -> [binary()].
paid_providers(text) -> [<<"openai">>, <<"anthropic">>, <<"groq">>, <<"gemini">>];
paid_providers(image) -> [<<"openai">>, <<"replicate">>];
paid_providers(speech) -> [<<"elevenlabs">>, <<"openai">>];
paid_providers(music) -> [<<"replicate">>];
paid_providers(video) -> [<<"runway">>, <<"luma">>, <<"minimax">>].

%% @doc modality -> the OpenAI-shaped route a tier POSTs, relative to a base URL.
-spec endpoints(modality()) -> binary().
endpoints(text) -> <<"/chat/completions">>;
endpoints(image) -> <<"/images/generations">>;
endpoints(speech) -> <<"/audio/speech">>;
endpoints(music) -> <<"/audio/music-generations">>;
endpoints(video) -> <<"/video/generations">>.

-spec mlx_provider() -> binary().
mlx_provider() -> <<"mlx-serve">>.

-spec local_provider() -> binary().
local_provider() -> <<"ollama">>.

%% @doc The providers of the keyless local tiers (`backends.py::LOCAL_PROVIDERS').
%%
%% Their address is the operator's and nobody else's: a client library will happily supply one
%% (`ollama' has a well-known port that more than one of them assumes), and inheriting it
%% would make "no local server configured" a statement about whatever happens to be listening
%% on the box rather than about the configuration. The rule is held twice —
%% {@link resolve_tier/3} never yields such a rung, and {@link dispatch_url/1} refuses to name
%% an address for one that somehow reached a transport anyway. See
%% `docs/local-backend-posture.md', which states the whole posture (bind, auth, why the
%% default is never inherited).
-spec local_providers() -> [binary()].
local_providers() -> [mlx_provider(), local_provider()].

%% @doc The paid vendors, keyed by name (`backends.py::PAID_VENDORS').
-spec paid_vendors() -> #{binary() => map()}.
paid_vendors() ->
    #{<<"openai">> => #{wire => openai, base_url => <<"https://api.openai.com/v1">>,
                        models => #{text => <<"gpt-4o-mini">>, image => <<"gpt-image-1">>,
                                    speech => <<"gpt-4o-mini-tts">>}},
      <<"groq">> => #{wire => openai, base_url => <<"https://api.groq.com/openai/v1">>,
                      models => #{text => <<"llama-3.3-70b-versatile">>}},
      <<"anthropic">> => native_vendor(<<"https://api.anthropic.com/v1">>,
                                       #{text => <<"claude-haiku-4-5-20251001">>}),
      <<"gemini">> => native_vendor(<<"https://generativelanguage.googleapis.com/v1beta">>,
                                    #{text => <<"gemini-2.5-flash">>}),
      <<"replicate">> => native_vendor(<<"https://api.replicate.com/v1">>,
                                       #{image => <<"black-forest-labs/flux-schnell">>,
                                         music => <<"meta/musicgen">>}),
      <<"elevenlabs">> => native_vendor(<<"https://api.elevenlabs.io/v1">>,
                                        #{speech => <<"eleven_multilingual_v2">>}),
      <<"runway">> => native_vendor(<<"https://api.dev.runwayml.com/v1">>,
                                    #{video => <<"gen3a_turbo">>}),
      <<"luma">> => native_vendor(<<"https://api.lumalabs.ai/dream-machine/v1">>,
                                  #{video => <<"ray-2">>}),
      <<"minimax">> => native_vendor(<<"https://api.minimax.chat/v1">>,
                                     #{video => <<"video-01">>})}.

native_vendor(BaseUrl, Models) -> #{wire => native, base_url => BaseUrl, models => Models}.

%% @doc The vendors whose HTTP surface is not OpenAI-shaped — the ones a rung can only dial
%% through the translator. Named rather than derived so a test can pin the set.
-spec native_providers() -> [binary()].
native_providers() ->
    lists:sort([Name || {Name, Vendor} <- maps:to_list(paid_vendors()),
                        maps:get(wire, Vendor) =:= native]).

mlx_models() ->
    #{text => <<"mlx-community/Qwen3-8B-4bit">>,
      image => <<"ddalcu/Krea-2-Turbo-MLX-Serve-mixed-4-8">>,
      speech => <<"mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16">>,
      music => <<"ddalcu/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit">>,
      video => <<"dgrauet/ltx-2.3-mlx-q4">>}.

ollama_models() -> #{text => <<"llama3.2">>}.

%% @doc The terminal rung. Free, offline, deterministic — always resolvable.
-spec placeholder_backend(modality()) -> backend().
placeholder_backend(Modality) ->
    #{tier => placeholder, provider => <<"placeholder">>, modality => Modality,
      model => <<"placeholder-", (atom_to_binary(Modality, utf8))/binary>>,
      base_url => undefined, api_key => undefined, wire => openai, path => undefined}.

%% @doc Resolve one rung for one modality against the configuration, without a cost rank.
-spec resolve_tier(dialable_tier(), modality(), apr_config:config()) -> resolution().
resolve_tier(Tier, Modality, Config) -> resolve_tier(Tier, Modality, Config, undefined).

%% @doc Resolve one rung, with `Rank' breaking the tie between usable paid vendors.
-spec resolve_tier(dialable_tier(), modality(), apr_config:config(), rank()) -> resolution().
resolve_tier(paid, Modality, Config, Rank) -> resolve_paid(Modality, Config, Rank);
resolve_tier(mlx, Modality, Config, _Rank) ->
    resolve_keyless(mlx, mlx_provider(), mlx_models(), Modality, Config);
resolve_tier(local, Modality, Config, _Rank) ->
    resolve_keyless(local, local_provider(), ollama_models(), Modality, Config).

resolve_paid(Modality, Config, Rank) ->
    Vendors = paid_providers(Modality),
    {Ready, Pending} =
        lists:foldl(
          fun(Name, {ReadyAcc, PendingAcc}) ->
                  Settings = apr_config:provider(Config, Name),
                  case apr_config:has_key(Settings) andalso apr_config:usable(Settings) of
                      false -> {ReadyAcc, PendingAcc};
                      true -> classify_vendor(Name, Modality, Settings, ReadyAcc, PendingAcc)
                  end
          end, {[], []}, Vendors),
    ReadyList = lists:reverse(Ready),
    PendingList = lists:reverse(Pending),
    case {ReadyList, PendingList} of
        {[_ | _], _} ->
            Backend = case Rank of
                          undefined -> hd(ReadyList);
                          _ -> min_by(Rank, ReadyList)
                      end,
            resolution(paid, ready, Backend, undefined);
        {[], [_ | _]} ->
            resolution(paid, 'pending-adapter', undefined, pending_reason(PendingList, Modality));
        {[], []} ->
            resolution(paid, unconfigured, undefined, unconfigured_reason(Modality, Vendors))
    end.

%% A vendor is ready when it serves the modality AND this node speaks its wire: OpenAI's
%% natively, a native one only through the translator. Anything else falls to `pending' —
%% recognised, reported, and left for the next rung.
classify_vendor(Name, Modality, Settings, ReadyAcc, PendingAcc) ->
    Vendor = maps:get(Name, paid_vendors()),
    Wire = maps:get(wire, Vendor),
    Model = vendor_model(Modality, Settings, Vendor),
    case Model =/= undefined andalso dialable_wire(Wire) of
        false ->
            {ReadyAcc, [Name | PendingAcc]};
        true ->
            Backend = #{tier => paid, provider => Name, modality => Modality,
                        model => Model,
                        base_url => coalesce(maps:get(base_url, Settings),
                                             maps:get(base_url, Vendor)),
                        api_key => maps:get(api_key, Settings),
                        wire => Wire, path => undefined},
            {[Backend | ReadyAcc], PendingAcc}
    end.

dialable_wire(openai) -> true;
dialable_wire(native) -> apr_translate:enabled().

vendor_model(Modality, Settings, Vendor) ->
    case maps:get(model, Settings) of
        undefined -> maps:get(Modality, maps:get(models, Vendor), undefined);
        Model -> Model
    end.

resolve_keyless(Tier, Provider, Models, Modality, Config) ->
    Settings = apr_config:provider(Config, Provider),
    Model = case maps:get(model, Settings) of
                undefined -> maps:get(Modality, Models, undefined);
                Configured -> Configured
            end,
    BaseUrl = maps:get(base_url, Settings),
    ModalityBin = atom_to_binary(Modality, utf8),
    HasBaseUrl = has_base_url(BaseUrl),
    Usable = apr_config:usable(Settings),
    if
        Model =:= undefined ->
            resolution(Tier, unconfigured, undefined,
                       <<Provider/binary, " serves no ", ModalityBin/binary, " model">>);
        not HasBaseUrl ->
            resolution(Tier, unconfigured, undefined,
                       <<Provider/binary, " base URL not set">>);
        not Usable ->
            resolution(Tier, unconfigured, undefined,
                       <<Provider/binary, " explicitly disabled">>);
        true ->
            %% Keyless is the local tiers' default posture, not the only one: an operator
            %% who authenticated their local server configured a key, and it is dialed with
            %% ({@link dispatch_headers/1}).
            Backend = #{tier => Tier, provider => Provider, modality => Modality,
                        model => Model, base_url => BaseUrl,
                        api_key => maps:get(api_key, Settings),
                        wire => openai, path => undefined},
            resolution(Tier, ready, Backend, bind_reason(Provider, BaseUrl))
    end.

%% A `reason' on a *ready* rung is the one thing `/doctor' says about a rung it is otherwise
%% happy with — which is the weight a remote-local address deserves: allowed, because
%% configured; never silent, because unauthenticated local backends were designed for a
%% loopback interface (`docs/local-backend-posture.md').
bind_reason(Provider, BaseUrl) ->
    case local_bind(BaseUrl) of
        loopback -> undefined;
        _ -> remote_local_reason(Provider, BaseUrl)
    end.

%% Built with `/utf8' rather than `unicode:characters_to_binary/1' so the result is a binary
%% by construction: this string reaches a reason field typed `binary()'.
remote_local_reason(Provider, BaseUrl) ->
    Head = <<" is configured at a non-loopback address (">>,
    Tail = <<") \x{2014} a local backend reached over a network, which is an explicit "/utf8>>,
    Rest = <<"operator choice and not a default">>,
    <<Provider/binary, Head/binary, BaseUrl/binary, Tail/binary, Rest/binary>>.

resolution(Tier, Status, Backend, Reason) ->
    #{tier => Tier, status => Status, backend => Backend, reason => Reason}.

pending_reason(Names, Modality) ->
    unicode:characters_to_binary(
      [lists:join(", ", [binary_to_list(N) || N <- Names]),
       " has a key but no ", atom_to_list(Modality),
       " adapter for its native wire format ", [16#2014],
       " falling through rather than sending it OpenAI JSON"]).

%% `backends.py' spells this `', '.join(vendors) or 'none declared'`, guarding a modality
%% absent from its `PAID_PROVIDERS` dict. Here {@link paid_providers/1} is a clause per
%% modality and every one names at least one vendor, so the guard is provably dead — dialyzer
%% says so — and carrying it would be a branch no test could ever reach.
unconfigured_reason(Modality, Vendors) ->
    Listed = lists:join(", ", [binary_to_list(V) || V <- Vendors]),
    unicode:characters_to_binary(
      ["no API key for any ", atom_to_list(Modality), " vendor (", Listed, ")"]).

min_by(Rank, [First | Rest]) ->
    {_, Backend} =
        lists:foldl(
          fun(Candidate, {BestScore, BestBackend}) ->
                  Score = Rank(Candidate),
                  case Score < BestScore of
                      true -> {Score, Candidate};
                      false -> {BestScore, BestBackend}
                  end
          end, {Rank(First), First}, Rest),
    Backend.

coalesce(undefined, Fallback) -> Fallback;
coalesce(<<>>, Fallback) -> Fallback;
coalesce(Value, _Fallback) -> Value.

%% @doc The full endpoint URL for a backend. An OpenAI-wire backend goes to its modality's
%% route; a translated one goes wherever the translator said, which is why a converted request
%% carries its `path' back on the backend it is dispatched with.
-spec backend_url(backend()) -> binary().
backend_url(#{path := Path} = Backend) when is_binary(Path) ->
    <<(base(Backend))/binary, Path/binary>>;
backend_url(#{modality := Modality} = Backend) ->
    <<(base(Backend))/binary, (endpoints(Modality))/binary>>.

%% @doc The address a rung is dialed at, or why it has none (`backends.py::dispatch_url').
%%
%% Only the keyless local tiers are held to it: a paid rung's address is its vendor's, which
%% is public vocabulary, where a local one is a fact about an operator's machine. An error is
%% not a failed request — to {@link apr_rung_worker} it is one more rung that did not answer,
%% recorded `dialed => false' because nothing was contacted.
-spec dispatch_url(backend()) -> {ok, binary()} | {error, binary()}.
dispatch_url(#{provider := Provider, base_url := BaseUrl} = Backend) ->
    IsLocal = lists:member(Provider, local_providers()),
    case IsLocal andalso not has_base_url(BaseUrl) of
        true -> {error, no_address_reason(Provider)};
        false -> {ok, backend_url(Backend)}
    end.

%% Built with `/utf8' rather than `unicode:characters_to_binary/1' so the result is a binary
%% by construction: this string reaches a reason field typed `binary()'.
no_address_reason(Provider) ->
    Head = <<" has no configured base URL \x{2014} a local tier is never dialed at "/utf8>>,
    Tail = <<"a default address, only at one an operator set">>,
    <<Provider/binary, Head/binary, Tail/binary>>.

has_base_url(undefined) -> false;
has_base_url(<<>>) -> false;
has_base_url(_BaseUrl) -> true.

%% @doc The headers a rung is dialed with (`backends.py::dispatch_headers'): JSON, plus auth
%% iff one was configured.
%%
%% The local tiers are keyless *by default*, not by rule. Ollama and mlx-serve ship
%% unauthenticated, so a stock one needs no credential — but an operator who has put one
%% behind a reverse proxy has a credential for it, and `AGORA_PROVIDER_OLLAMA_API_KEY' is
%% carried here the same way a paid vendor's is. What this never does is invent one: with
%% nothing configured there is no `authorization' header at all, rather than an empty bearer
%% that a permissive backend would accept and a strict one would reject for the wrong reason.
%% See `docs/local-backend-posture.md'.
-spec dispatch_headers(backend()) -> [{binary(), binary()}].
dispatch_headers(#{api_key := Key}) when is_binary(Key), byte_size(Key) > 0 ->
    [{<<"content-type">>, <<"application/json">>},
     {<<"authorization">>, <<"Bearer ", Key/binary>>}];
dispatch_headers(_Backend) ->
    [{<<"content-type">>, <<"application/json">>}].

%% @doc Classify a local backend's address (`backends.py::local_bind'); `undefined' when
%% there is none to classify.
%%
%% Anything not *demonstrably* loopback is `remote'. A host this cannot parse, or one that
%% only a resolver could settle, is the operator's to explain — and the safe reading of "I
%% could not tell" is "it leaves the box", because that is the reading under which an
%% unauthenticated backend is the operator's explicit choice rather than this module's
%% silent one. Never resolves DNS: classification is a fact about the configuration.
-spec local_bind(binary() | undefined) -> local_bind() | undefined.
local_bind(undefined) -> undefined;
local_bind(<<>>) -> undefined;
local_bind(BaseUrl) ->
    case uri_host(BaseUrl) of
        undefined -> remote;
        Host -> classify_host(ascii_lowercase(Host))
    end.

%% `OLLAMA_HOST=localhost:11434' is a real spelling, and to a URI parser a bare `host:port'
%% reads as scheme `host' — so an authority with no `//' is given one. A host the parser
%% declines to give back as a binary is `undefined', i.e. `remote': the conservative answer
%% is the one this classification is for.
uri_host(BaseUrl) ->
    Trimmed = trim_spaces(BaseUrl),
    Candidate = case binary:match(Trimmed, <<"//">>) of
                    nomatch -> <<"//", Trimmed/binary>>;
                    _ -> Trimmed
                end,
    case uri_string:parse(Candidate) of
        #{host := Host} when is_binary(Host) -> Host;
        _ -> undefined
    end.

classify_host(<<"localhost">>) -> loopback;
classify_host(Host) ->
    case ends_with(<<".localhost">>, Host) of
        true -> loopback;
        false -> classify_address(Host)
    end.

%% IPv4 loopback is the whole 127/8 block; IPv6 loopback is `::1' and nothing else. An
%% IPv4-mapped `::ffff:127.0.0.1' is deliberately not loopback, which is what
%% `ipaddress.ip_address(...).is_loopback' answers on the Python side too.
classify_address(Host) ->
    case inet:parse_address(binary_to_list(Host)) of
        {ok, {127, _, _, _}} -> loopback;
        {ok, {0, 0, 0, 0, 0, 0, 0, 1}} -> loopback;
        _ -> remote
    end.

ends_with(Suffix, Bin) ->
    SuffixSize = byte_size(Suffix),
    byte_size(Bin) > SuffixSize
        andalso binary:part(Bin, byte_size(Bin) - SuffixSize, SuffixSize) =:= Suffix.

%% `string:lowercase/1' and `string:trim/1' are spelled over `unicode:chardata()' and return
%% it, so neither is a `binary()' to dialyzer. A host name is ASCII (an international one
%% arrives punycoded), and these two say so by construction — the same reason
%% `no_address_reason/1' builds its binary with `/utf8' rather than through `unicode'.
ascii_lowercase(Bin) -> << <<(lower_char(C))>> || <<C>> <= Bin >>.

lower_char(C) when C >= $A, C =< $Z -> C + 32;
lower_char(C) -> C.

trim_spaces(<<C, Rest/binary>>) when C =:= $\s; C =:= $\t; C =:= $\n; C =:= $\r ->
    trim_spaces(Rest);
trim_spaces(Bin) -> trim_trailing_spaces(Bin).

trim_trailing_spaces(<<>>) -> <<>>;
trim_trailing_spaces(Bin) ->
    case binary:last(Bin) of
        C when C =:= $\s; C =:= $\t; C =:= $\n; C =:= $\r ->
            trim_trailing_spaces(binary:part(Bin, 0, byte_size(Bin) - 1));
        _ -> Bin
    end.

%% Where a backend's `bind' is reportable at all: a paid vendor's address is public
%% vocabulary, not a statement about anybody's network.
backend_bind(#{provider := Provider, base_url := BaseUrl}) ->
    case lists:member(Provider, local_providers()) of
        true -> local_bind(BaseUrl);
        false -> undefined
    end.

base(Backend) ->
    strip_trailing_slash(coalesce(maps:get(base_url, Backend), <<>>)).

strip_trailing_slash(Bin) ->
    case Bin of
        <<>> -> <<>>;
        _ ->
            case binary:last(Bin) of
                $/ -> strip_trailing_slash(binary:part(Bin, 0, byte_size(Bin) - 1));
                _ -> Bin
            end
    end.

%% @doc The reportable view of a backend (`backends.py::Backend.describe').
-spec backend_describe(backend()) -> {obj, [{binary(), term()}]}.
backend_describe(Backend) ->
    {obj, [{<<"tier">>, atom_to_binary(maps:get(tier, Backend), utf8)},
           {<<"provider">>, maps:get(provider, Backend)},
           {<<"model">>, maps:get(model, Backend)},
           {<<"base_url">>, nn(maps:get(base_url, Backend))}] ++ bind_field(Backend)}.

%% Reported only where it means something, so that a local rung's posture is visible on
%% `/doctor' without inventing a field for the eight vendors it cannot describe.
bind_field(Backend) ->
    case backend_bind(Backend) of
        undefined -> [];
        Bind -> [{<<"bind">>, atom_to_binary(Bind, utf8)}]
    end.

%% @doc The `/doctor' view of a rung (`backends.py::TierResolution.describe').
-spec resolution_describe(resolution()) -> {obj, [{binary(), term()}]}.
resolution_describe(Resolution) ->
    Base = [{<<"tier">>, atom_to_binary(maps:get(tier, Resolution), utf8)},
            {<<"status">>, atom_to_binary(maps:get(status, Resolution), utf8)}],
    WithBackend =
        case maps:get(backend, Resolution) of
            undefined -> Base;
            Backend ->
                Base ++ [{<<"provider">>, maps:get(provider, Backend)},
                         {<<"model">>, maps:get(model, Backend)},
                         {<<"base_url">>, nn(maps:get(base_url, Backend))}]
                     ++ bind_field(Backend)
        end,
    case maps:get(reason, Resolution) of
        undefined -> {obj, WithBackend};
        Reason -> {obj, WithBackend ++ [{<<"reason">>, Reason}]}
    end.

nn(undefined) -> null;
nn(Value) -> Value.
