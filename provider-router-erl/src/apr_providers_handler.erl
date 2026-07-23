%%% @doc cowboy handler for `GET /v1/providers' — the Erlang mirror of `app.py::providers'.
%%%
%%% The vendor vocabulary: what each modality prefers, which wire each vendor speaks and
%%% where it lives, plus the two keyless local providers. A static declaration — no
%%% configuration is read, so it reports no secrets and answers identically on every node.
%%% This is what a console renders a provider picker from.
-module(apr_providers_handler).
-behaviour(cowboy_handler).

-export([init/2, body/0]).

-spec init(cowboy_req:req(), State) -> {ok, cowboy_req:req(), State}.
init(Req0, State) ->
    Req = cowboy_req:reply(
            200,
            #{<<"content-type">> => <<"application/json">>},
            apr_json:encode(body()),
            Req0),
    {ok, Req, State}.

%% @doc The `/v1/providers' body. Modalities in ladder order, vendors sorted by name.
-spec body() -> apr_json:object().
body() ->
    Vendors = apr_backends:paid_vendors(),
    {obj, [{<<"modalities">>,
            {obj, [{atom_to_binary(Modality, utf8), apr_backends:paid_providers(Modality)}
                   || Modality <- apr_ladder:modalities()]}},
           {<<"vendors">>,
            [vendor(Name, maps:get(Name, Vendors)) || Name <- lists:sort(maps:keys(Vendors))]},
           {<<"keyless">>, [apr_backends:mlx_provider(), apr_backends:local_provider()]}]}.

vendor(Name, Vendor) ->
    {obj, [{<<"name">>, Name},
           {<<"wire">>, atom_to_binary(maps:get(wire, Vendor), utf8)},
           {<<"base_url">>, maps:get(base_url, Vendor, null)}]}.
