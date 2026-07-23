%%% @doc The router's KCB capability manifest — `koine/specs/capability-bus.md' §2. The
%%% Erlang mirror of `manifest.py'.
%%%
%%% "Every project publishes one manifest declaring who it is and what it offers, in KINP
%%% terms." This is the router's: identity, endpoints, the ports it produces and consumes, and
%%% one invocable capability per modality carrying a `cost' (§2.1) so the registry can prefer
%%% cheap routes and a caller can gate spend before invoking (§3, §5).
%%%
%%% Post-0.3.0 the manifest no longer rides on its own `/.well-known/kcb-manifest.json'; it is
%%% a named **extension** of the provider's A2A AgentCard (§2/§6), served at
%%% {@link manifest_path/0}. {@link body/1} is the manifest itself and becomes the `params' of
%%% the single extension whose `uri' is {@link extension_uri/0}; {@link agent_card/1} is the
%%% card a peer or the registry actually fetches. The pre-0.3.0 path remains registered as a
%%% permanent redirect ({@link legacy_manifest_path/0}) so a 0.2.0 crawler is pointed at the
%%% authoritative card rather than a dead address.
%%%
%%% Two deliberate choices, carried over verbatim:
%%%
%%% * **Cost is advertised for the tier that is actually resolved right now.** A keyless
%%%   router advertises `{"tier": "placeholder", "est_units": 0.0}'; the same binary with an
%%%   OpenAI key advertises the paid rate. Publishing a static price list would make the
%%%   registry's zero-cost preference a lie on exactly the deployments where it matters most.
%%%   The number is priced against a fixed *nominal* request per modality, stated in `basis',
%%%   so two providers' figures are comparable.
%%% * **No endpoint is advertised that is not served.** §2's example carries `mcp' and `a2a'
%%%   addresses; this router serves neither yet, so it publishes neither. An address in a
%%%   manifest is a promise the registry hands to peers who then dial it directly (ADR-0001
%%%   decision 3) — a dead one is worse than an absent one.
-module(apr_manifest).

-export([manifest_path/0, legacy_manifest_path/0, extension_uri/0,
         agent_card/1, body/1, capability_name/1, nominal/1, nominal_basis/1,
         consumed_port/1, produced_port/1, base_url/1]).

-type modality() :: atom().

%% The stable URI of the KCB capability-manifest extension on an AgentCard (§2, 0.3.0).
%% Mirrors `KCB_MANIFEST_EXTENSION_URI' in `schemas/src/agent-card.ts' — the same literal
%% across the polyglot split, exactly as `KCB_VERSION' is.
-define(EXTENSION_URI, <<"https://koine.dev/kcb/manifest/0.3">>).

%% Where the AgentCard (carrying the KCB extension) is served, and how a crawler finds it.
-define(MANIFEST_PATH, <<"/.well-known/agent-card.json">>).

%% The pre-0.3.0 standalone manifest path, kept only as a permanent redirect.
-define(LEGACY_MANIFEST_PATH, <<"/.well-known/kcb-manifest.json">>).

%% The router's own public address, for the endpoints it publishes. Part of the `AGORA_*'
%% block the config keeps, so it needs no separate plumbing.
-define(BASE_URL_ENV, "AGORA_PUBLIC_BASE_URL").
-define(DEFAULT_BASE_URL, <<"http://127.0.0.1:8000">>).

-spec manifest_path() -> binary().
manifest_path() -> ?MANIFEST_PATH.

-spec legacy_manifest_path() -> binary().
legacy_manifest_path() -> ?LEGACY_MANIFEST_PATH.

-spec extension_uri() -> binary().
extension_uri() -> ?EXTENSION_URI.

%% @doc The A2A AgentCard for the router, carrying the KCB manifest as its one extension.
%%
%% `name' is the router's KINP agent id. No `url' (A2A service endpoint) is advertised because
%% the router serves none yet — the same "no endpoint that is not served" rule that keeps
%% `a2a'/`mcp' out of the body's `endpoints'. Never raises.
-spec agent_card(apr_config:config()) -> apr_json:object().
agent_card(Config) ->
    {obj, [{<<"name">>, apr:identity()},
           {<<"capabilities">>,
            {obj, [{<<"extensions">>,
                    [{obj, [{<<"uri">>, ?EXTENSION_URI},
                            {<<"description">>,
                             <<"KCB capability manifest (koine capability-bus.md §2)."/utf8>>},
                            %% §2's example: the KCB extension is advertised, not mandated.
                            {<<"required">>, false},
                            {<<"params">>, body(Config)}]}]}]}}]}.

%% @doc The KCB manifest body — the extension `params' (capability-bus.md §2). Never raises.
-spec body(apr_config:config()) -> apr_json:object().
body(Config) ->
    Base = base_url(Config),
    Modalities = apr_ladder:modalities(),
    {obj, [{<<"kcb_version">>, apr:kcb_version()},
           {<<"identity">>, apr:identity()},
           {<<"version">>, apr:version()},
           {<<"endpoints">>,
            {obj, [{<<"openai">>, <<Base/binary, "/v1">>},
                   {<<"doctor">>, <<Base/binary, "/doctor">>},
                   {<<"manifest">>, <<Base/binary, (manifest_path())/binary>>}]}},
           {<<"produces">>, unique([produced_port(M) || M <- Modalities])},
           {<<"consumes">>, unique([consumed_port(M) || M <- Modalities])},
           {<<"capabilities">>, [capability(M, Base, Config) || M <- Modalities]},
           {<<"auth">>,
            {obj, [{<<"scheme">>, <<"capability-token">>},
                   {<<"grants_required">>,
                    [<<"invoke:", (capability_name(M))/binary>> || M <- Modalities]},
                   %% §5: a grant carries a spend ceiling. This is the router declaring it
                   %% honours one, and where to put it — see `apr_router:complete/3'.
                   {<<"budget_units">>,
                    {obj, [{<<"supported">>, true},
                           {<<"currency">>, <<"budget_units">>},
                           {<<"request_key">>, apr_cost:budget_key()},
                           {<<"header">>, apr_cost:budget_header()}]}}]}}]}.

%% @doc The router's public base URL, trailing slash stripped.
-spec base_url(apr_config:config()) -> binary().
base_url(Config) ->
    case string:trim(maps:get(?BASE_URL_ENV, apr_config:ladder_env(Config), "")) of
        "" -> ?DEFAULT_BASE_URL;
        Value -> strip_trailing_slash(list_to_binary(Value))
    end.

strip_trailing_slash(<<>>) -> <<>>;
strip_trailing_slash(Bin) ->
    case binary:last(Bin) of
        $/ -> strip_trailing_slash(binary:part(Bin, 0, byte_size(Bin) - 1));
        _ -> Bin
    end.

-spec capability_name(modality()) -> binary().
capability_name(Modality) -> <<"generate.", (atom_to_binary(Modality, utf8))/binary>>.

%% @doc What a generation of `Modality' takes in — a knowledge-plane port (§2.1).
-spec consumed_port(modality()) -> apr_json:object().
consumed_port(text) -> {obj, [{<<"plane">>, <<"knowledge">>}, {<<"shape">>, <<"chat-messages">>}]};
consumed_port(_Modality) ->
    {obj, [{<<"plane">>, <<"knowledge">>}, {<<"shape">>, <<"prompt-text">>}]}.

%% @doc What it emits: text is knowledge, everything else is a media port.
%%
%% The media ports carry `world_pattern: "*"' (delta J) — the router is world-agnostic, so it
%% will serve a request for any world rather than claiming one.
-spec produced_port(modality()) -> apr_json:object().
produced_port(text) ->
    {obj, [{<<"plane">>, <<"knowledge">>}, {<<"shape">>, <<"completion-text">>}]};
produced_port(Modality) ->
    {obj, [{<<"plane">>, <<"media">>},
           {<<"media_types">>, [apr_placeholder:media_type(Modality)]},
           {<<"world_pattern">>, <<"*">>}]}.

%% @doc The reference request a capability's `est_units' is priced against. Fixed on purpose:
%% a cost is only comparable between providers if the request is identical.
-spec nominal(modality()) -> apr_json:object().
nominal(text) -> {obj, [{<<"max_tokens">>, 1000}]};
nominal(image) -> {obj, [{<<"n">>, 1}]};
nominal(speech) -> {obj, [{<<"input">>, binary:copy(<<"x">>, 1000)}]};
nominal(music) -> {obj, [{<<"n">>, 1}]};
nominal(video) -> {obj, [{<<"duration">>, 5}]}.

%% @doc Human-readable form of {@link nominal/1}, published as the `cost.basis'.
-spec nominal_basis(modality()) -> binary().
nominal_basis(text) -> <<"1000 completion tokens">>;
nominal_basis(image) -> <<"one image">>;
nominal_basis(speech) -> <<"1000 characters of narration">>;
nominal_basis(music) -> <<"one generation">>;
nominal_basis(video) -> <<"5 seconds of video">>.

capability(Modality, Base, Config) ->
    Backend = apr_router:resolve(Modality, Config),
    Provider = maps:get(provider, Backend),
    Cost = apr_cost:project(Modality, Provider, nominal(Modality),
                            apr_config:ladder_env(Config)),
    #{units := Units, unit := Unit, quantity := Quantity, unpriced := Unpriced} = Cost,
    {obj, [{<<"name">>, capability_name(Modality)},
           {<<"inputs">>, [consumed_port(Modality)]},
           {<<"outputs">>, [produced_port(Modality)]},
           {<<"cost">>,
            {obj, [{<<"tier">>, atom_to_binary(maps:get(tier, Backend), utf8)},
                   {<<"est_units">>, Units},
                   {<<"unit">>, Unit},
                   {<<"quantity">>, Quantity},
                   {<<"basis">>, nominal_basis(Modality)},
                   {<<"unpriced">>, Unpriced}]}},
           {<<"endpoint">>,
            <<Base/binary, "/v1", (apr_backends:endpoints(Modality))/binary>>},
           {<<"provider">>, Provider},
           {<<"model">>, maps:get(model, Backend)}]}.

%% Dedupe ports by value, keeping first-seen order (modalities share knowledge ports, and
%% speech and music share one media type).
unique(Ports) -> unique(Ports, []).

unique([], Seen) -> lists:reverse(Seen);
unique([Port | Rest], Seen) ->
    case lists:member(Port, Seen) of
        true -> unique(Rest, Seen);
        false -> unique(Rest, [Port | Seen])
    end.
