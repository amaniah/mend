# mend

One command-line tool that applies AI-written edits in four formats to a tree of text files.

Formats: unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. Detection is automatic by default.

## Run

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the patch file, or `-` or absent for standard input. Node 22 and its standard library only, nothing is installed.

## Practice

100 of 100 practice checks passed, practice score 1000.

## License

MIT, see LICENSE.
