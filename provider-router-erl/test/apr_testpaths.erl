%%% @doc Locating the sibling areas of the commons from inside a test run.
%%%
%%% Two of US-6's assertions are cross-area — the console's captured session
%%% (`console/src/fixtures/provider-router.session.json') and the TypeScript spec-version pin
%%% (`schemas/src/versions.ts') — and neither area is on a fixed path relative to a rebar3
%%% test's working directory, which differs between `eunit' and `ct'.
%%%
%%% So: walk up from the working directory looking for the file. Absent is not a failure —
%%% `provider-router-erl/' must stay extractable on its own (the same "standalone checkout"
%%% skip the Python suite spells with `pytest.mark.skipif'), so a caller that cannot find the
%%% file skips the assertion rather than failing it. What must never happen is a *silent*
%%% pass: every caller reports the skip.
-module(apr_testpaths).

-export([repo_file/1]).

%% @doc `{ok, AbsolutePath}' for a repo-relative path, or `not_found' outside the commons.
-spec repo_file(string()) -> {ok, string()} | not_found.
repo_file(Relative) ->
    {ok, Cwd} = file:get_cwd(),
    search_up(filename:split(Cwd), Relative).

search_up([], _Relative) -> not_found;
search_up(Segments, Relative) ->
    Candidate = filename:join(filename:join(Segments), Relative),
    case filelib:is_file(Candidate) of
        true -> {ok, Candidate};
        false -> search_up(lists:droplast(Segments), Relative)
    end.
