# CLAUDE.md — agora (Chief harness)

`agora` is the **runtime commons** for the ecosystem — sibling to `../koine` (koine
specifies, agora implements). See `README.md` and
`../koine/decisions/ADR-0001-control-plane-topology.md`.

## Your task (per iteration)

1. Read the active tasklist in `tasks/chief/` (start with `agora-bootstrap.json`).
2. Read `progress.txt` (check the `## Codebase Patterns` section first).
3. Check out the tasklist's `branchName` from `main` (create it if missing). Keep `main` clean.
4. Pick the **highest-priority** user story where `passes: false`, honoring `dependsOn`.
5. Implement that **one** story to satisfy its acceptance criteria.
6. Run the quality gates for the area you touched (see below), zero errors.
7. Commit all changes: `feat: [Story ID] - [Story Title]`, ending the body with
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
8. Set `passes: true` for the completed story in the tasklist.
9. Append what you did + learnings to `progress.txt`.

Work ONE story per iteration; never commit broken code (a red gate compounds across
iterations).

## This is a greenfield repo

Until `agora-bootstrap` **US-AG1** lands, there is no established stack or gate commands —
US-AG1 *establishes* them (recommended: polyglot — provider-router ported in Python from
`../analyzer`; console + registry/resolver + client libs in TS/React; shared over the wire so
language is internal, per ADR-0001) and MUST update this file with the concrete
per-area build/test/lint commands. After US-AG1, "gates pass" = run those commands, exit 0.

## The contracts live in ../koine

Every story implements a koine spec (KINP/KGP/KCB/KMI/KCS) — read the referenced spec before
implementing. Do not re-specify contracts here; propose contract changes as edits to koine.

## Layout (established by US-AG1)

`provider-router/`, `registry/`, `resolver/`, `console/`, `schemas/` (+ `clients/`) — each a
buildable unit with its own gate.
