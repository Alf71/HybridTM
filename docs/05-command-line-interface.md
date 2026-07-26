# 05 · Command-Line Interface

HybridTM ships a `hybridtm` command for scripting instance management,
imports, and TM-enrichment without writing any TypeScript. It wraps the same
`HybridTM`/`HybridTMFactory` API documented in the earlier guides.

## Install

```bash
npm install -g hybridtm
```

If installed with `npm install -g`, the `hybridtm` command is added to your
shell `PATH` and available from any directory. A plain `npm install hybridtm`
as a project dependency does not add it to `PATH` — use `npx hybridtm` from
that project instead, or add it as an npm script.

When working inside this repository instead, run commands with
`node dist/cli/hybridtmCli.js` after `npm run build`, or `npm link` to get
the same global `hybridtm` command pointed at your local build.

Every command supports `-help`:

```bash
hybridtm -help
hybridtm import -help
```

## `create` — register a named instance

```bash
hybridtm create -name project -path ./project.lancedb [-model compact|standard|large|<model id>]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-name` | yes | Name to register the instance under (used later by every other command) |
| `-path` | yes | Directory where the instance's LanceDB data will live; created if missing |
| `-model` | no | Embedding preset — `compact` (`HybridTM.COMPACT_MODEL`), `standard` (`HybridTM.STANDARD_MODEL`), or `large` (default, `HybridTM.LARGE_MODEL`) — or any other Hugging Face `feature-extraction`-compatible model id to load directly. See the README's [Choosing an embedding model](../README.md#choosing-an-embedding-model) for which preset fits your languages. |

The instance is registered in the same `instances.json` registry `HybridTMFactory`
uses (see [01 · Getting Started](01-getting-started.md)), so instances created
from the CLI are immediately visible to library code, and vice versa.

## `import` — populate an instance from a file

```bash
hybridtm import -name project -file ./translations/project.xlf [options]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-name` | yes | Instance to import into |
| `-file` | yes | File to import |
| `-type` | no | `xliff`, `tmx`, or `sdltm`; inferred from the file extension when omitted |
| `-minState` | no | Minimum segment state to import (default: `translated`) — see [02 · Importing Data](02-importing-data.md) |
| `-noMetadata` | no | Skip extracting notes/metadata/extension attributes |

Empty XLIFF targets are skipped automatically, unless the segment's `@state` is `final`. These map directly onto `ImportOptions`; the defaults match `DEFAULT_IMPORT_OPTIONS`.
The command prints how many entries were imported.

## `match` — enrich an XLIFF file with TM candidates

```bash
hybridtm match -name project -file ./new-content.xlf -quality N [-output <path>] [-limit N]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-name` | yes | Instance to search against |
| `-file` | yes | XLIFF file to enrich |
| `-quality` | yes | Minimum **hybrid** match score, 0-100, written to the output's `@matchQuality` attribute, see below |
| `-output` | no | Output path; defaults to `<file-without-extension>.matches.xlf` next to the input |
| `-limit` | no | Max candidates per segment; defaults to `semanticTranslationSearch`'s own default (10) when omitted |

Every segment is processed except ones with `state="final"`.

**`match` never modifies `<target>` and never overwrites the input file.**
For every segment it processes, it runs `semanticTranslationSearch` against
the named instance and, for each result, adds a `<mtc:match>` (Translation
Candidates module, `urn:oasis:names:tc:xliff:matches:2.0`) to that unit's
`<mtc:matches>` block — declaring the `xmlns:mtc` namespace on the document
if it isn't already present. The result is written to a **separate** output
file for a human or downstream tool to review; nothing is auto-applied.

[03 · Search and Filtering](03-search-and-filtering.md) describes `Match`'s
three scores (`semantic`, `fuzzy`, `hybridScore()`). The XLIFF spec's
`<mtc:match>` only has two score attributes, so they map as follows:

| HybridTM score | XLIFF attribute | Meaning per spec |
| --- | --- | --- |
| `hybridScore()` (blend of `semantic` + `fuzzy`) | `@matchQuality` | overall rating of the match, free to factor in more than text similarity |
| `fuzzy` | `@similarity` | source-to-source text similarity only |

The `semantic` score alone isn't written out as its own attribute — it only
factors into `@matchQuality` via the blend. It can be recovered approximately:

```text
semantic ≈ 2 × matchQuality − similarity
```

This is only approximate, not exact: `matchQuality` is `Math.round((semantic + fuzzy) / 2)`
(`ts/hybridtm.ts`), and that rounding is lossy. The formula above is exact when
`semantic + fuzzy` is even, and exactly 1 too high when their sum is odd — from
`matchQuality`/`similarity` alone there's no way to tell which case applies.

```xml
<unit id="auth.signin">
  <mtc:matches>
    <mtc:match matchQuality="92" origin="project" ref="#seg1" similarity="85" type="tm">
      <source>Sign in</source>
      <target>Iniciar sesión</target>
    </mtc:match>
  </mtc:matches>
  ...
</unit>
```

`origin` is the instance name passed via `-name`; `ref` points back at the
specific `<segment>`/`<ignorable>` the candidate applies to. Since the match
always applies to a segment in its own enclosing `<unit>`, `ref` uses the XLIFF
2.x relative fragment-identifier syntax (`#<segmentId>`) rather than the full
`#/f=<fileId>/u=<unitId>/<segmentId>` path.
Inline codes (`<ph>`, etc.) in the matched source/target are converted to
XLIFF's own `<ph>`/`<originalData>` representation rather than left as raw
original-format markup, with `<ph>` ids correlated between `<source>` and
`<target>` for the same underlying code.

## `backup` — export an instance to a backup XML file

```bash
hybridtm backup -name project -file ./project-backup.xml
```

| Flag | Required | Description |
| --- | --- | --- |
| `-name` | yes | Instance to back up |
| `-file` | yes | Output XML file path |

The backup file is format-agnostic and never carries vector/embedding data;
see [06 · Backup and Restore](06-backup-and-restore.md) for the file format
and library-level details.

## `restore` — reimport a backup XML file

```bash
hybridtm restore -file ./project-backup.xml -name project
hybridtm restore -file ./project-backup.xml -create -path ./project-v2.lancedb [-name project-v2] [-model compact|standard|large|<model id>]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-file` | yes | Backup XML file to restore |
| `-name` | append mode only* | Existing instance to restore into (append/upsert); with `-create`, the name for the new instance |
| `-create` | no | Create a fresh instance before restoring, instead of appending to an existing one |
| `-path` | with `-create` | Directory for the new instance's LanceDB data |
| `-model` | no | Embedding preset for the new instance (`compact`, `standard`, `large`, or a literal Hugging Face model id) |

\* Without `-create`, `-name` is required and selects the existing instance to
append into. With `-create`, `-name` and `-model` are both optional — if
omitted, the name and/or model recorded in the backup file's root element are
used, so `hybridtm restore -file backup.xml -create -path ./new.lancedb`
alone recreates an instance matching the original name and model.

## `list` and `remove` — manage the registry

```bash
hybridtm list
hybridtm remove -name project
```

`list` prints every registered instance (name, path, model, creation date) —
the same data `HybridTMFactory.listInstances()` returns. `remove` permanently
deletes the instance's LanceDB directory, with no undo, so by default it
prints what's about to be deleted and asks you to type `yes` to confirm.
Pass `-force` to skip the prompt for scripts/automation. If the name doesn't
match a registered instance, the error lists the names that are registered —
useful if a name contains spaces and needs quoting (`-name "My Project"`).

## `serve` and `stop`: run the HTTP server

```bash
hybridtm serve [-port <number>] [-network]
hybridtm stop [-port <number>]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-port` | no | Port to listen on (default: `8050`) |
| `-network` | no | Accept connections from other machines on the network (default: only this machine) |

`serve` starts a local JSON-over-HTTP server for long-lived integrations
that want to keep an instance open across many requests instead of paying
the load cost per CLI invocation. `stop` shuts it down; pass the same
`-port` you started it with if it wasn't the default. See
[07 · HTTP Server](07-http-server.md) for the full request/response
protocol.

## Next steps

- [01 · Getting Started](01-getting-started.md) covers the equivalent
  programmatic API if you need finer control than the CLI exposes
- [04 · Sample Scenarios](04-sample-scenarios.md) has runnable TypeScript
  versions of the same workflows
- [06 · Backup and Restore](06-backup-and-restore.md) documents the backup
  file format and the `backup`/`restore` library API
- [07 · HTTP Server](07-http-server.md) documents the `serve`/`stop`
  JSON HTTP server, for editors and CAT tools that want a long-lived
  instance instead of one-shot CLI calls
