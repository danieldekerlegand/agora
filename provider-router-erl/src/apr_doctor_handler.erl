%%% @doc cowboy handler for `GET /doctor` — the resolved ladder per modality (`app.py::doctor`).
%%%
%%% Diagnostics only: {@link apr_router:doctor/0} dials nothing, so this is cheap to poll and
%%% honest about *configuration* rather than guessing at liveness. It reports no secrets —
%%% the config view redacts keys to a boolean and a source.
-module(apr_doctor_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State}.
init(Req0, State) ->
    Body = apr_json:encode(apr_router:doctor()),
    Req = cowboy_req:reply(
            200,
            #{<<"content-type">> => <<"application/json">>},
            Body,
            Req0),
    {ok, Req, State}.
