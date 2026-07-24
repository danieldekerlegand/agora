"""The diffusers rung + the FT-I paired-sample join (KFT §4.1, §5.3, §9)."""

from __future__ import annotations

from typing import Any

from agora_trainer.diffusers import DiffusersAdapter
from agora_trainer.pairing import AssetMeta
from conftest import valid_text_job


def _t2i_job(**overrides: Any) -> dict[str, Any]:
    job = valid_text_job(
        modality="text-to-image",
        method="lora",
        dataset={"media": ["analyzer:asset:blake3-corpus-array"]},
    )
    job.update(overrides)
    return job


class TestPairedSamples:
    def test_samples_come_from_the_training_records_not_the_corpus_array(self) -> None:
        """FT-I: the (asset, text) join rides the header training records, not dataset.media."""
        records = [
            {"asset": "analyzer:asset:blake3-rowA", "text": "a red bicycle"},
            {"asset": "analyzer:asset:blake3-rowB", "text": "a blue kite"},
        ]
        adapter = DiffusersAdapter(records_source=records)
        prepared = adapter.prepare_data(_t2i_job())
        assert [s.asset for s in prepared.samples] == [
            "analyzer:asset:blake3-rowA",
            "analyzer:asset:blake3-rowB",
        ]
        assert [s.text for s in prepared.samples] == ["a red bicycle", "a blue kite"]
        # the corpus array is the fetch manifest, never the join — its id is not a sample.
        assert "analyzer:asset:blake3-corpus-array" not in prepared.media

    def test_a_row_missing_a_side_is_not_a_usable_pair(self) -> None:
        records = [
            {"asset": "analyzer:asset:blake3-ok", "text": "a caption"},
            {"asset": "analyzer:asset:blake3-nocaption"},  # no text — not a join
            {"text": "orphan caption"},  # no asset — not a join
        ]
        prepared = DiffusersAdapter(records_source=records).prepare_data(_t2i_job())
        assert [s.asset for s in prepared.samples] == ["analyzer:asset:blake3-ok"]

    def test_each_referenced_asset_is_fetched_lazily(self) -> None:
        """AC1: media assets are fetched lazily via fetch:asset (KMI §7), never inlined."""
        fetched: list[str] = []

        def fetch(asset: str) -> AssetMeta:
            fetched.append(asset)
            return AssetMeta(asset=asset)

        records = [
            {"asset": "analyzer:asset:blake3-a", "text": "one"},
            {"asset": "analyzer:asset:blake3-b", "text": "two"},
        ]
        DiffusersAdapter(records_source=records, fetch=fetch).prepare_data(_t2i_job())
        assert fetched == ["analyzer:asset:blake3-a", "analyzer:asset:blake3-b"]


class TestRun:
    def test_the_recorded_run_is_monotonic_and_carries_preview_samples(self) -> None:
        adapter = DiffusersAdapter()
        records = list(adapter.launch(_t2i_job(), adapter.prepare_data(_t2i_job())))
        steps = [r.step for r in records]
        assert steps == sorted(steps) and len(set(steps)) == len(steps)
        # FT-L: preview grids ride the `samples` field on some steps.
        assert any(r.samples for r in records)

    def test_export_mints_a_model_and_weight_assets(self) -> None:
        adapter = DiffusersAdapter()
        prepared = adapter.prepare_data(_t2i_job())
        result = adapter.export(_t2i_job(), prepared, list(adapter.launch(_t2i_job(), prepared)))
        assert result.model.startswith("agora:model:ft-")
        assert all(w.startswith("sha256:") for w in result.weights)
