# TODO

- Implement progress reporting for long-running imports without relying on console logging.
  - For direct library use: add an optional progress callback (e.g. `onProgress?: (processed: number, total: number) => void`) to `BatchImporter`, invoked at the same points as the current `console.log` calls in `import()` (ts/batchImporter.ts).
  - For the HTTP server: extend `JobRecord` (ts/server/hybridtmServer.ts) to include progress fields and expose them in the existing ticket `status` response, since long-running tasks are already ticket-based and clients already poll for status.
- Implement proper retrieval using filters (`where` clauses) on metadata-derived fields (e.g. `unitId`, future provenance fields), not just the current `id`-prefix and vector-similarity search.
- Design and implement provenance tracking based on the XLIFF 2.3 Provenance module (`<pvn:provenance>`/`<pvn:change>`, namespace `urn:oasis:names:tc:xliff:pvn:2.3`; spec still in draft as of 2026-07-20).
  - Internal storage: extend `SegmentMetadata` (ts/langEntry.ts) with provenance fields (`agent`/`tool`/`person`/`organization`/`timestamp`/`intent`, mirroring `<pvn:change>` attributes), riding the existing JSON `metadataSegment` column — additive, no schema migration needed.
  - Output serialization: when HybridTM enriches an XLIFF document (writing MT output, TM matches, or edits back into a `<unit>`), emit the driving metadata as actual `<pvn:provenance>`/`<pvn:change>` elements in the produced XLIFF (ts/xliffHandler.ts write path), so the audit trail travels with the file itself rather than staying locked inside HybridTM's database.
