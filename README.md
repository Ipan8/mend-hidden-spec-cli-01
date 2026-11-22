# mend

One patch tool for every AI edit format: it applies a unified diff, SEARCH/REPLACE
blocks, a V4A patch, or JSON editor calls to a tree of text files — every file is
changed or nothing is.

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ipan8/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ipan8/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Built for the [make.fun "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / absent for standard input. `--format` is
`unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which
detects the format). `--check` is a dry run: same output and exit code, no
file written. `--strict` matches lines exactly.

## What it does

- **Unified diffs** (`diff --git`, `---`/`+++`, `@@` hunks): create, delete,
  rename and change files; hunks are matched at the nearest occurrence to the
  (often wrong) hunk line number.
- **SEARCH/REPLACE blocks**: one edit per block; the old lines must occur
  exactly once.
- **V4A patches** (`*** Begin Patch` … `*** End Patch`): Add / Delete /
  Update File sections, `*** Move to:`, `@@` anchors and `*** End of File`
  chunks, applied with a cursor.
- **JSON edits**: one array of edit objects, or JSON Lines — `create`,
  `str_replace`, `insert`.

Line matching runs at three tiers: exact, then ignoring trailing spaces/tabs,
then ignoring leading and trailing spaces/tabs — with tier-2 re-indentation of
the new lines. `--strict` uses the exact tier only. Files keep their own line
break (LF or CRLF) and final newline, except where the patch says otherwise
(`\ No newline at end of file`).

Exit codes: `0` with one `A`/`D`/`M`/`R` line per changed path plus
`ok: <n> files`; `1` with one `error: <code> <path>` line per failed edit plus
`failed: <k> of <n> edits` (and nothing written); `2` with a single
`error: usage` / `no-patch` / `format` / `parse <N>` line.

## Files

- `main.ts` — the entrypoint (Node 22, standard library only)
- `runner.ts` — the kit's trial runner, unchanged
- `check.ts` — the kit's practice-set checker: `node check.ts <practice.json>`

Practice set: **100/100 passed, practice score 1000**. A further 102-case
edge suite of my own (exit-2 ordering, exact parse line numbers, CRLF,
no-newline-at-EOF, pure insertions, move reporting, `--check`, `--strict`,
unsafe paths, atomicity, determinism) also passes 102/102.

License: MIT (see `LICENSE`).
