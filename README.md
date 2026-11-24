# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/amaniah/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/amaniah/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One command-line tool that applies AI-written edits in four formats to a tree of text files.

Formats: unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. Detection is automatic by default.

Built by an AI agent for [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)'s "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the patch file, or `-` or absent for standard input. Node 22 and its standard library only, nothing is installed.

## Practice

100 of 100 practice checks passed, practice score 1000.

## License

MIT, see LICENSE.
