%%% @doc The content-addressed store behind the `fetch' verb — `capability-bus.md' §4.
%%%
%%% "`fetch' — CAS GET by `asset' id; integrity self-verifies against the hash (delta G)."
%%% An asset id *is* its hash, so a fetch needs no trust in the address it came from: the
%%% bytes either hash to the id or they are not the asset.
%%%
%%% The store exists because a stream may deliver a **reference** before the referenced bytes
%%% have propagated (delta L). That is a normal state, not an error: {@link get/1} answers
%%% `{error, not_propagated}' for an id it has never seen, which the fetch surface reports as
%%% a retryable `404' rather than a failure the consumer must handle. A producer never assumes
%%% its bytes are pre-propagated; a consumer never assumes a reference resolves on first ask.
%%%
%%% Deliberately in-memory and unbounded-in-principle: the router's assets are the media
%%% artifacts of the generations it has just served, which are small and short-lived. A real
%%% CAS is a different address entirely, run by whoever runs one — this is only enough to
%%% make the reference in a delta resolvable.
-module(apr_assets).
-behaviour(gen_server).

%% `get/1' and `put/2' are auto-imported BIFs. The CAS spells its two operations the way a
%% CAS spells them, so the auto-imports are dropped rather than the names bent around them.
-compile({no_auto_import, [get/1, put/2]}).

-export([start_link/0, put/2, get/1, exists/1, id_for/1, digest_of/1, fetch_path/1, count/0]).
-export([init/1, handle_call/3, handle_cast/2]).

%% The public named table. Public rather than protected on purpose: a `put' happens on the
%% generation hot path and a `fetch' on a cowboy connection process, and neither should queue
%% behind a registry gen_server for what is a single-key insert or read.
-define(TABLE, apr_assets_cas).

%% The KINP spelling of a content-addressed asset id (`capability-bus.md' §4, delta G).
-define(ID_PREFIX, <<"kinp:asset:sha256:">>).

-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec init([]) -> {ok, map()}.
init([]) ->
    _ = ets:new(?TABLE, [named_table, public, set, {read_concurrency, true}]),
    {ok, #{}}.

handle_call(count, _From, State) ->
    {reply, ets:info(?TABLE, size), State}.

handle_cast(_Message, State) ->
    {noreply, State}.

%% @doc Store `Bytes' and return the id they address to. Storing the same bytes twice is the
%% same id and the same entry — content addressing makes the write idempotent, which is what
%% lets the fan-out redeliver freely (§4).
-spec put(binary(), binary()) -> binary().
put(Bytes, MediaType) when is_binary(Bytes), is_binary(MediaType) ->
    Id = id_for(Bytes),
    _ = case ets:whereis(?TABLE) of
            undefined -> false;
            Table -> ets:insert(Table, {digest_of(Id), MediaType, Bytes})
        end,
    Id.

%% @doc The bytes behind an asset id, or `not_propagated' when they have not arrived yet.
%%
%% Accepts either the full `kinp:asset:sha256:<hex>' id or the bare hex, because the id is
%% what a delta carries and the hex is what fits in a URL path segment.
-spec get(binary()) -> {ok, binary(), binary()} | {error, not_propagated}.
get(Reference) when is_binary(Reference) ->
    Digest = digest_of(Reference),
    case ets:whereis(?TABLE) of
        undefined -> {error, not_propagated};
        Table ->
            case ets:lookup(Table, Digest) of
                [{_Digest, MediaType, Bytes}] -> {ok, MediaType, Bytes};
                [] -> {error, not_propagated}
            end
    end.

-spec exists(binary()) -> boolean().
exists(Reference) ->
    case get(Reference) of
        {ok, _MediaType, _Bytes} -> true;
        {error, not_propagated} -> false
    end.

%% @doc The id `Bytes' address to — the same canonical lowercase-hex sha256 the placeholder's
%% digest uses, so one hash spelling covers the whole surface.
-spec id_for(binary()) -> binary().
id_for(Bytes) when is_binary(Bytes) ->
    <<?ID_PREFIX/binary, (hex(crypto:hash(sha256, Bytes)))/binary>>.

%% @doc The bare digest of an id or reference — the key the store is indexed by.
-spec digest_of(binary()) -> binary().
digest_of(<<"kinp:asset:sha256:", Hex/binary>>) -> Hex;
digest_of(Reference) -> Reference.

%% @doc Where a consumer fetches `Reference' from. Relative on purpose: the router's public
%% base URL is a deployment fact, and a stream event that hard-codes one is wrong the moment
%% the router is proxied.
-spec fetch_path(binary()) -> binary().
fetch_path(Reference) -> <<"/v1/assets/", (digest_of(Reference))/binary>>.

-spec count() -> non_neg_integer().
count() -> gen_server:call(?MODULE, count).

hex(Bin) -> << <<(nibble(N))>> || <<N:4>> <= Bin >>.

nibble(N) when N < 10 -> $0 + N;
nibble(N) -> ($a - 10) + N.
