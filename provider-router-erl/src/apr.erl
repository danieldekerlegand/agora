%%% @doc Constants-only module, the Erlang mirror of `agora_provider_router/__init__.py`.
%%%
%%% Kept dependency-free so every other module can import it. The values are byte-identical
%%% to the Python router's: `__version__`, `KCB_VERSION`, `ROUTER_IDENTITY` and its
%%% `AGORA_ROUTER_IDENTITY` override (`__init__.py`).
-module(apr).

-export([version/0, kcb_version/0, default_identity/0, identity/0,
         identity_env_var/0, port/0]).

%% @doc The build version — mirrors `__init__.py::__version__`.
-spec version() -> binary().
version() -> <<"0.1.0">>.

%% @doc The koine capability-bus version this build speaks — `__init__.py::KCB_VERSION`.
%% Kept in step with `schemas/src/versions.ts` SPEC_VERSIONS.kcb (asserted in US-6).
-spec kcb_version() -> binary().
kcb_version() -> <<"0.2.0">>.

%% @doc The identity a bare deployment reports — `__init__.py::_DEFAULT_ROUTER_IDENTITY`.
-spec default_identity() -> binary().
default_identity() -> <<"agora:agent:provider-router">>.

%% @doc The env var that overrides the router's KINP identity — `ROUTER_IDENTITY_ENV_VAR`.
-spec identity_env_var() -> string().
identity_env_var() -> "AGORA_ROUTER_IDENTITY".

%% @doc The resolved identity: the override, stripped, when non-empty; else the default.
%% Mirrors `os.environ.get(...).strip() or _DEFAULT_ROUTER_IDENTITY`.
-spec identity() -> binary().
identity() ->
    case string:trim(os:getenv(identity_env_var(), "")) of
        "" -> default_identity();
        Value -> list_to_binary(Value)
    end.

%% @doc The listen port: `AGORA_PROVIDER_PORT` when set and numeric, else the app-env
%% default (8080). A port of 0 lets the OS assign one — the ct suite queries it back.
-spec port() -> non_neg_integer().
port() ->
    case os:getenv("AGORA_PROVIDER_PORT") of
        false -> application:get_env(agora_provider_router, port, 8080);
        "" -> application:get_env(agora_provider_router, port, 8080);
        Value -> list_to_integer(Value)
    end.
