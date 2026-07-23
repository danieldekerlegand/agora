"""Admission validation — schema (KFT §3) + modality × method (§3.1, FT-F) + exit codes."""

from __future__ import annotations

import json
from pathlib import Path

from agora_trainer.validate import Status, main, validate_job
from conftest import valid_text_job


class TestSchemaGate:
    def test_a_well_formed_job_is_admitted(self) -> None:
        report = validate_job(valid_text_job())
        assert report.ok
        assert report.status is Status.OK
        assert report.problems == ()

    def test_the_koine_golden_example_validates(self) -> None:
        """The vendored schema accepts koine's own positive example (proves ref resolution)."""
        example = (
            Path(__file__).resolve().parents[1]
            / "src"
            / "agora_trainer"
            / "schemas"
            / "finetune-job.schema.json"
        )
        assert example.exists()  # sanity: the vendored schema is present
        report = validate_job(valid_text_job(modality="image-text-to-text", method="qlora"))
        assert report.ok  # VLM qlora is compatible (FT-F), even if US-2 has no engine for it

    def test_a_missing_required_field_is_invalid(self) -> None:
        job = valid_text_job()
        del job["base_model"]
        report = validate_job(job)
        assert report.status is Status.INVALID
        assert any(p.code == "schema" for p in report.problems)

    def test_an_unknown_property_is_invalid(self) -> None:
        report = validate_job(valid_text_job(surprise=True))
        assert report.status is Status.INVALID
        assert any(p.code == "schema" for p in report.problems)

    def test_an_unknown_modality_token_is_invalid(self) -> None:
        report = validate_job(valid_text_job(modality="text-to-hologram"))
        assert report.status is Status.INVALID
        assert any(p.code == "schema" for p in report.problems)

    def test_a_non_object_payload_is_a_usage_error(self) -> None:
        assert validate_job(["not", "a", "job"]).status is Status.USAGE
        assert validate_job("nope").status is Status.USAGE


class TestCompatibilityGate:
    """FT-F: modality × method is validated at admission, before any compute is committed."""

    def test_incompatible_modality_method_is_rejected(self) -> None:
        job = valid_text_job(
            modality="text-to-image",
            method="dpo",
            dataset={"media": ["analyzer:asset:blake3-a1b2c3d4e5f6"]},
        )
        report = validate_job(job)
        assert report.status is Status.INVALID
        assert any(p.code == "modality-method" for p in report.problems)

    def test_a_compatible_pair_passes_the_semantic_gate(self) -> None:
        # text-to-image LoRA is a served pair; the media plane makes it schema-valid too.
        job = valid_text_job(
            modality="text-to-image",
            method="lora",
            dataset={"media": ["analyzer:asset:blake3-a1b2c3d4e5f6"]},
        )
        report = validate_job(job)
        assert report.ok


class TestReportShape:
    def test_the_report_carries_the_exit_code_and_problem_details(self) -> None:
        report = validate_job(
            valid_text_job(
                method="dpo", modality="text-to-image", dataset={"media": ["analyzer:asset:blake3-aa"]}
            )
        )
        body = report.describe()
        assert body["ok"] is False
        assert body["status"] == "invalid"
        assert body["exit_code"] == 1
        assert body["problems"] and all(
            {"code", "path", "message"} <= p.keys() for p in body["problems"]
        )


class TestCli:
    """0 valid / 1 invalid / 2 usage — the exit-code semantics agora's validators share."""

    def _write(self, tmp_path: Path, payload: object) -> str:
        path = tmp_path / "job.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def test_valid_job_exits_zero(self, tmp_path: Path) -> None:
        assert main([self._write(tmp_path, valid_text_job())]) == 0

    def test_invalid_job_exits_one(self, tmp_path: Path) -> None:
        job = valid_text_job()
        del job["compute"]
        assert main([self._write(tmp_path, job)]) == 1

    def test_incompatible_job_exits_one(self, tmp_path: Path) -> None:
        job = valid_text_job(
            modality="text-to-image", method="dpo", dataset={"media": ["analyzer:asset:blake3-aa"]}
        )
        assert main([self._write(tmp_path, job)]) == 1

    def test_no_argument_is_a_usage_error(self) -> None:
        assert main([]) == 2

    def test_a_missing_file_is_a_usage_error(self, tmp_path: Path) -> None:
        assert main([str(tmp_path / "absent.json")]) == 2

    def test_unparseable_json_is_a_usage_error(self, tmp_path: Path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("{ not json", encoding="utf-8")
        assert main([str(path)]) == 2
