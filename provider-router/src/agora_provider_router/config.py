"""The router's provider configuration — one typed schema, read from the environment.

The wire format is the ecosystem's existing ``CUNEIFORM_PROVIDER_<NAME>_<FIELD>`` shape
(ported from Analyzer's ``console.env_store``), so an ``.env`` written by a Orchestrator/Analyzer
console configures this router unchanged. ``FIELD`` is one of ``API_KEY``, ``BASE_URL``,
``MODEL``, ``ENABLED``; the common non-namespaced spellings (``OPENAI_API_KEY``,
``MLX_SERVE_BASE_URL``, ``OLLAMA_HOST``, …) are accepted as fallbacks, and the namespaced
form always wins.

Two rules this module exists to enforce:

* **Secrets never leak.** Keys are :class:`~pydantic.SecretStr`, so no repr, log line or
  ``model_dump()`` of a config ever contains one. Everything the HTTP surface reports goes
  through :meth:`ProviderConfig.describe`, which reports *whether* a key is set and where it
  came from — never its value.
* **A key on disk is 0600.** An env file holding secrets that is group/world readable is
  tightened in place on load (and the fact is reported by ``/doctor``). Refusing to read it
  instead would be the other defensible choice, but this router must never fail closed —
  see the always-completes invariant in :mod:`agora_provider_router.router`.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, SecretStr

#: Namespaced prefix owned by the provider settings block.
ENV_PREFIX = "CUNEIFORM_PROVIDER_"

#: Env var naming the file to read provider settings from (else ``<cwd>/.env``).
ENV_FILE_VAR = "CUNEIFORM_ENV_FILE"

#: Prefix of the ladder-ordering variables (see :mod:`agora_provider_router.ladder`), the
#: only part of the environment a :class:`RouterConfig` keeps verbatim.
LADDER_ENV_PREFIX = "AGORA_"

#: Recognised ``CUNEIFORM_PROVIDER_<NAME>_<FIELD>`` suffixes, longest first so that
#: ``..._API_KEY`` is not mis-split as provider ``…_API`` field ``KEY``.
_FIELDS = ("API_KEY", "BASE_URL", "ENABLED", "MODEL")

#: Non-namespaced API-key spellings accepted per provider. The namespaced form wins.
_STANDARD_API_KEYS: dict[str, tuple[str, ...]] = {
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "replicate": ("REPLICATE_API_TOKEN",),
    "elevenlabs": ("ELEVENLABS_API_KEY",),
    "runway": ("RUNWAY_API_KEY",),
    "luma": ("LUMA_API_KEY",),
    "minimax": ("MINIMAX_API_KEY",),
}

#: Non-namespaced base-url spellings, same precedence rule.
_STANDARD_BASE_URLS: dict[str, tuple[str, ...]] = {
    "openai": ("OPENAI_BASE_URL",),
    "mlx-serve": ("MLX_SERVE_BASE_URL",),
    "ollama": ("OLLAMA_BASE_URL", "OLLAMA_HOST"),
}

_TRUTHY = {"1", "true", "yes", "on"}


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def _normalise(name: str) -> str:
    """``MLX_SERVE`` → ``mlx-serve``. The env spelling of a provider name is upper/underscore."""
    return name.lower().replace("_", "-")


class ProviderConfig(BaseModel):
    """One provider's settings. ``enabled`` unset means "enabled iff a key is present"."""

    model_config = ConfigDict(frozen=True)

    name: str
    api_key: SecretStr | None = None
    key_source: str | None = None
    base_url: str | None = None
    model: str | None = None
    enabled: bool | None = None

    @property
    def has_key(self) -> bool:
        return self.api_key is not None and bool(self.api_key.get_secret_value())

    @property
    def usable(self) -> bool:
        """Configured to be dispatched to: not explicitly disabled, and reachable somehow.

        A key implies intent to use the provider; a bare ``base_url`` is enough for the
        keyless local tiers (mlx-serve, Ollama).
        """
        if self.enabled is False:
            return False
        return self.has_key or bool(self.base_url)

    def describe(self) -> dict[str, object]:
        """The reportable view — every field except the secret itself."""
        return {
            "name": self.name,
            "has_key": self.has_key,
            "key_source": self.key_source,
            "base_url": self.base_url,
            "model": self.model,
            "enabled": self.enabled,
            "usable": self.usable,
        }


class EnvFileReport(BaseModel):
    """What happened when the provider env file was read — reported by ``/doctor``."""

    model_config = ConfigDict(frozen=True)

    path: str
    exists: bool
    #: True when the file held secrets at looser-than-0600 permissions and was tightened.
    tightened: bool = False
    #: Set when the file could not be read at all (never fatal — the router keeps going).
    error: str | None = None


class RouterConfig(BaseModel):
    """Every provider setting the router knows about, parsed once from an env mapping."""

    model_config = ConfigDict(frozen=True)

    providers: dict[str, ProviderConfig] = Field(default_factory=dict)
    #: The ladder-ordering variables (``AGORA_*``) ONLY, interpreted by
    #: :mod:`agora_provider_router.ladder`. Deliberately not the whole environment: a
    #: config that retained it would put every exported key into its own ``repr``, and the
    #: secrets-never-logged rule would then depend on nobody ever logging a config.
    env: dict[str, str] = Field(default_factory=dict)
    env_file: EnvFileReport | None = None

    def provider(self, name: str) -> ProviderConfig:
        """``name``'s settings, or an empty (unusable) record — never ``KeyError``."""
        return self.providers.get(name, ProviderConfig(name=name))

    def describe(self) -> dict[str, object]:
        """Secret-free summary for ``/doctor``."""
        return {
            "providers": [p.describe() for p in sorted(self.providers.values(), key=_by_name)],
            "env_file": self.env_file.model_dump() if self.env_file else None,
        }

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
        *,
        env_file: Path | None = None,
        read_file: bool = True,
    ) -> RouterConfig:
        """Parse ``env`` (default ``os.environ``), layering the env file *under* it.

        A real environment variable beats the file: an explicit ``export`` is the stronger
        statement of intent, and silently overriding it would make the process disagree
        with its own environment.
        """
        env = dict(os.environ if env is None else env)
        report: EnvFileReport | None = None
        if read_file:
            path = env_file if env_file is not None else _env_file_path(env)
            file_values, report = _load_env_file(path)
            env = {**file_values, **env}
        ladder_env = {k: v for k, v in env.items() if k.startswith(LADDER_ENV_PREFIX)}
        return cls(providers=_parse_providers(env), env=ladder_env, env_file=report)


def _by_name(provider: ProviderConfig) -> str:
    return provider.name


def _env_file_path(env: Mapping[str, str]) -> Path:
    override = env.get(ENV_FILE_VAR)
    return Path(override) if override else Path.cwd() / ".env"


def _load_env_file(path: Path) -> tuple[dict[str, str], EnvFileReport]:
    """Parse ``path`` if it exists, tightening it to 0600 first when it holds secrets."""
    if not path.exists():
        return {}, EnvFileReport(path=str(path), exists=False)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {}, EnvFileReport(path=str(path), exists=True, error=str(exc))
    values = _parse_env_text(text)
    tightened = False
    if any(_is_secret(key) and value for key, value in values.items()):
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            path.chmod(0o600)
            tightened = True
    return values, EnvFileReport(path=str(path), exists=True, tightened=tightened)


def _parse_env_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw = stripped.split("=", 1)
        values[key.strip()] = _unquote(raw)
    return values


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _is_secret(key: str) -> bool:
    upper = key.upper()
    return upper.endswith(("API_KEY", "_TOKEN", "_SECRET"))


def _split_namespaced(key: str) -> tuple[str, str] | None:
    """``CUNEIFORM_PROVIDER_MLX_SERVE_BASE_URL`` → ``("mlx-serve", "base_url")``."""
    if not key.startswith(ENV_PREFIX):
        return None
    rest = key[len(ENV_PREFIX) :]
    for field in _FIELDS:
        suffix = f"_{field}"
        if rest.endswith(suffix) and len(rest) > len(suffix):
            return _normalise(rest[: -len(suffix)]), field.lower()
    return None


def _parse_providers(env: Mapping[str, str]) -> dict[str, ProviderConfig]:
    """Fold the namespaced block and the standard fallbacks into one record per provider."""
    fields: dict[str, dict[str, str]] = {}
    for key, value in env.items():
        split = _split_namespaced(key)
        if split is None or not str(value).strip():
            continue
        name, field = split
        fields.setdefault(name, {})[field] = str(value).strip()

    sources: dict[str, str] = {}
    for name, names in _STANDARD_API_KEYS.items():
        if "api_key" in fields.get(name, {}):
            continue
        for candidate in names:
            standard = env.get(candidate)
            if standard and standard.strip():
                fields.setdefault(name, {})["api_key"] = standard.strip()
                sources[name] = candidate
                break
    for name, names in _STANDARD_BASE_URLS.items():
        if "base_url" in fields.get(name, {}):
            continue
        for candidate in names:
            standard = env.get(candidate)
            if standard and standard.strip():
                fields.setdefault(name, {})["base_url"] = standard.strip()
                break

    providers: dict[str, ProviderConfig] = {}
    for name, values in fields.items():
        api_key = values.get("api_key")
        enabled = _truthy(values["enabled"]) if "enabled" in values else None
        providers[name] = ProviderConfig(
            name=name,
            api_key=SecretStr(api_key) if api_key else None,
            key_source=(sources.get(name, ENV_PREFIX.rstrip("_")) if api_key else None),
            base_url=values.get("base_url"),
            model=values.get("model"),
            enabled=enabled,
        )
    return providers
