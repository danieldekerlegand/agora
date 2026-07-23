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
         paid_vendors/0, native_providers/0,
         placeholder_backend/1, resolve_tier/3, resolve_tier/4,
         backend_url/1, backend_describe/1, resolution_describe/1]).

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

-export_type([backend/0, resolution/0]).

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
    HasBaseUrl = BaseUrl =/= undefined andalso BaseUrl =/= <<>>,
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
            Backend = #{tier => Tier, provider => Provider, modality => Modality,
                        model => Model, base_url => BaseUrl, api_key => undefined,
                        wire => openai, path => undefined},
            resolution(Tier, ready, Backend, undefined)
    end.

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
           {<<"base_url">>, nn(maps:get(base_url, Backend))}]}.

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
        end,
    case maps:get(reason, Resolution) of
        undefined -> {obj, WithBackend};
        Reason -> {obj, WithBackend ++ [{<<"reason">>, Reason}]}
    end.

nn(undefined) -> null;
nn(Value) -> Value.
