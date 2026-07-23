%%% @doc cowboy handler for `GET /health` — liveness + identity (`app.py::health`).
-module(apr_health_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State}.
init(Req0, State) ->
    Req = cowboy_req:reply(
            200,
            #{<<"content-type">> => <<"application/json">>},
            apr_health:body(),
            Req0),
    {ok, Req, State}.
