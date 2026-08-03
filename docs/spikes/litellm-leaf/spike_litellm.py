"""Runnable evidence for the LiteLLM leaf-gateway spike (docs/spike-litellm-leaf.md).

THROWAWAY. This is not agora code: it imports nothing from `agora_provider_router`, ships
outside every area gate, and exists only so the spike report's verdicts cite behaviour that
was observed rather than remembered. Run it with `./run.sh`, which builds a scratch venv,
installs LiteLLM into it and prints the transcript quoted in the report.

Every experiment is offline. The "paid" rungs are either LiteLLM's own `mock_response` or a
base URL on 127.0.0.1:1 (nothing listens there, so a connection error *proves* the address
that was dialed). No API key is real and no request leaves the machine.

Each experiment prints `EXPERIMENT <n> <slug>` and then `-> <observation>` lines. A line
beginning `!!` is a finding that contradicts what a reader might assume LiteLLM does.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import inspect
from typing import Any

import litellm
from litellm import CustomLLM, Router
from litellm.types.utils import Choices, Message, ModelResponse, Usage

litellm.suppress_debug_info = True

#: Tokens the projection assumes a completion will produce when the request does not cap it.
#: agora's own `cost.DEFAULT_COMPLETION_TOKENS`, restated here so the shim is self-contained.
ASSUMED_COMPLETION_TOKENS = 1024

MESSAGES = [{"role": "user", "content": "hello"}]


def head(number: int, slug: str) -> None:
    print(f"\nEXPERIMENT {number} {slug}")


def note(text: str) -> None:
    print(f"  -> {text}")


def finding(text: str) -> None:
    print(f"  !! {text}")


# --------------------------------------------------------------------------------------
# The placeholder rung, expressed as a LiteLLM custom provider.
# --------------------------------------------------------------------------------------


class PlaceholderLLM(CustomLLM):
    """A deterministic, offline, zero-token responder — agora's terminal rung.

    Both `completion` and `acompletion` are implemented: LiteLLM's base `CustomLLM` raises
    `CustomLLMError("Not implemented yet!")` for whichever half you leave out, and the
    Router only ever takes the async half.
    """

    def __init__(self) -> None:
        self.calls = 0

    def _answer(self, model: str) -> ModelResponse:
        self.calls += 1
        return ModelResponse(
            id="agora-placeholder",
            created=0,
            model=model,
            object="chat.completion",
            choices=[
                Choices(
                    index=0,
                    finish_reason="stop",
                    message=Message(role="assistant", content="[placeholder:text] deterministic"),
                )
            ],
            usage=Usage(prompt_tokens=0, completion_tokens=0, total_tokens=0),
        )

    def completion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        return self._answer(self._model(kwargs))

    async def acompletion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        return self._answer(self._model(kwargs))

    @staticmethod
    def _model(kwargs: dict[str, Any]) -> str:
        # LiteLLM strips the provider prefix before handing the handler its model, so the
        # response would otherwise come back named plain "text".
        return f"agora-placeholder/{kwargs.get('model') or 'text'}"


class SpyPaidLLM(CustomLLM):
    """Stands in for a paid rung, and counts every dial. Used to prove a rung was SKIPPED."""

    def __init__(self) -> None:
        self.calls = 0

    async def acompletion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        self.calls += 1
        return ModelResponse(
            id="spy-paid",
            created=0,
            model=str(kwargs.get("model") or "spy-paid"),
            object="chat.completion",
            choices=[
                Choices(
                    index=0,
                    finish_reason="stop",
                    message=Message(role="assistant", content="[paid] answered"),
                )
            ],
            usage=Usage(prompt_tokens=10, completion_tokens=10, total_tokens=20),
        )


PLACEHOLDER = PlaceholderLLM()
SPY_PAID = SpyPaidLLM()


def register_custom_providers() -> None:
    """Make the two custom providers visible to BOTH `litellm.completion` and the Router."""
    litellm.custom_provider_map = [
        {"provider": "agora-placeholder", "custom_handler": PLACEHOLDER},
        {"provider": "spy-paid", "custom_handler": SPY_PAID},
    ]
    # Without this the top-level SDK finds the handler but Router construction does not:
    # `get_llm_provider` reads `litellm._custom_providers`, which only this populates.
    litellm.utils.custom_llm_setup()


# --------------------------------------------------------------------------------------
# Experiments
# --------------------------------------------------------------------------------------


def exp1_openai_surface() -> None:
    head(1, "openai-surface — an OpenAI-compatible request, no key, no network")
    response = litellm.completion(model="gpt-4o-mini", messages=MESSAGES, mock_response="hello")
    note(f"choices[0].message.content = {response.choices[0].message.content!r}")
    note(f"model={response.model} object={response.object} total_tokens={response.usage.total_tokens}")
    note(f"completion_cost = ${litellm.completion_cost(completion_response=response)}")


def exp2_placeholder_provider() -> None:
    head(2, "placeholder-provider — the zero-spend terminal rung as a CustomLLM")
    before = PLACEHOLDER.calls
    response = litellm.completion(model="agora-placeholder/text", messages=MESSAGES)
    note(f"content = {response.choices[0].message.content!r}")
    note(f"usage.total_tokens = {response.usage.total_tokens} (nothing to bill)")
    note(f"handler dialed {PLACEHOLDER.calls - before} time(s); no socket was opened")
    try:
        cost = litellm.completion_cost(completion_response=response)
        note(f"completion_cost = ${cost}")
    except Exception as exc:  # noqa: BLE001 — the failure IS the observation
        finding(
            f"completion_cost({response.model!r}) raised {type(exc).__name__}: "
            f"{str(exc).splitlines()[0]} — a custom provider is unpriced unless registered"
        )


async def exp3_always_completes() -> None:
    head(3, "always-completes-fallback — paid rung unreachable, placeholder answers")
    router = Router(
        model_list=[
            {
                "model_name": "agora-text",
                "litellm_params": {
                    "model": "openai/gpt-4o-mini",
                    "api_base": "http://127.0.0.1:1/v1",
                    "api_key": "sk-not-a-real-key",
                },
            },
            {
                "model_name": "agora-placeholder",
                "litellm_params": {"model": "agora-placeholder/text"},
            },
        ],
        fallbacks=[{"agora-text": ["agora-placeholder"]}],
        num_retries=0,
        cooldown_time=0,
        timeout=2,
    )
    response = await router.acompletion(model="agora-text", messages=MESSAGES)
    note(f"asked for agora-text, served by {response.model!r}: {response.choices[0].message.content!r}")
    note("the unreachable paid rung errored and the fallback chain continued — no exception")
    finding(
        "the chain is terminal only because the LAST entry cannot fail; LiteLLM has no notion "
        "of a rung that must always answer, so agora owns that guarantee either way"
    )


async def exp4_mlx_tier() -> None:
    head(4, "mlx-tier — an OpenAI-compatible self-hosted server at a configured base URL")
    model = "openai/mlx-community/Qwen3-8B-4bit"
    _, provider, _, _ = litellm.get_llm_provider(model=model)
    note(f"get_llm_provider({model!r}) -> provider={provider!r}")
    try:
        await litellm.acompletion(
            model=model,
            messages=MESSAGES,
            api_base="http://127.0.0.1:1/v1",
            api_key="not-needed",
            timeout=2,
        )
    except Exception as exc:  # noqa: BLE001 — the connection error is the evidence
        note(f"dialing the configured base URL failed as expected: {type(exc).__name__}")
    note("mlx-serve needs no adapter: it is `openai/<model>` + api_base, exactly as today")


async def exp5_local_tier() -> None:
    head(5, "local-ollama-tier — a first-class LiteLLM provider")
    model = "ollama_chat/llama3.2"
    _, provider, _, _ = litellm.get_llm_provider(model=model)
    note(f"get_llm_provider({model!r}) -> provider={provider!r}")
    try:
        await litellm.acompletion(
            model=model, messages=MESSAGES, api_base="http://127.0.0.1:1", timeout=2
        )
    except Exception as exc:  # noqa: BLE001 — the connection error is the evidence
        note(f"dialing the configured base URL failed as expected: {type(exc).__name__}")


def exp6_cost_estimation() -> None:
    head(6, "cost-estimation — pricing a rung BEFORE it is dialed")
    prompt_tokens = litellm.token_counter(model="gpt-4o-mini", messages=MESSAGES)
    note(f"token_counter(gpt-4o-mini, prompt) = {prompt_tokens}")
    for model in ("gpt-4o-mini", "groq/llama-3.3-70b-versatile"):
        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model, prompt_tokens=prompt_tokens, completion_tokens=ASSUMED_COMPLETION_TOKENS
        )
        note(f"cost_per_token({model}) -> ${prompt_cost + completion_cost:.8f} projected")
    note(f"'ollama/llama3.2' in the built-in cost map: {'ollama/llama3.2' in litellm.model_cost}")
    for model in ("ollama/llama3.2", "mlx-community/Qwen3-8B-4bit"):
        try:
            priced = litellm.cost_per_token(
                model=model, prompt_tokens=1000, completion_tokens=1000
            )
            finding(
                f"cost_per_token({model!r}) = {priced} for an UNMAPPED model — LiteLLM's "
                "estimator says 'free' where it means 'unknown'. agora's `unpriced` flag "
                "(cost.rate_for) exists precisely so that cannot pass a ceiling"
            )
        except Exception as exc:  # noqa: BLE001 — the raise is the observation
            note(
                f"cost_per_token({model!r}) raised {type(exc).__name__} — the keyless tiers are "
                "absent from the built-in map; a rate must be DECLARED per deployment"
            )
    note("declaring one: litellm_params={'input_cost_per_token': 0.0, 'output_cost_per_token': 0.0}")
    Router(
        model_list=[
            {
                "model_name": "mlx",
                "litellm_params": {
                    "model": "openai/mlx-community/Qwen3-8B-4bit",
                    "api_base": "http://127.0.0.1:1/v1",
                    "api_key": "none",
                    "input_cost_per_token": 0.0,
                    "output_cost_per_token": 0.0,
                },
            }
        ],
        num_retries=0,
    )
    note(
        "after Router registration, cost_per_token(openai/mlx-community/Qwen3-8B-4bit) = "
        f"{litellm.cost_per_token(model='openai/mlx-community/Qwen3-8B-4bit', prompt_tokens=100, completion_tokens=100)}"
    )
    unknown = litellm.completion(model="gpt-4o-mini", messages=MESSAGES, mock_response="x")
    unknown.model = "mystery-model-9000"
    try:
        litellm.completion_cost(completion_response=unknown)
        finding("an UNMAPPED model priced silently — an unknown vendor would read as free")
    except Exception as exc:  # noqa: BLE001 — the raise is the observation
        note(
            f"an unmapped model raises ({type(exc).__name__}) rather than pricing 0 — LiteLLM "
            "fails loud, but at SETTLE time, not as a routing signal"
        )


def exp7_global_budget() -> None:
    head(7, "budget-ceiling-global — what litellm.max_budget actually does")
    note(
        "completion() budget-ish parameters: "
        f"{[p for p in inspect.signature(litellm.completion).parameters if 'budget' in p]}"
    )
    note(
        "Router.acompletion parameters: "
        f"{list(inspect.signature(Router.acompletion).parameters)}"
    )
    finding("there is NO per-request spend ceiling parameter anywhere on the call surface")
    litellm.max_budget = 0.01
    litellm._current_cost = 0.0
    try:
        litellm.completion(model="gpt-4o-mini", messages=MESSAGES, mock_response="x")
        note("with _current_cost=0 the call proceeds (the ceiling is checked against spend so far)")
    except Exception as exc:  # noqa: BLE001
        note(f"unexpected: {type(exc).__name__}")
    litellm._current_cost = 5.0
    try:
        litellm.completion(model="gpt-4o-mini", messages=MESSAGES, mock_response="x")
        finding("max_budget did not fire even over the ceiling")
    except Exception as exc:  # noqa: BLE001 — the raise is the observation
        note(f"with _current_cost=5.0 > max_budget=0.01: {type(exc).__name__}: {exc}")
        finding(
            "it ABORTS the request. It does not fall through to a cheaper rung — and it is a "
            "process-global CUMULATIVE ceiling, not the caller's per-request one"
        )
    litellm.max_budget = 0.0
    litellm._current_cost = 0.0


async def exp8_per_request_ceiling_shim() -> None:
    head(8, "budget-ceiling-per-request — the shim agora must keep, and its proof")
    # A per-deployment `input_cost_per_token` reaches the Router's model_info but NOT the
    # global cost map that `cost_per_token` reads, so the projection has to be fed from a
    # sheet agora declares. That sheet is exactly provider-router's prices.toml.
    litellm.register_model(
        {
            "spy-paid/gpt-4o-mini": {
                "input_cost_per_token": 1e-05,
                "output_cost_per_token": 1e-05,
                "litellm_provider": "spy-paid",
                "mode": "chat",
            },
            "agora-placeholder/text": {
                "input_cost_per_token": 0.0,
                "output_cost_per_token": 0.0,
                "litellm_provider": "agora-placeholder",
                "mode": "chat",
            },
        }
    )
    ladder = [
        {"model_name": "paid", "litellm_params": {"model": "spy-paid/gpt-4o-mini"}},
        {"model_name": "placeholder", "litellm_params": {"model": "agora-placeholder/text"}},
    ]
    router = Router(model_list=ladder, num_retries=0, cooldown_time=0)
    ceiling_usd = 0.0
    prompt_tokens = litellm.token_counter(model="gpt-4o-mini", messages=MESSAGES)

    affordable = []
    for rung in ladder:
        model = str(rung["litellm_params"]["model"])
        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model, prompt_tokens=prompt_tokens, completion_tokens=ASSUMED_COMPLETION_TOKENS
        )
        projected = prompt_cost + completion_cost
        verdict = "affordable" if projected <= ceiling_usd else "SKIPPED (over ceiling, not dialed)"
        note(
            f"{rung['model_name']:12s} projected ${projected:.6f} vs ceiling "
            f"${ceiling_usd:.6f} -> {verdict}"
        )
        if projected <= ceiling_usd:
            affordable.append(str(rung["model_name"]))

    before = SPY_PAID.calls
    response = await router.acompletion(model=affordable[0], messages=MESSAGES)
    note(f"served by {response.model!r}: {response.choices[0].message.content!r}")
    dials = SPY_PAID.calls - before
    note(f"paid rung dialed {dials} time(s) — {'PROVEN SKIPPED' if dials == 0 else 'DIALED!'}")
    finding(
        "this filter is ~10 lines and lives OUTSIDE LiteLLM: the ladder order is a preference, "
        "the ceiling is a constraint, and LiteLLM models neither as a pre-dial refusal"
    )
    note("for contrast, LiteLLM's own cost strategy RANKS but never refuses:")
    ranked = Router(
        model_list=[
            {
                "model_name": "text",
                "litellm_params": {
                    "model": "openai/gpt-4o-mini",
                    "api_key": "sk-x",
                    "mock_response": "a",
                },
            },
            {
                "model_name": "text",
                "litellm_params": {
                    "model": "groq/llama-3.3-70b-versatile",
                    "api_key": "sk-x",
                    "mock_response": "b",
                },
            },
        ],
        routing_strategy="cost-based-routing",
        num_retries=0,
    )
    picked = await ranked.acompletion(model="text", messages=MESSAGES)
    note(f"cost-based-routing picked {picked.model!r} (the cheaper of two PAID rungs)")


def exp9_modality_surface() -> None:
    head(9, "modality-surface — which of agora's five modalities LiteLLM speaks")
    for modality, attribute in (
        ("text", "acompletion"),
        ("image", "aimage_generation"),
        ("speech", "aspeech"),
        ("video", "avideo_generation"),
        ("music", "amusic_generation"),
    ):
        present = callable(getattr(litellm, attribute, None))
        note(f"{modality:6s} litellm.{attribute:20s} {'present' if present else 'ABSENT'}")
    finding(
        "music has no LiteLLM surface at all — /v1/audio/music-generations is agora's own "
        "route over its own vendors and stays hand-built"
    )


async def main() -> None:
    print(f"litellm {importlib.metadata.version('litellm')}")
    register_custom_providers()
    exp1_openai_surface()
    exp2_placeholder_provider()
    await exp3_always_completes()
    await exp4_mlx_tier()
    await exp5_local_tier()
    exp6_cost_estimation()
    exp7_global_budget()
    await exp8_per_request_ceiling_shim()
    exp9_modality_surface()
    print("\nall experiments ran")


if __name__ == "__main__":
    asyncio.run(main())
