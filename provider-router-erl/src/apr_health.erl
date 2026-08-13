%%% @doc The `/health` body — byte-identical to `app.py::health`.
%%%
%%% Starlette's `JSONResponse` serializes with compact separators (`","`/`":"`) and
%%% preserves insertion order, so the wire form is exactly
%%% `{"status":"ok","identity":...,"version":...,"kcb_version":"0.4.3"}`. We assemble that
%%% byte string directly rather than route through a JSON encoder, so the ordering and
%%% spacing are guaranteed regardless of any map/encoder behaviour.
-module(apr_health).

-export([body/0]).

%% @doc The exact `/health` response body. Never reports secrets or resolved credentials.
-spec body() -> binary().
body() ->
    iolist_to_binary(
      [<<"{\"status\":\"ok\",\"identity\":\"">>, apr:identity(),
       <<"\",\"version\":\"">>, apr:version(),
       <<"\",\"kcb_version\":\"">>, apr:kcb_version(),
       <<"\"}">>]).
