# HybridTM

[![npm version](https://img.shields.io/npm/v/hybridtm)](https://www.npmjs.com/package/hybridtm)
[![npm license](https://img.shields.io/npm/l/hybridtm)](LICENSE)
[![TypeScript](https://img.shields.io/badge/implementation-native%20TypeScript-3178c6)](https://www.typescriptlang.org/)

HybridTM is a semantic translation memory engine that stores bilingual content in LanceDB and scores matches by combining semantic embeddings (Hugging Face Transformers.js) with the built-in MatchQuality fuzzy metric.

## Highlights

- Imports XLIFF 2.x, TMX 1.4b, and SDLTM files, preserving metadata, notes, and custom properties
- Generates semantic vectors with any Transformers.js-compatible text model — ships three ready-to-use presets (`compact`/`standard`/`large`, default: `HybridTM.LARGE_MODEL`) plus support for bringing your own model id (see [Choosing an embedding model](#choosing-an-embedding-model))
- Provides `semanticTranslationSearch`, `semanticSearch`, and `concordanceSearch` APIs with metadata-aware filtering
- Streams data into LanceDB through a JSONL-based batch importer to keep memory usage predictable
- Prevents duplicate segments by rewriting entries with deterministic IDs (`fileId:unitId:segmentIndex:lang`)
- Backs up any instance to a single format-agnostic XML file and restores it into an existing or brand-new instance, optionally under a different embedding model
- Ships a `hybridtm` command-line tool for creating instances, importing files, backing up/restoring data, and enriching XLIFF files with TM match candidates from the shell
- Runs as a JSON-over-HTTP server too (`hybridtm serve`, or embed `HybridTMServer` directly), for CAT tool and editor integrations that want to keep an instance and its loaded model open across many requests, with ticketed handling for long-running imports and matches, and a `storeXliffUnit` command for persisting a single confirmed unit as the user works

Models download automatically the first time you initialize an instance and are cached in the standard Hugging Face directory.

## Requirements

- Node.js 24 LTS or later
- npm 11+
- Disk space for both the LanceDB directory you choose and the embedding model cache

## Installation

```bash
npm install hybridtm
```

## Quick start

```typescript
import path from 'node:path';
import { HybridTM, HybridTMFactory, Utils } from 'hybridtm';

const INSTANCE_NAME = 'docs-basic';
const DB_PATH = path.resolve('.hybridtm', INSTANCE_NAME + '.lancedb');

function getOrCreateTM(): HybridTM {
  return HybridTMFactory.getInstance(INSTANCE_NAME)
    ?? HybridTMFactory.createInstance(INSTANCE_NAME, DB_PATH, HybridTM.LARGE_MODEL);
}

async function main(): Promise<void> {
  const tm = getOrCreateTM();
  const source = Utils.buildXMLElement('<source>Hello world</source>');
  const target = Utils.buildXMLElement('<target>Hola mundo</target>');

  await tm.storeLangEntry('demo', 'demo.xlf', 'unit1', 'en', 'Hello world', source, undefined, 1, 1, { state: 'final' });
  await tm.storeLangEntry('demo', 'demo.xlf', 'unit1', 'es', 'Hola mundo', target, undefined, 1, 1, { state: 'final' });

  const matches = await tm.semanticTranslationSearch('Hi world', 'en', 'es', 50, 5);
  matches.forEach((match) => {
    console.log('Hybrid', match.hybridScore(), 'Semantic', match.semantic, 'Fuzzy', match.fuzzy);
    console.log('Source:', match.source.toString());
    console.log('Target:', match.target.toString());
  });

  await tm.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Import XLIFF/TMX/SDLTM content at any time:

```typescript
await tm.importXLIFF('./translations/project.xlf', { minState: 'reviewed' });
await tm.importTMX('./translations/legacy.tmx');
await tm.importSDLTM('./translations/legacy.sdltm');
```

`semanticTranslationSearch` automatically pairs every source hit with its matching target segment (same `fileId`, `unitId`, and `segmentIndex`), making the output ready for CAT integrations.

## Choosing an embedding model

HybridTM ships three ready-to-use presets, but it is **not limited to them** — the `modelName` constructor argument (and the CLI's `-model` flag) accepts *any* Hugging Face `feature-extraction`-compatible model id, so you can bring your own (e.g. `-model intfloat/multilingual-e5-large`) if none of the presets fit.

| Preset | Constant | Model | Dimensions |
| --- | --- | --- | --- |
| `compact` | `HybridTM.COMPACT_MODEL` | `Xenova/multilingual-e5-small` | 384 |
| `standard` | `HybridTM.STANDARD_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 384 |
| `large` (default) | `HybridTM.LARGE_MODEL` | `onnx-community/gte-multilingual-base` | 768 |

The names describe model **size/footprint**, not a quality ranking — an internal benchmark across English, Spanish, Japanese, and Finnish content found no preset winning on every language: `standard` led on English/Spanish/Japanese while matching or beating `large` on accuracy, `large` was the clear leader specifically on Finnish (a highly inflected language), and `compact` had the smallest footprint but never won outright on accuracy in that test. This is because HybridTM's translation matching pairs source and target segments by `fileId`/`unitId`/`segmentIndex` structure, not by comparing embeddings across languages — so model choice mostly affects how well a model clusters semantically similar text *within* the language you search in, and that can vary a lot by language family and script.

Practical guidance:

- **Unsure, or mostly Western European languages?** Start with `standard` — smallest footprint tier, and it matched or beat `large` in our tests while being faster.
- **Morphologically rich languages** (e.g. Finnish, other Uralic or heavily case-inflected languages)? `large` is worth its extra latency and storage — it was the clear leader there.
- **Memory/disk is the binding constraint?** `compact` is the smallest option, but treat it as a deliberate tradeoff, not a safe default — it trailed on accuracy in every language we tested.
- Our benchmark was small (dozens of queries per language, a handful of language pairs) — informative, not exhaustive. If model choice matters a lot for your deployment, benchmark with your own representative content and target languages using `semanticSearch`/`semanticTranslationSearch` before committing, especially for languages we didn't test.

## Command-line interface

Installing HybridTM globally also adds a `hybridtm` command:

```bash
npm install -g hybridtm

hybridtm create  -name project -path ./project.lancedb
hybridtm import  -name project -file ./translations/project.xlf
hybridtm match   -name project -file ./new-content.xlf -quality 60 -output ./new-content.matches.xlf
hybridtm backup  -name project -file ./project-backup.xml
hybridtm restore -file ./project-backup.xml -name project
hybridtm list
hybridtm remove -name project
```

`match` never touches `<target>` — it adds spec Translation Candidates
(`<mtc:matches>`/`<mtc:match>`) entries to a **new** output file, leaving the
input untouched. Run `hybridtm <command> -help` for the full flag list, or
see [05 · Command-Line Interface](docs/05-command-line-interface.md).

## Documentation

- [01 · Getting Started](docs/01-getting-started.md)
- [02 · Importing Data](docs/02-importing-data.md)
- [03 · Search and Filtering](docs/03-search-and-filtering.md)
- [04 · Sample Scenarios](docs/04-sample-scenarios.md)
- [05 · Command-Line Interface](docs/05-command-line-interface.md)
- [06 · Backup and Restore](docs/06-backup-and-restore.md)
- [07 · HTTP Server](docs/07-http-server.md)

Each guide is short and task-oriented, so you can jump directly to the workflow you need.

## Runnable samples

The [samples](docs/04-sample-scenarios.md) project contains three scripts (`dev:basic`, `dev:import`, `dev:filters`) plus miniature XLIFF/TMX fixtures.

When working on the repository:

```bash
npm install
npm run build
cd samples
npm install
npm run dev:basic
```

If you copy `samples/` elsewhere, update `samples/package.json` so the `hybridtm` dependency points to the published version you intend to test, then run `npm install`.

## Project layout

- `ts/` – source files for the library
- `ts/cli/` – source for the `hybridtm` command-line tool
- `dist/` – compiled JavaScript and declarations (`npm run build`)
- `docs/` – task-focused tutorials referenced above
- `samples/` – standalone TypeScript project with runnable workflows

## Development

- `npm run build` – compile TypeScript to `dist/`

## License

Eclipse Public License 1.0 — see [LICENSE](LICENSE) for details.
