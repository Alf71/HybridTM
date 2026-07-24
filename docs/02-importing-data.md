# 02 · Importing Data

HybridTM ingests industry-standard bilingual files in two phases: the reader (`XLIFFReader` or `TMXReader`) parses the source document into a temporary JSONL file, and the `BatchImporter` streams that file into LanceDB in batches. This makes large imports predictable while keeping memory usage low.

## Importing XLIFF 2.x

```typescript
import path from 'node:path';
import { HybridTM, HybridTMFactory } from 'hybridtm';

const tm = HybridTMFactory.getInstance('docs-basic')
  ?? HybridTMFactory.createInstance('docs-basic', path.resolve('.data/docs-basic.lancedb'), HybridTM.LARGE_MODEL);

await tm.importXLIFF(path.resolve('translations/demo.xlf'));
```

The importer validates that the document is XLIFF 2.x (version header plus `srcLang`/`trgLang`), walks every `<unit>`, extracts `<segment>` content, and normalizes each `state` value to the standard XLIFF 2 levels (`initial`, `translated`, `reviewed`, `final`).

## Importing TMX 1.4b

```typescript
await tm.importTMX(path.resolve('translations/legacy.tmx'));
```

TMX import preserves every `<tu>`/`<tuv>` pair, computes canonical IDs (`fileId:unitId:segmentIndex:lang`), and converts notes, creation/change metadata, and custom fields into the HybridTM metadata map.

## Importing SDLTM from Trados Studio

```typescript
await tm.importSDLTM(path.resolve('translations/legacy.sdltm'));
```

SDLTM files from Trados Studio are automatically converted to TMX format using the `sdltm` library, then imported through the standard TMX pipeline. The temporary TMX file is cleaned up automatically after import.

## Import options

Use `ImportOptions` to tune the ingestion pass. All fields are optional; unspecified values fall back to the defaults listed below.

| Option | Default | Description |
| --- | --- | --- |
| `minState` | `translated` | Minimum normalized state (`initial`, `translated`, `reviewed`, `final`). Only XLIFF imports honor this filter; TMX entries are always imported. |
| `extractMetadata` | `true` | Parse metadata attributes, notes, and custom properties into the LanceDB columns. |

Empty XLIFF targets are skipped automatically, unless the segment's `@state` is `final` — an empty target with `state="final"` is treated as an intentional translation choice and is imported. TMX entries with an empty `<seg>` are always skipped.

Example:

```typescript
await tm.importXLIFF(filePath, {
  minState: 'reviewed',
  extractMetadata: true
});
```

## Performance checklist

- Large corpora import faster when you keep the default batch size (1000 entries) and run imports on SSD-backed storage
- You can monitor progress through the console logs emitted by `BatchImporter`
- Temporary JSONL files are deleted automatically after the import finishes; if an import fails, delete leftover files before retrying
- The selected embedding model dictates import time; see the README's [Choosing an embedding model](../README.md#choosing-an-embedding-model) for how the `compact`/`standard`/`large` presets are expected to compare on speed and match accuracy

Continue with [03 · Search and Filtering](03-search-and-filtering.md) once your database is populated.
