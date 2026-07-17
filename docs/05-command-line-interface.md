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
hybridtm create -name project -path ./project.lancedb [-model speed|quality|resource]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-name` | yes | Name to register the instance under (used later by every other command) |
| `-path` | yes | Directory where the instance's LanceDB data will live; created if missing |
| `-model` | no | Embedding preset: `speed` (`HybridTM.SPEED_MODEL`), `quality` (default, `HybridTM.QUALITY_MODEL`), or `resource` (`HybridTM.RESOURCE_MODEL`) |

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
| `-keepEmpty` | no | Import segments with an empty target (default: skipped) |
| `-keepUnconfirmed` | no | Import segments with no recognized state (default: skipped) |
| `-noMetadata` | no | Skip extracting notes/metadata/extension attributes |

These map directly onto `ImportOptions`; the defaults match `DEFAULT_IMPORT_OPTIONS`.
The command prints how many entries were imported.

## `match` — enrich an XLIFF file with TM candidates

```bash
hybridtm match -name project -file ./new-content.xlf [-output <path>] [-limit N] [-similarity N] [-all]
```

| Flag | Required | Description |
| --- | --- | --- |
| `-name` | yes | Instance to search against |
| `-file` | yes | XLIFF file to enrich |
| `-output` | no | Output path; defaults to `<file-without-extension>.matches.xlf` next to the input |
| `-limit` | no | Max candidates per segment (default: 5) |
| `-similarity` | no | Minimum hybrid match score, 0-100 (default: 60) — see [03 · Search and Filtering](03-search-and-filtering.md) for how this score is computed |
| `-all` | no | Consider every segment, not just untranslated ones (default: only segments with no `<target>`, an empty `<target>`, or `state` undefined/`initial`) |

**`match` never modifies `<target>` and never overwrites the input file.**
For every segment it processes, it runs `semanticTranslationSearch` against
the named instance and, for each result, adds a `<mtc:match>` (Translation
Candidates module, `urn:oasis:names:tc:xliff:matches:2.0`) to that unit's
`<mtc:matches>` block — declaring the `xmlns:mtc` namespace on the document
if it isn't already present. The result is written to a **separate** output
file for a human or downstream tool to review; nothing is auto-applied.

```xml
<unit id="auth.signin">
  <mtc:matches>
    <mtc:match origin="project" ref="#/f=f1/u=auth.signin/seg1" similarity="92" type="tm">
      <source>Sign in</source>
      <target>Iniciar sesión</target>
    </mtc:match>
  </mtc:matches>
  ...
</unit>
```

`origin` is the instance name passed via `-name`; `ref` points back at the
specific `<segment>`/`<ignorable>` the candidate applies to, using the XLIFF
2.x fragment-identifier syntax (`#/f=<fileId>/u=<unitId>/<segmentId>`).

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

## Next steps

- [01 · Getting Started](01-getting-started.md) covers the equivalent
  programmatic API if you need finer control than the CLI exposes
- [04 · Sample Scenarios](04-sample-scenarios.md) has runnable TypeScript
  versions of the same workflows
