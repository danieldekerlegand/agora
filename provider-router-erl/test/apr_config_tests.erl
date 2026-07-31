%%% @doc eunit: the provider env file — `config.py''s `_load_env_file' / `EnvFileReport'.
%%%
%%% Two rules this file exists to pin. **The environment beats the file**: an explicit
%%% `export' is the stronger statement of intent, and silently overriding it would make the
%%% router disagree with its own environment. **A key on disk is 0600**: a file holding
%%% secrets at looser permissions is tightened in place on load and the fact is reported by
%%% `/doctor' — tightened, not refused, because this router must never fail closed.
-module(apr_config_tests).

-include_lib("eunit/include/eunit.hrl").
-include_lib("kernel/include/file.hrl").

%% --- the report -------------------------------------------------------------

an_absent_env_file_is_reported_not_an_error_test() ->
    Config = read(#{"AGORA_ENV_FILE" => "/nonexistent/agora/.env"}),
    ?assertEqual(#{path => <<"/nonexistent/agora/.env">>, exists => false,
                   tightened => false, error => undefined},
                 apr_config:env_file(Config)).

no_file_read_reports_null_test() ->
    %% `from_env/1' consults no file at all — the injectable form the other suites use.
    ?assertEqual(null, apr_json:get(<<"env_file">>,
                                    apr_config:describe(apr_config:from_env(#{})))).

the_report_is_the_pydantic_field_order_test() ->
    Config = read(#{"AGORA_ENV_FILE" => "/nonexistent/agora/.env"}),
    Report = apr_json:get(<<"env_file">>, apr_config:describe(Config)),
    ?assertEqual([<<"path">>, <<"exists">>, <<"tightened">>, <<"error">>],
                 apr_json:keys(Report)),
    ?assertEqual(null, apr_json:get(<<"error">>, Report)).

%% --- parsing ----------------------------------------------------------------

the_file_configures_a_provider_test() ->
    Path = write("# a comment\n\nOPENAI_API_KEY=sk-from-file\n"
                 "AGORA_PROVIDER_OPENAI_MODEL=\"gpt-from-file\"\nnot a setting\n"),
    try
        Provider = apr_config:provider(read(#{"AGORA_ENV_FILE" => Path}), <<"openai">>),
        ?assert(apr_config:has_key(Provider)),
        ?assertEqual(<<"gpt-from-file">>, maps:get(model, Provider)),
        ?assertEqual(<<"OPENAI_API_KEY">>, maps:get(key_source, Provider))
    after
        file:delete(Path)
    end.

the_process_environment_beats_the_file_test() ->
    Path = write("OPENAI_API_KEY=sk-from-file\n"),
    try
        Config = read(#{"AGORA_ENV_FILE" => Path, "OPENAI_API_KEY" => "sk-exported"}),
        ?assertEqual(<<"sk-exported">>,
                     maps:get(api_key, apr_config:provider(Config, <<"openai">>)))
    after
        file:delete(Path)
    end.

the_file_can_set_the_ladder_test() ->
    Path = write("AGORA_TEXT_LADDER=local,paid\n"),
    try
        Env = apr_config:ladder_env(read(#{"AGORA_ENV_FILE" => Path})),
        ?assertEqual("local,paid", maps:get("AGORA_TEXT_LADDER", Env))
    after
        file:delete(Path)
    end.

%% One namespace, owned by this router: the caller-named `CUNEIFORM_*' alias the ladder was
%% first configured through is gone, so neither an `.env' it names nor a key it spells
%% configures anything. `AGORA_ENV_FILE' points at nothing so the fallback `<cwd>/.env'
%% cannot answer for the file half either.
only_the_neutral_namespace_is_recognised_test() ->
    Path = write("OPENAI_API_KEY=sk-not-read\n"),
    try
        Config = read(#{"AGORA_ENV_FILE" => "/nonexistent/agora/.env",
                        "CUNEIFORM_ENV_FILE" => Path,
                        "CUNEIFORM_PROVIDER_OPENAI_API_KEY" => "sk-also-not-read"}),
        ?assertNot(apr_config:has_key(apr_config:provider(Config, <<"openai">>)))
    after
        file:delete(Path)
    end.

%% --- 0600 -------------------------------------------------------------------

a_secret_bearing_file_is_tightened_in_place_test() ->
    Path = write("OPENAI_API_KEY=sk-loose\n"),
    ok = file:change_mode(Path, 8#644),
    try
        Config = read(#{"AGORA_ENV_FILE" => Path}),
        ?assertMatch(#{exists := true, tightened := true, error := undefined},
                     apr_config:env_file(Config)),
        ?assertEqual(0, mode(Path) band 8#077),
        %% ...and it was read, not refused: the router never fails closed.
        ?assert(apr_config:has_key(apr_config:provider(Config, <<"openai">>)))
    after
        file:delete(Path)
    end.

a_file_holding_no_secret_is_left_alone_test() ->
    Path = write("AGORA_TEXT_LADDER=local\n"),
    ok = file:change_mode(Path, 8#644),
    try
        ?assertMatch(#{tightened := false}, apr_config:env_file(read(#{"AGORA_ENV_FILE" => Path}))),
        ?assertEqual(8#644, mode(Path) band 8#777)
    after
        file:delete(Path)
    end.

an_already_tight_file_is_not_reported_as_tightened_test() ->
    Path = write("OPENAI_API_KEY=sk-tight\n"),
    ok = file:change_mode(Path, 8#600),
    try
        ?assertMatch(#{tightened := false}, apr_config:env_file(read(#{"AGORA_ENV_FILE" => Path})))
    after
        file:delete(Path)
    end.

%% --- helpers ----------------------------------------------------------------

read(Env) -> apr_config:from_env(Env, #{read_file => true}).

write(Contents) ->
    Path = filename:join(temp_dir(),
                         "apr-config-" ++ integer_to_list(erlang:unique_integer([positive]))
                         ++ ".env"),
    ok = file:write_file(Path, Contents),
    Path.

temp_dir() -> os:getenv("TMPDIR", "/tmp").

mode(Path) ->
    {ok, #file_info{mode = Mode}} = file:read_file_info(Path),
    Mode.
