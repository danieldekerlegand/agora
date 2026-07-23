%%% @doc The router's provider configuration — the Erlang mirror of `config.py', read from
%%% the process environment.
%%%
%%% The wire format is the package-neutral `AGORA_PROVIDER_<NAME>_<FIELD>' shape; the legacy
%%% `CUNEIFORM_PROVIDER_<NAME>_<FIELD>' spelling is a documented alias, and the neutral
%%% spelling wins when both name the same field. The common non-namespaced spellings
%%% (`OPENAI_API_KEY', `MLX_SERVE_BASE_URL', `OLLAMA_HOST', ...) are accepted as fallbacks.
%%%
%%% Secrets never leak: a key is kept only as the value behind `api_key' and is never placed
%%% in the reportable {@link describe/1} view, which reports *whether* a key is set and where
%%% it came from, never its value.
%%%
%%% Only the `AGORA_*' subset of the environment is retained on the config (for the ladder
%%% and, later, price overrides) — deliberately not the whole environment, so a config value
%%% can never carry an exported secret into a log line.
-module(apr_config).

-export([from_env/0, from_env/1, env/0,
         provider/2, providers/1, ladder_env/1, describe/1,
         has_key/1, usable/1]).

-type provider() :: #{name := binary(),
                      api_key := binary() | undefined,
                      key_source := binary() | undefined,
                      base_url := binary() | undefined,
                      model := binary() | undefined,
                      enabled := boolean() | undefined}.
-type config() :: #{providers := #{binary() => provider()},
                   env := #{string() => string()}}.

-export_type([config/0, provider/0]).

-define(NS_NEUTRAL, "AGORA_PROVIDER_").
-define(NS_LEGACY, "CUNEIFORM_PROVIDER_").

%% @doc The whole process environment as a `#{Name => Value}' map of strings.
-spec env() -> #{string() => string()}.
env() ->
    maps:from_list([split_eq(Entry) || Entry <- os:getenv()]).

split_eq(Entry) ->
    case string:split(Entry, "=") of
        [Key, Value] -> {Key, Value};
        [Key] -> {Key, ""}
    end.

%% @doc Parse the live process environment into a config snapshot.
-spec from_env() -> config().
from_env() -> from_env(env()).

%% @doc Parse an explicit environment mapping — the injectable form the tests use.
-spec from_env(#{string() => string()}) -> config().
from_env(FullEnv) ->
    LadderEnv = maps:filter(fun(Key, _) -> lists:prefix("AGORA_", Key) end, FullEnv),
    #{providers => parse_providers(FullEnv), env => LadderEnv}.

%% @doc The `AGORA_*' env subset the ladder and price overrides read.
-spec ladder_env(config()) -> #{string() => string()}.
ladder_env(Config) -> maps:get(env, Config).

%% @doc `Name''s settings, or an empty (unusable) record — never a missing-key error.
-spec provider(config(), binary()) -> provider().
provider(Config, Name) ->
    maps:get(Name, maps:get(providers, Config), empty_provider(Name)).

%% @doc Every configured provider record.
-spec providers(config()) -> #{binary() => provider()}.
providers(Config) -> maps:get(providers, Config).

empty_provider(Name) ->
    #{name => Name, api_key => undefined, key_source => undefined,
      base_url => undefined, model => undefined, enabled => undefined}.

%% @doc Whether `Provider' carries a non-empty API key.
-spec has_key(provider()) -> boolean().
has_key(#{api_key := Key}) when is_binary(Key) -> byte_size(Key) > 0;
has_key(_) -> false.

%% @doc Configured to be dispatched to: not explicitly disabled, and reachable somehow.
-spec usable(provider()) -> boolean().
usable(#{enabled := false}) -> false;
usable(Provider) ->
    has_key(Provider) orelse present(maps:get(base_url, Provider)).

present(undefined) -> false;
present(<<>>) -> false;
present(Bin) when is_binary(Bin) -> true.

%% @doc Secret-free summary for `/doctor', providers sorted by name.
-spec describe(config()) -> {obj, [{binary(), term()}]}.
describe(Config) ->
    Names = lists:sort(maps:keys(maps:get(providers, Config))),
    {obj, [{<<"providers">>, [describe_provider(provider(Config, Name)) || Name <- Names]},
           {<<"env_file">>, null}]}.

describe_provider(Provider) ->
    {obj, [{<<"name">>, maps:get(name, Provider)},
           {<<"has_key">>, has_key(Provider)},
           {<<"key_source">>, nn(maps:get(key_source, Provider))},
           {<<"base_url">>, nn(maps:get(base_url, Provider))},
           {<<"model">>, nn(maps:get(model, Provider))},
           {<<"enabled">>, nn(maps:get(enabled, Provider))},
           {<<"usable">>, usable(Provider)}]}.

nn(undefined) -> null;
nn(Value) -> Value.

%% --- parsing ----------------------------------------------------------------

%% Fold the namespaced block (neutral before legacy) and the standard fallbacks into one
%% record per provider. `Fields' is `Name => #{field := binary()}'; the first writer of a
%% field wins, so the neutral spelling beats the legacy alias which beats the fallbacks.
parse_providers(Env) ->
    F0 = namespaced_pass(Env, ?NS_NEUTRAL, #{}),
    F1 = namespaced_pass(Env, ?NS_LEGACY, F0),
    {F2, Sources} = api_key_fallback(Env, F1),
    F3 = base_url_fallback(Env, F2),
    maps:map(fun(Name, Fields) -> build_provider(Name, Fields, Sources) end, F3).

namespaced_pass(Env, Prefix, Acc0) ->
    maps:fold(
      fun(Key, Value, Acc) ->
              case parse_namespaced_key(Key, Prefix) of
                  {Name, Field} ->
                      case string:trim(Value) of
                          "" -> Acc;
                          Trimmed -> set_absent(Acc, Name, Field, list_to_binary(Trimmed))
                      end;
                  none -> Acc
              end
      end, Acc0, Env).

parse_namespaced_key(Key, Prefix) ->
    case lists:prefix(Prefix, Key) of
        false -> none;
        true -> match_field(lists:nthtail(length(Prefix), Key), fields())
    end.

fields() -> ["API_KEY", "BASE_URL", "ENABLED", "MODEL"].

match_field(_Rest, []) -> none;
match_field(Rest, [Field | Fields]) ->
    Suffix = "_" ++ Field,
    case has_suffix(Suffix, Rest) andalso length(Rest) > length(Suffix) of
        true ->
            NameUpper = lists:sublist(Rest, length(Rest) - length(Suffix)),
            {list_to_binary(normalise(NameUpper)), field_atom(Field)};
        false ->
            match_field(Rest, Fields)
    end.

field_atom("API_KEY") -> api_key;
field_atom("BASE_URL") -> base_url;
field_atom("ENABLED") -> enabled;
field_atom("MODEL") -> model.

%% `MLX_SERVE' -> `mlx-serve': lowercase, underscores to dashes.
normalise(Upper) ->
    [case C of $_ -> $-; _ -> C end || C <- string:lowercase(Upper)].

has_suffix(Suffix, Str) -> lists:prefix(lists:reverse(Suffix), lists:reverse(Str)).

set_absent(Acc, Name, Field, Value) ->
    Inner = maps:get(Name, Acc, #{}),
    case maps:is_key(Field, Inner) of
        true -> Acc;
        false -> maps:put(Name, maps:put(Field, Value, Inner), Acc)
    end.

api_key_fallback(Env, Fields0) ->
    lists:foldl(
      fun({Name, Vars}, {Fields, Sources}) ->
              Inner = maps:get(Name, Fields, #{}),
              case maps:is_key(api_key, Inner) of
                  true -> {Fields, Sources};
                  false ->
                      case first_present(Env, Vars) of
                          none -> {Fields, Sources};
                          {Var, Value} ->
                              {maps:put(Name, maps:put(api_key, Value, Inner), Fields),
                               maps:put(Name, list_to_binary(Var), Sources)}
                      end
              end
      end, {Fields0, #{}}, standard_api_keys()).

base_url_fallback(Env, Fields0) ->
    lists:foldl(
      fun({Name, Vars}, Fields) ->
              Inner = maps:get(Name, Fields, #{}),
              case maps:is_key(base_url, Inner) of
                  true -> Fields;
                  false ->
                      case first_present(Env, Vars) of
                          none -> Fields;
                          {_Var, Value} ->
                              maps:put(Name, maps:put(base_url, Value, Inner), Fields)
                      end
              end
      end, Fields0, standard_base_urls()).

first_present(_Env, []) -> none;
first_present(Env, [Var | Rest]) ->
    case string:trim(maps:get(Var, Env, "")) of
        "" -> first_present(Env, Rest);
        Value -> {Var, list_to_binary(Value)}
    end.

standard_api_keys() ->
    [{<<"openai">>, ["OPENAI_API_KEY"]},
     {<<"anthropic">>, ["ANTHROPIC_API_KEY"]},
     {<<"groq">>, ["GROQ_API_KEY"]},
     {<<"gemini">>, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]},
     {<<"replicate">>, ["REPLICATE_API_TOKEN"]},
     {<<"elevenlabs">>, ["ELEVENLABS_API_KEY"]},
     {<<"runway">>, ["RUNWAY_API_KEY"]},
     {<<"luma">>, ["LUMA_API_KEY"]},
     {<<"minimax">>, ["MINIMAX_API_KEY"]}].

standard_base_urls() ->
    [{<<"openai">>, ["OPENAI_BASE_URL"]},
     {<<"mlx-serve">>, ["MLX_SERVE_BASE_URL"]},
     {<<"ollama">>, ["OLLAMA_BASE_URL", "OLLAMA_HOST"]}].

build_provider(Name, Fields, Sources) ->
    ApiKey = maps:get(api_key, Fields, undefined),
    Enabled = case maps:get(enabled, Fields, undefined) of
                  undefined -> undefined;
                  Raw -> truthy_bin(Raw)
              end,
    KeySource = case ApiKey of
                    undefined -> undefined;
                    _ -> maps:get(Name, Sources, <<"AGORA_PROVIDER">>)
                end,
    #{name => Name,
      api_key => ApiKey,
      key_source => KeySource,
      base_url => maps:get(base_url, Fields, undefined),
      model => maps:get(model, Fields, undefined),
      enabled => Enabled}.

truthy_bin(Bin) ->
    lists:member(string:lowercase(string:trim(binary_to_list(Bin))),
                 ["1", "true", "yes", "on"]).
