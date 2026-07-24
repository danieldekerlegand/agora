"""The KFT §4.2 egress-class algebra — most-restrictive aggregation over {data ∪ base} (FT-B)."""

from __future__ import annotations

from agora_trainer.egress import EXPORTABLE, LOCAL_ONLY, is_local_only, most_restrictive


class TestMostRestrictive:
    def test_all_exportable_is_exportable(self) -> None:
        assert most_restrictive([EXPORTABLE, EXPORTABLE, EXPORTABLE]) == EXPORTABLE

    def test_any_local_only_makes_the_whole_run_local_only(self) -> None:
        # One local-only input pins the run (KFT §4.2, FT-B) — the load-bearing rule.
        assert most_restrictive([EXPORTABLE, LOCAL_ONLY, EXPORTABLE]) == LOCAL_ONLY

    def test_an_empty_set_is_vacuously_exportable(self) -> None:
        assert most_restrictive([]) == EXPORTABLE


class TestIsLocalOnly:
    def test_it_recognizes_the_pin(self) -> None:
        assert is_local_only(LOCAL_ONLY)
        assert not is_local_only(EXPORTABLE)
