%%% @doc cowboy handler for a permanent redirect — `app.py::legacy_kcb_manifest'.
%%%
%%% The pre-0.3.0 standalone `/.well-known/kcb-manifest.json' points a 0.2.0 crawler at the
%%% AgentCard the manifest was folded onto (capability-bus.md §6) rather than at a dead
%%% address. 308 and not 301: the method and body must be preserved, and the old address is
%%% permanently gone, not merely relocated for this request.
-module(apr_redirect_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State} when State :: map().
init(Req0, State) ->
    Req = cowboy_req:reply(
            maps:get(status, State, 308),
            #{<<"location">> => maps:get(location, State)},
            <<>>,
            Req0),
    {ok, Req, State}.
