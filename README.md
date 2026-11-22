# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mietrea519-cyber/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mietrea519-cyber/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all of them to one written contract
(`SPEC.md` in the make.fun kit for this bounty): a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed or nothing is.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When absent or `-`,
  the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` applied (prints `A`/`D`/`M`/`R` lines and `ok: <n> files`),
`1` some edits failed (one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`; no file is written), `2` usage, unreadable patch,
undetected format, or parse error (`error: parse <N>`).

## Matching

An edit's old lines are found at the first of three tiers at which they occur:
tier 0 exact, tier 1 ignoring trailing spaces/tabs, tier 2 ignoring leading and
trailing spaces/tabs (with re-indentation of the new lines). A unified hunk takes
the occurrence nearest its (possibly wrong) line number; a SEARCH/REPLACE block
fails `ambiguous` unless the old lines occur exactly once; a V4A chunk searches
from a cursor past its anchor.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as shipped.
- `LICENSE` — MIT.

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122).
Practice score: **1000** (100/100 public practice checks).
