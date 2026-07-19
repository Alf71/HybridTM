# TODO

- Implement a new mechanism to provide batch import progress information to consumers without relying on console logging.
- Extend the Match class (and semanticTranslationSearch output) to include source and target metadata so translation searches return the same metadata details as semanticSearch.
- Design a pluggable glossary import pipeline starting with TBX and GlossML support, aligned with the existing XLIFF/TMX reader → JSONL → BatchImporter flow.
