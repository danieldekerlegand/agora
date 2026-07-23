%%% @doc cowboy handler for `GET /.well-known/agent-card.json' — the router's A2A AgentCard,
%%% carrying the KCB capability manifest as its one extension (capability-bus.md §2/§6).
%%%
%%% What the registry indexes: it reads the `capabilities.extensions[]' entry whose `uri' is
%%% the KCB manifest extension URI and takes that entry's `params' as the manifest. The card
%%% is computed from the live configuration on every read, because its advertised cost is the
%%% cost of the tier that resolves *right now* — see {@link apr_manifest}. It reports no
%%% secrets: nothing on the card is derived from a key beyond whether one resolves a tier.
-module(apr_manifest_handler).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State}.
init(Req0, State) ->
    Body = apr_json:encode(apr_manifest:agent_card(apr_config:from_env())),
    Req = cowboy_req:reply(
            200,
            #{<<"content-type">> => <<"application/json">>},
            Body,
            Req0),
    {ok, Req, State}.
