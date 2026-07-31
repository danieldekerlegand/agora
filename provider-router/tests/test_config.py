"""Provider configuration: one typed schema, secrets that cannot leak, 0600 on disk."""

from __future__ import annotations

import stat
from pathlib import Path

from agora_provider_router.config import RouterConfig
from conftest import config_for


def test_the_namespaced_block_parses_into_typed_providers() -> None:
    config = config_for(
        AGORA_PROVIDER_OPENAI_API_KEY="sk-namespaced",
        AGORA_PROVIDER_OPENAI_MODEL="gpt-4o",
        AGORA_PROVIDER_MLX_SERVE_BASE_URL="http://localhost:8080/v1",
    )
    openai = config.provider("openai")
    assert openai.api_key is not None and openai.api_key.get_secret_value() == "sk-namespaced"
    assert openai.model == "gpt-4o"
    assert openai.usable
    # A multi-word provider name round-trips: MLX_SERVE → mlx-serve.
    assert config.provider("mlx-serve").base_url == "http://localhost:8080/v1"


def test_only_the_neutral_namespace_is_recognised() -> None:
    """One namespace, owned by this router — no prefix named after whoever configures it.

    The ladder was first configured through a caller-named ``CUNEIFORM_PROVIDER_*`` block,
    carried as an alias through agora:50 and dropped here: an env namespace named after one
    participant is exactly the coupling the commons must not have. An ``.env`` still spelling
    it configures nothing — loudly absent rather than quietly half-applied.
    """
    config = config_for(
        CUNEIFORM_PROVIDER_OPENAI_API_KEY="sk-x",
        CUNEIFORM_PROVIDER_MLX_SERVE_BASE_URL="http://l",
    )
    assert not config.provider("openai").has_key
    assert config.provider("mlx-serve").base_url is None


def test_the_env_file_var_names_the_provider_file(tmp_path: Path) -> None:
    env_file = tmp_path / "provider.env"
    env_file.write_text("OPENAI_API_KEY=sk-from-file\n")
    config = RouterConfig.from_env({"AGORA_ENV_FILE": str(env_file)})
    key = config.provider("openai").api_key
    assert key is not None and key.get_secret_value() == "sk-from-file"


def test_standard_spellings_are_accepted_and_the_namespaced_form_wins() -> None:
    config = config_for(OPENAI_API_KEY="sk-standard", OLLAMA_HOST="http://localhost:11434/v1")
    openai = config.provider("openai")
    assert openai.api_key is not None and openai.api_key.get_secret_value() == "sk-standard"
    assert openai.key_source == "OPENAI_API_KEY"
    assert config.provider("ollama").base_url == "http://localhost:11434/v1"

    both = config_for(OPENAI_API_KEY="sk-standard", AGORA_PROVIDER_OPENAI_API_KEY="sk-block")
    key = both.provider("openai").api_key
    assert key is not None and key.get_secret_value() == "sk-block"


def test_an_explicit_disable_beats_a_present_key() -> None:
    config = config_for(OPENAI_API_KEY="sk-live", AGORA_PROVIDER_OPENAI_ENABLED="0")
    assert config.provider("openai").has_key
    assert not config.provider("openai").usable


def test_an_unconfigured_provider_reads_back_empty_rather_than_raising() -> None:
    unknown = config_for().provider("nobody")
    assert not unknown.has_key
    assert not unknown.usable


def test_no_reportable_surface_can_carry_a_secret() -> None:
    config = config_for(OPENAI_API_KEY="sk-super-secret")
    surfaces = [repr(config), str(config), str(config.describe()), str(config.model_dump())]
    for surface in surfaces:
        assert "sk-super-secret" not in surface
    described = config.describe()["providers"]
    assert described == [
        {
            "name": "openai",
            "has_key": True,
            "key_source": "OPENAI_API_KEY",
            "base_url": None,
            "model": None,
            "enabled": None,
            "usable": True,
        }
    ]


def test_an_env_file_layers_under_the_real_environment(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# provider settings\nOPENAI_API_KEY=sk-from-file\nGROQ_API_KEY='gsk-quoted'\n"
    )
    config = RouterConfig.from_env({"OPENAI_API_KEY": "sk-exported"}, env_file=env_file)
    exported = config.provider("openai").api_key
    groq = config.provider("groq").api_key
    # An explicit export is the stronger statement of intent; the file fills the gaps.
    assert exported is not None and exported.get_secret_value() == "sk-exported"
    assert groq is not None and groq.get_secret_value() == "gsk-quoted"


def test_a_world_readable_key_file_is_tightened_to_0600(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("OPENAI_API_KEY=sk-loose\n")
    env_file.chmod(0o644)

    config = RouterConfig.from_env({}, env_file=env_file)

    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    assert config.env_file is not None and config.env_file.tightened
    # …and it is still read: tightening is a repair, not a refusal.
    assert config.provider("openai").has_key


def test_a_keyless_env_file_is_left_alone(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("OLLAMA_HOST=http://localhost:11434/v1\n")
    env_file.chmod(0o644)

    config = RouterConfig.from_env({}, env_file=env_file)

    assert stat.S_IMODE(env_file.stat().st_mode) == 0o644
    assert config.env_file is not None and not config.env_file.tightened


def test_a_missing_env_file_is_not_an_error(tmp_path: Path) -> None:
    config = RouterConfig.from_env({}, env_file=tmp_path / "nope.env")
    assert config.env_file is not None
    assert not config.env_file.exists
    assert config.env_file.error is None
