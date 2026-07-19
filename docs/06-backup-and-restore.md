# 06 · Backup and Restore

HybridTM can export any instance to a single, format-agnostic XML file and reimport it later — back into the same instance, into a different existing instance, or into a brand-new instance with a different embedding model. Backups never carry vector data; restore always regenerates embeddings from the target instance's own model, so you can use a backup/restore round trip to switch embedding models entirely.

## Back up an instance

```typescript
import path from 'node:path';
import { HybridTMFactory } from 'hybridtm';

const tm = HybridTMFactory.getInstance('docs-basic');
const count = await tm.backup(path.resolve('backups/docs-basic.xml'));
console.log('Backed up', count, 'entries');
```

`backup()` iterates the LanceDB table using its native chunked query iteration and writes one `<entry>` per row as chunks arrive, so memory usage stays bounded even on large translation memories. The `vector` column is never included.

## What's in a backup file

```xml
<?xml version="1.0" encoding="UTF-8"?>
<backup name="docs-basic" model="onnx-community/gte-multilingual-base" date="2026-07-19T12:23:46.821Z">
  <entry id="f1:auth.signin:0:en" language="en" fileId="f1" original="demo.md"
         unitId="auth.signin" segmentIndex="0" segmentCount="1">
    <pureText>Sign in</pureText>
    <element><source>Sign in</source></element>
    <metadata>
      <state>final</state>
      <context>ui.auth.signin</context>
      <notes><note>Displayed on the login button.</note></notes>
      <properties><property name="context:path">ui.auth.signin</property></properties>
      <segment provider="xliff" fileId="f1" unitId="auth.signin" segmentId="seg1" segmentIndex="0" segmentCount="1"/>
    </metadata>
  </entry>
  <!-- one <entry> per LangEntry row -->
</backup>
```

- The root `<backup>` element records the source instance's `name`, embedding `model`, and export `date`, so a fresh instance created from the backup can match the original.
- `<pureText>` and `<element>` are stored exactly as they are in the database — `element` is opaque, format-agnostic markup (a TMX `<tuv>`, an XLIFF `<source>`/`<target>`, or anything else), never interpreted or reparsed structurally by backup/restore.
- `<metadata>` is only present when the entry has metadata, and its children mirror `EntryMetadata`/`SegmentMetadata` field-for-field, so restore rebuilds the same metadata object with no lossy mapping.
- `id`, `language`, `fileId`, `original`, `unitId`, `segmentIndex`, and `segmentCount` are stored as plain attributes because restore has no other way to recover them — it never inspects the opaque `element` content to figure out where a segment came from.

## Restore into an existing instance (append)

```typescript
const tm = HybridTMFactory.getInstance('docs-basic');
const restored = await tm.restore(path.resolve('backups/docs-basic.xml'));
console.log('Restored', restored, 'entries');
```

`restore()` reuses the same SAX-parse-to-temp-JSONL-then-`BatchImporter` pipeline as `importTMX`/`importXLIFF`. Entries whose id already exists in the target table are overwritten rather than duplicated — the same upsert behavior you get from importing the same file twice.

## Restore into a fresh instance (optionally with a different model)

```typescript
import { HybridTM, HybridTMFactory } from 'hybridtm';

const tm = HybridTMFactory.createInstance(
  'docs-basic-v2',
  path.resolve('.hybridtm/docs-basic-v2.lancedb'),
  HybridTM.STANDARD_MODEL // any model, independent of what the backup was created with
);
const restored = await tm.restore(path.resolve('backups/docs-basic.xml'));
```

Since embeddings are always regenerated from `pureText` using the target instance's own model, this is the supported way to re-embed an entire translation memory under a different model without re-importing the original TMX/XLIFF/SDLTM files.

## Command-line usage

```bash
hybridtm backup -name docs-basic -file backups/docs-basic.xml

# append into an existing instance
hybridtm restore -file backups/docs-basic.xml -name docs-basic

# create a fresh instance first, explicit name and model
hybridtm restore -file backups/docs-basic.xml -create -path ./docs-basic-v2.lancedb \
  -name docs-basic-v2 -model standard

# create a fresh instance first, using the name/model recorded in the backup file
hybridtm restore -file backups/docs-basic.xml -create -path ./docs-basic-restored.lancedb
```

See [05 · Command-Line Interface](05-command-line-interface.md) for the full `backup`/`restore` flag reference.

## Next steps

- [01 · Getting Started](01-getting-started.md) covers instance management basics if you're new to `HybridTMFactory`
- [02 · Importing Data](02-importing-data.md) documents the same batch-import pipeline `restore` reuses
- [05 · Command-Line Interface](05-command-line-interface.md) has the full CLI flag reference
