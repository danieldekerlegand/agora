%%% @doc Placeholder handler for the not-yet-implemented routes (US-1).
%%%
%%% Every registered path answers rather than crashing the listener: an unimplemented
%%% route returns a defined `501 Not Implemented` with a small JSON body naming the route,
%%% so the full `app.py` surface is reachable now and each handler is swapped in as its
%%% story lands (`/doctor` in US-2, the generation POSTs + manifest in US-2..US-5).
-module(apr_stub_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State} when State :: map().
init(Req0, State) ->
    Name = atom_to_binary(maps:get(name, State, unknown), utf8),
    Body = iolist_to_binary(
             [<<"{\"error\":\"not_implemented\",\"route\":\"">>, Name, <<"\"}">>]),
    Req = cowboy_req:reply(
            501,
            #{<<"content-type">> => <<"application/json">>},
            Body,
            Req0),
    {ok, Req, State}.
