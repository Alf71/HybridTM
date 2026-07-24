# 07 · HTTP Server

HybridTM can run as a local JSON-over-HTTP server, for long-lived integrations (editor plugins, CAT tools) that want to keep an instance, and its loaded embedding model, open across many requests instead of paying the load cost on every invocation. It exposes the same `HybridTM`/`HybridTMFactory` operations documented in the earlier guides.

## Starting and stopping

```bash
hybridtm serve [-port <number>] [-network]
hybridtm stop [-port <number>]
```

`serve` spawns a detached background process listening on port `8050` by default; pass `-port` to use a different one. By default it binds `127.0.0.1` only, so it isn't reachable from other machines; pass `-network` to change that (there's no per-command authentication, so only do this on a trusted network). `stop` sends it a shutdown request; pass the same `-port` you started it with if it wasn't the default.

## Embedding the server in your own application

`HybridTMServer` is also exported from the package, for running the same server directly inside a Node.js process instead of launching it via the CLI:

```typescript
import { HybridTMServer } from 'hybridtm';

const server = new HybridTMServer(8050);              // binds 127.0.0.1 only
// const server = new HybridTMServer(8050, '0.0.0.0'); // reachable from other machines

await server.start();

// ... your application runs; anything that can reach this process
// (including code running in the same process) can now POST JSON
// commands to the address/port above

await server.stop();
```

`start()`/`stop()` return Promises that resolve once the HTTP listener is actually up/down. The constructor's first argument is the port; the second is the bind address, defaulting to `127.0.0.1`. A few properties worth knowing:

- It runs in-process: it shares your application's event loop and lifetime, and stops existing once that process exits.
- You choose the port (and host) via the constructor, so you can run several independent servers side by side, for example one per test, or one per plugin host.
- It's a plain object, not a singleton. The registry it reads from, `HybridTMFactory`'s `instances.json`, is shared machine-wide by every `HybridTMServer`/`HybridTM`/`HybridTMFactory` instance. Creating an instance under a given `name` from one server/process makes it visible to `open` on any other.

The rest of this guide (the request/response envelope and every command below) describes the server's behavior regardless of how it was started.

## Request/response envelope

The server exposes a single endpoint: POST a JSON object with a `command` field (plus whatever fields that command needs) to `http://127.0.0.1:8050`, and read a JSON object back.

```bash
curl -s -X POST http://127.0.0.1:8050 \
  -H 'Content-Type: application/json' \
  -d '{"command":"list"}'
```

Every response has one of two shapes:

```jsonc
{ "status": "success", "payload": /* command-specific */ }
{ "status": "failed", "reason": "human-readable message" }
```

## Instance lifecycle: `open` / `close`

The server keeps a `HybridTM` instance (and its loaded embedder) in memory across requests, until it's explicitly closed. Every data command below (`import`, `match`, `storeXliffUnit`, `concordanceSearch`, `semanticSearch`, `semanticTranslationSearch`, `close`) requires the instance to already be open.

### `open`

```json
{ "command": "open", "name": "project" }
```

Loads the instance via `HybridTMFactory.getInstance` and keeps it open. Calling `open` again for an already-open instance is a no-op success. Fails if no instance is registered under that name (run `create` first).

### `close`

```json
{ "command": "close", "name": "project" }
```

Closes the instance (flushing LanceDB and disposing the embedder) and drops it from the server's open-instance set. Fails if the instance isn't currently open.

## Registry commands

`create`, `remove`, and `list` manage the registered instances and don't require the instance to be open first.

### `create`

```json
{ "command": "create", "name": "project", "path": "./project.lancedb", "model": "large" }
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Name to register the instance under |
| `path` | yes | Directory where the instance's LanceDB data will live; created if missing |
| `model` | no | `compact`, `standard`, `large` (default), or a literal Hugging Face model id |

Registers the instance and closes it immediately. `create` does **not** add the instance to the server's open-instance set; send `open` afterward before using it.

### `remove`

```json
{ "command": "remove", "name": "project" }
```

If the instance is currently open, it is closed first (so its LanceDB directory isn't deleted out from under an open handle), then the registry entry and data directory are permanently deleted.

### `list`

```json
{ "command": "list" }
```

Payload is `HybridTMInstanceMetadata[]`, the same array `HybridTMFactory.listInstances()` returns (`name`, `filePath`, `modelName`, `createdAt`).

## Long-running commands: `import` and `match`

Importing a large XLIFF/TMX/SDLTM file (generating an embedding per segment) or matching a file against an instance (running a semantic search per segment) can take a while, so neither command blocks the request until the work finishes. Both start the operation in the background and return a **ticket** immediately; poll `status` to find out when it's done.

### `import`

```json
{
  "command": "import",
  "name": "project",
  "file": "./translations/project.xlf",
  "type": "xliff",
  "minState": "translated",
  "keepEmpty": false,
  "noMetadata": false
}
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Instance to import into (must already be `open`) |
| `file` | yes | File to import |
| `type` | no | `xliff`, `tmx`, or `sdltm`; inferred from the file extension when omitted |
| `minState` | no | Minimum segment state to import (see [02 · Importing Data](02-importing-data.md)) |
| `keepEmpty` | no | `true` to import segments with an empty target (default: `false`) |
| `noMetadata` | no | `true` to skip extracting notes/metadata/extension attributes (default: `false`) |

Returns immediately:

```json
{ "status": "success", "payload": { "ticket": "b6e7…" } }
```

Once the job finishes, `status` returns `{ "imported": <count> }` as the result (see below).

### `match`

```json
{
  "command": "match",
  "name": "project",
  "file": "./new-content.xlf",
  "output": "./new-content.matches.xlf",
  "similarity": 60,
  "limit": 5
}
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Instance to search against (must already be `open`) |
| `file` | yes | XLIFF file to enrich |
| `similarity` | yes | Minimum hybrid match score, 0-100 |
| `output` | no | Output path; defaults to `<file-without-extension>.matches.xlf` next to the input |
| `limit` | no | Max candidates per segment; defaults to `semanticTranslationSearch`'s own default (10) when omitted |

Every segment is processed except ones with `state="final"`.

For every segment, it runs `semanticTranslationSearch` and adds a `<mtc:match>` (Translation Candidates module, `urn:oasis:names:tc:xliff:matches:2.0`) entry to that unit's `<mtc:matches>` block:

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

`matchQuality` is the overall (hybrid) score; `similarity` here is source-to-source text similarity only. `origin` is the instance name; `ref` points at the specific segment the candidate applies to. Inline codes (`<ph>`, etc.) in the matched source/target are converted to XLIFF's own `<ph>`/`<originalData>` representation. Once the job finishes, `status`'s result is `{ "segmentsProcessed": n, "segmentsWithMatches": n, "totalMatches": n, "outputPath": "…" }`.

### `status`

```json
{ "command": "status", "ticket": "b6e7…" }
```

While the job is still running:

```json
{ "status": "success", "payload": { "ticket": "b6e7…", "jobStatus": "running" } }
```

Once it finishes:

```json
{ "status": "success", "payload": { "ticket": "b6e7…", "jobStatus": "completed", "result": { "imported": 214 } } }
{ "status": "success", "payload": { "ticket": "b6e7…", "jobStatus": "failed", "reason": "…" } }
```

A finished job is removed from the server's memory the first time `status` reads it; poll once you see `completed`/`failed`, not repeatedly. Polling again with the same ticket afterward returns `{ "status": "failed", "reason": "Unknown ticket" }`, same as an unrecognized or expired ticket.

## Search commands

These require the instance to be `open` and return their result inline (not ticketed) since a single query is expected to be fast. See [03 · Search and Filtering](03-search-and-filtering.md) for `MetadataFilter`/`TranslationSearchFilters` fields and how ranking works.

### `concordanceSearch`

```json
{
  "command": "concordanceSearch",
  "name": "project",
  "textFragment": "error",
  "language": "en",
  "limit": 100,
  "filters": { "minState": "translated" }
}
```

`limit`/`filters` are optional; omitting `limit` uses `concordanceSearch`'s own default (100). The payload is the JSON form of `Map<string, XMLElement>[]`: one object per matching unit, mapping language to the serialized XML element:

```json
[
  { "en": "<source>Connection error</source>", "es": "<target>Error de conexión</target>" }
]
```

### `semanticSearch`

```json
{
  "command": "semanticSearch",
  "name": "project",
  "queryText": "settings",
  "language": "en",
  "limit": 10,
  "filters": { "contextIncludes": ["ui.settings"] }
}
```

`limit`/`filters` are optional (default limit: 10). Payload is `SearchResult[]`, already plain JSON.

### `semanticTranslationSearch`

```json
{
  "command": "semanticTranslationSearch",
  "name": "project",
  "searchStr": "Reset password",
  "srcLang": "en",
  "tgtLang": "es",
  "similarity": 55,
  "limit": 10,
  "filters": { "target": { "states": ["reviewed", "final"] } }
}
```

`similarity` is required. `limit`/`filters` are optional. Payload is `Match[]`, serialized via `Match.toJSON()`: `source`/`target` come through as XML strings alongside `origin`, `type`, `similarity`, `semantic`, `fuzzy`, and `properties`.

## `storeXliffUnit`

For editors/CAT tools that want to persist a single confirmed `<unit>` as the user works, without writing and importing a whole file.

```json
{
  "command": "storeXliffUnit",
  "name": "project",
  "unit": "<unit id=\"u1\"><segment><source>Sign in</source><target>Iniciar sesión</target></segment></unit>",
  "fileId": "demo.xlf",
  "original": "demo.docx",
  "srcLang": "en",
  "tgtLang": "es"
}
```

This command returns `{ "status": "success", "payload": {} }` directly on success.

## `stop`

```json
{ "command": "stop" }
```

Shuts down the HTTP server.

## Command reference

| Command | Requires `open` | Ticketed | Payload on success |
| --- | --- | --- | --- |
| `open` | n/a | no | `{}` |
| `close` | yes | no | `{}` |
| `create` | no | no | `{}` |
| `remove` | no | no | `{}` |
| `list` | no | no | `HybridTMInstanceMetadata[]` |
| `import` | yes | **yes** | `{ ticket }`, later `{ imported }` |
| `match` | yes | **yes** | `{ ticket }`, later match stats |
| `status` | no | no | job status/result |
| `concordanceSearch` | yes | no | `Map<string, XMLElement>[]` (as JSON) |
| `semanticSearch` | yes | no | `SearchResult[]` |
| `semanticTranslationSearch` | yes | no | `Match[]` |
| `storeXliffUnit` | yes | no | `{}` |
| `stop` | no | no | `{}` |

## Next steps

- [01 · Getting Started](01-getting-started.md) covers the equivalent programmatic API if you're calling `HybridTM`/`HybridTMFactory` directly instead of through the server
- [05 · Command-Line Interface](05-command-line-interface.md) documents the `hybridtm serve`/`hybridtm stop` convenience commands for this server
- [03 · Search and Filtering](03-search-and-filtering.md) documents the `MetadataFilter`/`TranslationSearchFilters` shapes accepted by the search commands
