%%% @doc cowboy handler for `GET /v1/models' — the Erlang mirror of `app.py::models'.
%%%
%%% OpenAI's model list, answered from the ladder: every model the configured ladder can
%%% currently resolve to, one entry per (modality, candidate rung) in ladder order. The
%%% placeholder is a candidate like any other, so a bare node still lists five models — the
%%% always-completes invariant, readable off the model list.
%%%
%%% Each entry carries the OpenAI keys a client expects plus an `agora' key naming which
%%% modality and tier it came from, exactly as `app.py' does. It dials nothing.
-module(apr_models_handler).
-behaviour(cowboy_handler).

-export([init/2, body/1]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State}.
init(Req0, State) ->
    Req = cowboy_req:reply(
            200,
            #{<<"content-type">> => <<"application/json">>},
            apr_json:encode(body(apr_config:from_env())),
            Req0),
    {ok, Req, State}.

%% @doc The `/v1/models' body for a configuration.
-spec body(apr_config:config()) -> apr_json:object().
body(Config) ->
    Data = [entry(Modality, Backend)
            || Modality <- apr_ladder:modalities(),
               Backend <- apr_router:candidates(Modality, Config)],
    {obj, [{<<"object">>, <<"list">>}, {<<"data">>, Data}]}.

entry(Modality, Backend) ->
    {obj, [{<<"id">>, maps:get(model, Backend)},
           {<<"object">>, <<"model">>},
           {<<"created">>, 0},
           {<<"owned_by">>, maps:get(provider, Backend)},
           {<<"agora">>, {obj, [{<<"modality">>, atom_to_binary(Modality, utf8)},
                                {<<"tier">>, atom_to_binary(maps:get(tier, Backend), utf8)}]}}]}.
