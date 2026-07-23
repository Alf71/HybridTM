/*******************************************************************************
 * Copyright (c) 2025-2026 Maxprograms.
 *
 * This program and the accompanying materials
 * are made available under the terms of the Eclipse   License 1.0
 * which accompanies this distribution, and is available at
 * https://www.eclipse.org/org/documents/epl-v10.html
 *
 * Contributors:
 *     Maxprograms - initial API and implementation
 *******************************************************************************/

import { FeatureExtractionPipeline, pipeline, Tensor } from '@huggingface/transformers';
import { connect, Connection, Index, Table } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import { createWriteStream, existsSync, unlinkSync, WriteStream } from 'node:fs';
import { tmpdir } from "node:os";
import { join } from 'node:path';
import { TMReader } from 'sdltm';
import { XMLAttribute, XMLElement } from 'typesxml';
import { BackupReader } from './backupReader.js';
import { BatchImporter } from './batchImporter.js';
import { ImportOptions, resolveImportOptions, TranslationState } from './importOptions.js';
import { EntryMetadata, LangEntry, SearchResult, SegmentMetadata } from './langEntry.js';
import { Match } from './match.js';
import { MatchQuality } from './matchQuality.js';
import { PendingEntry } from './pendingEntry.js';
import { MetadataFilter, TranslationSearchFilters } from './searchFilters.js';
import { TMXReader } from './tmxReader.js';
import { Utils } from './utils.js';
import { XLIFFReader } from './xliffReader.js';

export class HybridTM {

    // OPTIMIZED MODELS
    static readonly COMPACT_MODEL: string = 'Xenova/multilingual-e5-small';               // 384-dim, smallest footprint
    static readonly STANDARD_MODEL: string = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'; // 384-dim, same footprint as compact
    static readonly LARGE_MODEL: string = 'onnx-community/gte-multilingual-base';         // 768-dim, largest footprint

    private name: string;
    private db: Connection | null = null;
    private table: Table | null = null;
    private dbPath: string = '';
    private embedder: FeatureExtractionPipeline | null = null;
    private embedderPromise: Promise<void> | null = null;
    private modelName: string = '';
    private initialized: boolean = false;
    private initializationPromise: Promise<void> | null = null;

    constructor(name: string, filePath: string, modelName: string = HybridTM.LARGE_MODEL) {
        this.name = name;
        this.dbPath = filePath;
        this.modelName = modelName;
    }

    // ============================
    // INITIALIZATION METHODS
    // ============================

    private async detectModelDimensions(): Promise<number> {
        try {
            // Ensure embedder is initialized
            if (!this.embedder) {
                await this.initializeEmbedder();
            }

            if (!this.embedder) {
                throw new Error('Failed to initialize embedder for dimension detection');
            }

            // Generate a small test embedding
            const testResult: Tensor = await this.embedder('test', {
                pooling: 'mean',
                normalize: true
            });
            return Array.from(testResult.data).length;
        } catch (err: unknown) {
            console.error('Error detecting model dimensions:', err);
            throw new Error('Unable to detect model dimensions for ' + this.modelName + ': ' + (err instanceof Error ? err.message : String(err)));
        }
    }

    private async initialize(): Promise<void> {
        try {
            // Initialize database and embedder in parallel
            await Promise.all([
                this.initializeDatabase(),
                this.initializeEmbedder()
            ]);
        } catch (err: unknown) {
            console.error('Failed to initialize HybridTM:', err);
            throw new Error('HybridTM initialization failed: ' + (err instanceof Error ? err.message : String(err)));
        }
    }

    private async initializeDatabase(): Promise<void> {
        try {
            // Connect to LanceDB
            this.db = await connect(this.dbPath);

            // Check if table exists, if not create it
            const tableNames: string[] = await this.db.tableNames();
            if (!tableNames.includes('langEntry')) {
                // Detect model dimensions first
                const dimensions: number = await this.detectModelDimensions();

                // Create Arrow schema for the langEntry table
                const schema: Schema = new Schema([
                    Field.new('id', new Utf8(), false),
                    Field.new('language', new Utf8(), false),
                    Field.new('pureText', new Utf8(), false),
                    Field.new('element', new Utf8(), false),
                    Field.new('fileId', new Utf8(), false),
                    Field.new('original', new Utf8(), false),
                    Field.new('unitId', new Utf8(), false),
                    Field.new('segmentIndex', new Int32(), false),
                    Field.new('segmentCount', new Int32(), false),
                    Field.new('metadataState', new Utf8(), true),
                    Field.new('metadataSubState', new Utf8(), true),
                    Field.new('metadataQuality', new Int32(), true),
                    Field.new('metadataCreationDate', new Utf8(), true),
                    Field.new('metadataCreationId', new Utf8(), true),
                    Field.new('metadataChangeDate', new Utf8(), true),
                    Field.new('metadataChangeId', new Utf8(), true),
                    Field.new('metadataCreationTool', new Utf8(), true),
                    Field.new('metadataCreationToolVersion', new Utf8(), true),
                    Field.new('metadataContext', new Utf8(), true),
                    Field.new('metadataNotes', new Utf8(), true),
                    Field.new('metadataUsageCount', new Int32(), true),
                    Field.new('metadataLastUsageDate', new Utf8(), true),
                    Field.new('metadataProperties', new Utf8(), true),
                    Field.new('metadataSegment', new Utf8(), true),
                    Field.new('vector', new FixedSizeList(dimensions, Field.new('item', new Float32(), false)), false),
                ]);

                // Create table with the schema
                this.table = await this.db.createEmptyTable('langEntry', schema);

                // "id" is looked up by exact match constantly (storeLangEntry/storeBatchEntries
                // dedup, entryExists, getLangEntry, deleteLangEntry, findTargetEntry); without a
                // scalar index each lookup is a full table scan.
                await this.table.createIndex('id', { config: Index.btree(), waitTimeoutSeconds: 30 });
            } else {
                this.table = await this.db.openTable('langEntry');
            }
        } catch (err: unknown) {
            console.error('Error initializing LanceDB:', err);
            throw err;
        }
    }

    private initializeEmbedder(): Promise<void> {
        if (!this.embedderPromise) {
            this.embedderPromise = this.loadEmbedder();
        }
        return this.embedderPromise;
    }

    private async loadEmbedder(): Promise<void> {
        try {
            // dtype must be explicit: some models ship an unquantized model.onnx that
            // requires an external model.onnx_data file Transformers.js does not reliably
            // fetch/mount; quantized variants are single-file and avoid it.
            this.embedder = await pipeline('feature-extraction', this.modelName, { dtype: 'q8' });
        } catch (err: unknown) {
            this.embedderPromise = null;
            console.error('Error initializing embedder:', err);
            throw err;
        }
    }

    private async generateEmbedding(text: string): Promise<number[]> {
        try {
            // Ensure embedder is initialized
            if (!this.embedder) {
                await this.initializeEmbedder();
            }

            if (!this.embedder) {
                throw new Error('Failed to initialize embedder');
            }

            // Generate embeddings using the transformer model
            const result: Tensor = await this.embedder(text, {
                pooling: 'mean',
                normalize: true
            });

            // Convert tensor to array
            const embedding: number[] = Array.from(result.data);
            return embedding;
        } catch (err: unknown) {
            console.error('Error generating embedding:', err);
            throw err;
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) {
            return;
        }

        if (this.initializationPromise) {
            await this.initializationPromise;
            return;
        }

        this.initializationPromise = this.initialize();
        await this.initializationPromise;
        this.initialized = true;
    }

    private async ensureTable(): Promise<Table> {
        await this.ensureInitialized();
        if (!this.table) {
            throw new Error('Database table is not available');
        }
        return this.table;
    }

    private hydrateEntries(rows: unknown[]): LangEntry[] {
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows.map((row: unknown) => this.hydrateEntry((row ?? {}) as Record<string, unknown>));
    }

    private hydrateEntry(row: Record<string, unknown>): LangEntry {
        const metadata: EntryMetadata = this.unflattenMetadata(row);
        const vectorData: unknown = row.vector;
        const vector: number[] = Array.isArray(vectorData)
            ? vectorData as number[]
            : ArrayBuffer.isView(vectorData)
                ? Array.from(vectorData as unknown as Iterable<number>)
                : typeof vectorData === 'object' && vectorData !== null && typeof (vectorData as { toArray?: () => unknown }).toArray === 'function'
                    ? Array.from(((vectorData as { toArray: () => unknown }).toArray() as unknown as Iterable<number>))
                    : [];
        const hydrated: Record<string, unknown> = { ...row };
        hydrated.id = typeof row.id === 'string' ? row.id : '';
        hydrated.language = typeof row.language === 'string' ? row.language : '';
        hydrated.pureText = typeof row.pureText === 'string' ? row.pureText : '';
        hydrated.element = typeof row.element === 'string' ? row.element : '';
        hydrated.fileId = typeof row.fileId === 'string' ? row.fileId : '';
        hydrated.original = typeof row.original === 'string' ? row.original : '';
        hydrated.unitId = typeof row.unitId === 'string' ? row.unitId : '';
        hydrated.vector = vector;
        hydrated.segmentIndex = this.parseNumber(row.segmentIndex, 0);
        hydrated.segmentCount = this.parseNumber(row.segmentCount, 1);
        hydrated.metadata = metadata;
        return hydrated as LangEntry;
    }

    private flattenEntry(entry: LangEntry): Record<string, unknown> {
        const metadataFields: Record<string, unknown> = this.flattenMetadata(entry.metadata);
        return {
            id: entry.id,
            language: entry.language,
            pureText: entry.pureText,
            element: entry.element,
            fileId: entry.fileId,
            original: entry.original,
            unitId: entry.unitId,
            segmentIndex: entry.segmentIndex,
            segmentCount: entry.segmentCount,
            vector: entry.vector,
            ...metadataFields,
        };
    }

    private mapToSearchResult(entry: LangEntry): SearchResult {
        if (!entry.metadata) {
            entry.metadata = {};
        }
        return {
            id: entry.id,
            language: entry.language,
            pureText: entry.pureText,
            element: entry.element,
            fileId: entry.fileId,
            original: entry.original,
            unitId: entry.unitId,
            segmentIndex: entry.segmentIndex,
            segmentCount: entry.segmentCount,
            metadata: entry.metadata,
        };
    }

    private buildEntryId(fileId: string, unitId: string, segmentIndex: number, lang: string): string {
        return fileId + ':' + unitId + ':' + segmentIndex + ':' + lang;
    }

    private flattenMetadata(metadata: EntryMetadata | undefined): Record<string, unknown> {
        const safeMetadata: EntryMetadata = metadata ? metadata : {};
        return {
            metadataState: safeMetadata.state ?? null,
            metadataSubState: safeMetadata.subState ?? null,
            metadataQuality: typeof safeMetadata.quality === 'number' ? safeMetadata.quality : null,
            metadataCreationDate: safeMetadata.creationDate ?? null,
            metadataCreationId: safeMetadata.creationId ?? null,
            metadataChangeDate: safeMetadata.changeDate ?? null,
            metadataChangeId: safeMetadata.changeId ?? null,
            metadataCreationTool: safeMetadata.creationTool ?? null,
            metadataCreationToolVersion: safeMetadata.creationToolVersion ?? null,
            metadataContext: safeMetadata.context ?? null,
            metadataNotes: safeMetadata.notes ? JSON.stringify(safeMetadata.notes) : null,
            metadataUsageCount: typeof safeMetadata.usageCount === 'number' ? safeMetadata.usageCount : null,
            metadataLastUsageDate: safeMetadata.lastUsageDate ?? null,
            metadataProperties: safeMetadata.properties ? JSON.stringify(safeMetadata.properties) : null,
            metadataSegment: safeMetadata.segment ? JSON.stringify(safeMetadata.segment) : null,
        };
    }

    private unflattenMetadata(row: Record<string, unknown>): EntryMetadata {
        const metadata: EntryMetadata = {};
        const str = (value: unknown): string | undefined => {
            if (typeof value === 'string' && value.length > 0) {
                return value;
            }
            return undefined;
        };
        const num = (value: unknown): number | undefined => {
            if (typeof value === 'number' && !Number.isNaN(value)) {
                return value;
            }
            if (typeof value === 'string' && value.length > 0) {
                const parsed: number = Number(value);
                if (!Number.isNaN(parsed)) {
                    return parsed;
                }
            }
            return undefined;
        };
        const stateValue: string | undefined = str(row.metadataState);
        const validStatuses: string[] = ['initial', 'translated', 'reviewed', 'final'];
        if (stateValue && validStatuses.includes(stateValue)) {
            metadata.state = stateValue as TranslationState;
        }
        const subStateValue: string | undefined = str(row.metadataSubState);
        if (subStateValue) {
            metadata.subState = subStateValue;
        }
        const qualityValue: number | undefined = num(row.metadataQuality);
        if (qualityValue !== undefined) {
            metadata.quality = qualityValue;
        }
        const creationDateValue: string | undefined = str(row.metadataCreationDate);
        if (creationDateValue) {
            metadata.creationDate = creationDateValue;
        }
        const creationIdValue: string | undefined = str(row.metadataCreationId);
        if (creationIdValue) {
            metadata.creationId = creationIdValue;
        }
        const changeDateValue: string | undefined = str(row.metadataChangeDate);
        if (changeDateValue) {
            metadata.changeDate = changeDateValue;
        }
        const changeIdValue: string | undefined = str(row.metadataChangeId);
        if (changeIdValue) {
            metadata.changeId = changeIdValue;
        }
        const creationToolValue: string | undefined = str(row.metadataCreationTool);
        if (creationToolValue) {
            metadata.creationTool = creationToolValue;
        }
        const creationToolVersionValue: string | undefined = str(row.metadataCreationToolVersion);
        if (creationToolVersionValue) {
            metadata.creationToolVersion = creationToolVersionValue;
        }
        const contextValue: string | undefined = str(row.metadataContext);
        if (contextValue) {
            metadata.context = contextValue;
        }
        const notesValue: string[] | undefined = this.parseNotes(row.metadataNotes);
        if (notesValue && notesValue.length > 0) {
            metadata.notes = notesValue;
        }
        const usageCountValue: number | undefined = num(row.metadataUsageCount);
        if (usageCountValue !== undefined) {
            metadata.usageCount = usageCountValue;
        }
        const lastUsageDateValue: string | undefined = str(row.metadataLastUsageDate);
        if (lastUsageDateValue) {
            metadata.lastUsageDate = lastUsageDateValue;
        }
        const properties: Record<string, string> | undefined = this.parseProperties(row.metadataProperties);
        if (properties && Object.keys(properties).length > 0) {
            metadata.properties = properties;
        }
        const segment: SegmentMetadata | undefined = this.parseSegment(row.metadataSegment);
        if (segment) {
            metadata.segment = segment;
        }
        return metadata;
    }

    private parseNotes(value: unknown): string[] | undefined {
        if (typeof value !== 'string' || value.length === 0) {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.filter((item: unknown): item is string => typeof item === 'string');
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private parseSegment(value: unknown): SegmentMetadata | undefined {
        if (typeof value !== 'string' || value.length === 0) {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
                return parsed as SegmentMetadata;
            }
        } catch (err) {
            console.warn('Failed to parse metadata.segment:', err);
        }
        return undefined;
    }

    private parseProperties(value: unknown): Record<string, string> | undefined {
        if (typeof value !== 'string' || value.length === 0) {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
                const result: Record<string, string> = {};
                Object.entries(parsed as Record<string, unknown>).forEach(([key, val]: [string, unknown]) => {
                    if (typeof val === 'string') {
                        result[key] = val;
                    }
                });
                return result;
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private parseNumber(value: unknown, fallback: number): number {
        const parsed: number | undefined = typeof value === 'number' && !Number.isNaN(value)
            ? value
            : typeof value === 'string' && value.length > 0 && !Number.isNaN(Number(value))
                ? Number(value)
                : undefined;
        return typeof parsed === 'number' ? parsed : fallback;
    }

    async close(): Promise<void> {
        try {
            if (this.table) {
                this.table.close();
                this.table = null;
            }
            if (this.db) {
                this.db.close();
                this.db = null;
            }
            if (this.embedder) {
                await this.embedder.dispose();
                this.embedder = null;
            }
            this.embedderPromise = null;
            this.initialized = false;
            this.initializationPromise = null;
        } catch (err: unknown) {
            console.error('Error closing database:', err);
        }
    }

    // ============================
    // SEARCH METHODS
    // ============================

    async concordanceSearch(textFragment: string, language: string, limit: number = 100, filters?: MetadataFilter): Promise<Map<string, XMLElement>[]> {
        // Enhanced concordance search: finds text fragments and returns all language variants for matching units
        try {
            const table: Table = await this.ensureTable();

            const normalizedLang: string | undefined = Utils.normalizeLanguage(language);
            if (!normalizedLang) {
                throw new Error('Invalid language code "' + language + '"');
            }
            const escapedFragment: string = Utils.replaceQuotes(textFragment);

            const whereFragment: string = 'language = ' + '\'' + normalizedLang + '\'' + ' AND contains(pureText, ' + '\'' + escapedFragment + '\')';
            const fragmentEntries: LangEntry[] = this.hydrateEntries(await table
                .query()
                .where(whereFragment)
                .limit(limit)
                .toArray());

            const filteredEntries: LangEntry[] = filters
                ? fragmentEntries.filter((entry: LangEntry) => this.metadataMatches(entry.metadata, filters))
                : fragmentEntries;

            if (filteredEntries.length === 0) {
                return [];
            }

            const segmentDescriptors: Map<string, { fileId: string; unitId: string; segmentIndex: number; }> = new Map();
            filteredEntries.forEach((entry: LangEntry) => {
                const segmentIndex: number = typeof entry.segmentIndex === 'number' ? entry.segmentIndex : 0;
                const descriptorKey: string = entry.fileId + '|' + entry.unitId + '|' + segmentIndex;
                if (!segmentDescriptors.has(descriptorKey)) {
                    segmentDescriptors.set(descriptorKey, {
                        fileId: entry.fileId,
                        unitId: entry.unitId,
                        segmentIndex
                    });
                }
            });

            const result: Map<string, XMLElement>[] = [];

            for (const descriptor of segmentDescriptors.values()) {
                const segmentPrefix: string = descriptor.fileId + ':' + descriptor.unitId + ':' + descriptor.segmentIndex + ':';
                const sanitizedPrefix: string = Utils.replaceQuotes(segmentPrefix);
                const segmentVariants: LangEntry[] = this.hydrateEntries(await table
                    .query()
                    .where('starts_with(id, ' + '\'' + sanitizedPrefix + '\')')
                    .toArray());

                if (segmentVariants.length === 0) {
                    continue;
                }

                const languageMap: Map<string, XMLElement> = new Map<string, XMLElement>();
                for (const variant of segmentVariants) {
                    try {
                        const xmlElement: XMLElement = Utils.buildXMLElement(variant.element);
                        languageMap.set(variant.language, xmlElement);
                    } catch (parseErr: unknown) {
                        const errorMessage: string = parseErr instanceof Error ? parseErr.message : String(parseErr);
                        throw new Error('Failed to create XML element for ' + variant.id + ': ' + errorMessage);
                    }
                }

                if (languageMap.size > 0) {
                    result.push(languageMap);
                    if (result.length >= limit) {
                        break;
                    }
                }
            }
            return result;
        } catch (err: unknown) {
            console.error('Error performing concordance search:', err);
            throw err;
        }
    }

    async semanticSearch(queryText: string, language: string, limit: number = 10, filters?: MetadataFilter): Promise<SearchResult[]> {
        try {
            const table: Table = await this.ensureTable();
            const normalizedLang: string | undefined = Utils.normalizeLanguage(language);
            if (!normalizedLang) {
                throw new Error('Invalid language code "' + language + '"');
            }
            const queryEmbedding: number[] = await this.generateEmbedding(queryText);
            const results: LangEntry[] = this.hydrateEntries(await table
                .vectorSearch(queryEmbedding)
                .where('language = ' + '\'' + normalizedLang + '\'')
                .limit(limit)
                .toArray());
            const filtered: LangEntry[] = filters
                ? results.filter((entry: LangEntry) => this.metadataMatches(entry.metadata, filters))
                : results;
            return filtered.map((entry: LangEntry) => this.mapToSearchResult(entry));
        } catch (err: unknown) {
            console.error('Error performing semantic search:', err);
            throw err;
        }
    }

    async semanticTranslationSearch(searchStr: string, srcLang: string, tgtLang: string, similarity: number, limit: number = 100, filters?: TranslationSearchFilters): Promise<Array<Match>> {
        try {
            const table: Table = await this.ensureTable();

            const normalizedSrc: string | undefined = Utils.normalizeLanguage(srcLang);
            if (!normalizedSrc) {
                throw new Error('Invalid language code "' + srcLang + '"');
            }
            const normalizedTgt: string | undefined = Utils.normalizeLanguage(tgtLang);
            if (!normalizedTgt) {
                throw new Error('Invalid language code "' + tgtLang + '"');
            }

            // Generate embedding for the search string
            const queryEmbedding: number[] = await this.generateEmbedding(searchStr);

            // Fetch a candidate pool well beyond the requested output size: hybrid re-ranking
            // below can reorder results relative to raw vector distance, so a tight candidate
            // pool can silently exclude the true best match before re-ranking ever sees it.
            const candidateLimit: number = Math.max(limit * 5, 50);
            const sourceEntries: LangEntry[] = this.hydrateEntries(await table
                .vectorSearch(queryEmbedding)
                .where('language = ' + '\'' + normalizedSrc + '\'')
                .limit(candidateLimit)
                .toArray());
            const rankedMatches: Array<{ match: Match; score: number; }> = [];
            const sourceCriteria: MetadataFilter | undefined = filters?.source;
            const targetCriteria: MetadataFilter | undefined = filters?.target ?? filters?.source;

            for (const sourceEntry of sourceEntries) {
                if (!sourceEntry.pureText || !sourceEntry.vector) {
                    continue;
                }

                if (sourceCriteria && !this.metadataMatches(sourceEntry.metadata, sourceCriteria)) {
                    continue;
                }

                // Linear mapping (more intuitive)
                const rawDistance: unknown = sourceEntry._distance;
                const l2Distance: number = typeof rawDistance === 'number'
                    ? rawDistance
                    : typeof rawDistance === 'string' && rawDistance.length > 0 && !Number.isNaN(Number(rawDistance))
                        ? Number(rawDistance)
                        : 0;
                const semanticScore = Math.max(0, Math.round((2 - l2Distance) / 2 * 100));
                const fuzzyScore: number = MatchQuality.similarity(searchStr, sourceEntry.pureText);
                const hybridScore = Math.round((semanticScore + fuzzyScore) / 2);

                // Only include matches that meet the minimum similarity threshold
                if (hybridScore >= similarity) {
                    const targetEntry: LangEntry | null = await this.findTargetEntry(table, sourceEntry, normalizedTgt, targetCriteria);
                    if (!targetEntry) {
                        continue;
                    }
                    if (targetCriteria && !this.metadataMatches(targetEntry.metadata, targetCriteria)) {
                        continue;
                    }
                    try {
                        const sourceElement: XMLElement = Utils.buildXMLElement(sourceEntry.element);
                        const targetElement: XMLElement = Utils.buildXMLElement(targetEntry.element);
                        const match: Match = new Match(
                            targetEntry.id,
                            sourceElement,
                            targetElement,
                            this.name,
                            semanticScore,
                            fuzzyScore,
                            targetEntry.metadata?.properties
                        );
                        const rankingScore: number = this.computeRankingScore(match.hybridScore(), sourceEntry, targetEntry);
                        rankedMatches.push({ match, score: rankingScore });
                    } catch (parseErr: unknown) {
                        console.error('Error creating Match for semantic translation search: ' + (parseErr instanceof Error ? parseErr.message : String(parseErr)));
                    }
                }
            }
            rankedMatches.sort((a, b) => b.score - a.score);
            return rankedMatches.slice(0, limit).map((item) => item.match);
        } catch (err: unknown) {
            console.error('Error performing semantic search with quality:', err);
            throw err;
        }
    }

    private async findTargetEntry(table: Table, sourceEntry: LangEntry, tgtLang: string, filters?: MetadataFilter): Promise<LangEntry | null> {
        if (!sourceEntry.fileId || !sourceEntry.unitId) {
            return null;
        }

        const exactId: string = this.buildEntryId(sourceEntry.fileId, sourceEntry.unitId, sourceEntry.segmentIndex, tgtLang);
        const exactMatches: LangEntry[] = this.hydrateEntries(await table
            .query()
            .where('id = ' + '\'' + Utils.replaceQuotes(exactId) + '\'')
            .toArray());
        const exactMatch: LangEntry | undefined = this.selectPreferredCandidate(exactMatches, sourceEntry.segmentIndex, filters);
        if (exactMatch) {
            return exactMatch;
        }

        const unitPrefix: string = sourceEntry.fileId + ':' + sourceEntry.unitId + ':';
        const sanitizedPrefix: string = Utils.replaceQuotes(unitPrefix);
        const unitMatches: LangEntry[] = this.hydrateEntries(await table
            .query()
            .where('starts_with(id, ' + '\'' + sanitizedPrefix + '\') AND language = ' + '\'' + tgtLang + '\'')
            .limit(50)
            .toArray());

        if (unitMatches.length === 0) {
            return null;
        }

        const preferred: LangEntry | undefined = this.selectPreferredCandidate(unitMatches, sourceEntry.segmentIndex, filters);
        return preferred ?? null;
    }

    private computeRankingScore(baseScore: number, sourceEntry: LangEntry, targetEntry: LangEntry): number {
        let score: number = baseScore;

        if (sourceEntry.segmentIndex > 0 && targetEntry.segmentIndex > 0) {
            score += sourceEntry.segmentIndex === targetEntry.segmentIndex ? 10 : 5;
        }

        const quality: number | undefined = targetEntry.metadata && typeof targetEntry.metadata.quality === 'number'
            ? targetEntry.metadata.quality
            : undefined;
        if (quality !== undefined && !Number.isNaN(quality)) {
            score += Math.min(Math.max(quality, 0), 100) / 20;
        }

        const recencyTimestamp: number | undefined = this.parseMetadataTimestamp(
            targetEntry.metadata?.changeDate || targetEntry.metadata?.creationDate
        );
        if (recencyTimestamp !== undefined) {
            const ageDays: number = (Date.now() - recencyTimestamp) / 86400000;
            if (Number.isFinite(ageDays) && ageDays >= 0) {
                const normalized: number = Math.max(0, 1 - Math.min(ageDays, 365) / 365);
                score += normalized * 5;
            }
        }

        if (targetEntry.metadata?.state === 'final') {
            score += 3;
        } else if (targetEntry.metadata?.state === 'reviewed') {
            score += 2;
        } else if (targetEntry.metadata?.state === 'translated') {
            score += 1;
        }

        return score;
    }

    private parseMetadataTimestamp(value: string | undefined): number | undefined {
        if (!value) {
            return undefined;
        }
        const parsed: number = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    private selectPreferredCandidate(entries: LangEntry[], desiredSegmentIndex: number, filters?: MetadataFilter): LangEntry | undefined {
        if (!entries || entries.length === 0) {
            return undefined;
        }
        const filtered: LangEntry[] = filters
            ? entries.filter((entry: LangEntry) => this.metadataMatches(entry.metadata, filters))
            : entries.slice();
        if (filtered.length === 0) {
            return undefined;
        }
        if (desiredSegmentIndex > 0) {
            const exact: LangEntry | undefined = filtered.find((entry: LangEntry) => entry.segmentIndex === desiredSegmentIndex);
            if (exact) {
                return exact;
            }
        }
        const segmentEntry: LangEntry | undefined = filtered.find((entry: LangEntry) => entry.segmentIndex > 0);
        if (segmentEntry) {
            return segmentEntry;
        }
        return filtered[0];
    }

    private metadataMatches(metadata: EntryMetadata | undefined, filter?: MetadataFilter): boolean {
        if (!filter) {
            return true;
        }
        if (!metadata) {
            return false;
        }

        if (filter.states && filter.states.length > 0) {
            if (!metadata.state || !filter.states.includes(metadata.state)) {
                return false;
            }
        }

        if (filter.minState) {
            const metadataRank: number = this.getStateRank(metadata.state);
            if (metadataRank === 0 || metadataRank < this.getStateRank(filter.minState)) {
                return false;
            }
        }

        if (typeof filter.minQuality === 'number') {
            if (typeof metadata.quality !== 'number' || metadata.quality < filter.minQuality) {
                return false;
            }
        }

        if (filter.contextIncludes && filter.contextIncludes.length > 0) {
            const contextValue: string = (metadata.context || '').toLowerCase();
            const matchesAll: boolean = filter.contextIncludes.every((needle: string) => contextValue.includes(needle.toLowerCase()));
            if (!matchesAll) {
                return false;
            }
        }

        if (filter.requiredProperties) {
            if (!metadata.properties) {
                return false;
            }
            for (const [key, expected] of Object.entries(filter.requiredProperties)) {
                if (metadata.properties[key] !== expected) {
                    return false;
                }
            }
        }

        if (filter.provider) {
            const provider: string | undefined = metadata.segment?.provider;
            if (!provider || provider !== filter.provider) {
                return false;
            }
        }

        return true;
    }

    private getStateRank(value: TranslationState | undefined): number {
        if (!value) {
            return 0;
        }
        switch (value) {
            case 'initial':
                return 1;
            case 'translated':
                return 2;
            case 'reviewed':
                return 3;
            case 'final':
                return 4;
            default:
                return 0;
        }
    }

    // ============================
    // DATA MANAGEMENT METHODS
    // ============================

    async storeLangEntry(
        fileId: string,
        original: string,
        unitId: string,
        lang: string,
        pureText: string,
        element: XMLElement,
        embeddings?: number[],
        segmentIndex: number = 0,
        segmentCount: number = 1,
        metadata?: EntryMetadata
    ): Promise<void> {
        try {
            const table: Table = await this.ensureTable();
            const normalizedLang: string | undefined = Utils.normalizeLanguage(lang);
            if (!normalizedLang) {
                throw new Error('Invalid language code "' + lang + '"');
            }
            const safeSegmentIndex: number = typeof segmentIndex === 'number' ? segmentIndex : 0;
            const safeSegmentCount: number = typeof segmentCount === 'number' && segmentCount > 0 ? segmentCount : 1;
            const entryId: string = this.buildEntryId(fileId, unitId, safeSegmentIndex, normalizedLang);
            const existingEntries: LangEntry[] = this.hydrateEntries(await table
                .query()
                .where('id = ' + '\'' + Utils.replaceQuotes(entryId) + '\'')
                .toArray());

            let existingVector: number[] | undefined;
            if (existingEntries.length > 0) {
                const existingEntry: LangEntry = existingEntries[0];
                const contentChanged: boolean = (
                    existingEntry.pureText !== pureText ||
                    existingEntry.element !== element.toString() ||
                    existingEntry.original !== original
                );
                const metadataChanged: boolean = JSON.stringify(this.flattenMetadata(existingEntry.metadata))
                    !== JSON.stringify(this.flattenMetadata(metadata));

                if (!contentChanged && !metadataChanged) {
                    return;
                }
                if (!contentChanged) {
                    existingVector = existingEntry.vector;
                }
            }

            // Generate embeddings if not provided
            let vectorEmbeddings: number[];
            if (embeddings && embeddings.length > 0) {
                vectorEmbeddings = embeddings;
            } else if (existingVector && existingVector.length > 0) {
                vectorEmbeddings = existingVector;
            } else {
                vectorEmbeddings = await this.generateEmbedding(pureText);
            }

            const entry: LangEntry = {
                id: entryId,
                language: normalizedLang,
                pureText: pureText,
                element: element.toString(),
                fileId: fileId,
                original: original,
                unitId: unitId,
                vector: vectorEmbeddings,
                segmentIndex: safeSegmentIndex,
                segmentCount: safeSegmentCount,
                metadata: metadata ?? {}
            };

            // Delete existing entry first (LanceDB upsert approach)
            try {
                await table.delete('id = ' + '\'' + Utils.replaceQuotes(entryId) + '\'');
            } catch (deleteErr: unknown) {
                // Entry might not exist, which is fine
            }

            await table.add([this.flattenEntry(entry)]);
        } catch (err: unknown) {
            console.error('Error storing language entry:', err);
            throw err;
        }
    }

    async storeBatchEntries(entries: PendingEntry[]): Promise<void> {
        try {
            const table: Table = await this.ensureTable();
            const langEntries: LangEntry[] = [];

            // Collect all entry IDs for bulk deletion
            const entryIds: string[] = [];

            // Generate embeddings one by one and build LangEntry objects
            for (const entry of entries) {
                const normalizedLang: string | undefined = Utils.normalizeLanguage(entry.language);
                if (!normalizedLang) {
                    throw new Error('Invalid language code "' + entry.language + '"');
                }
                const vectorEmbeddings: number[] = await this.generateEmbedding(entry.pureText);
                const safeSegmentIndex: number = typeof entry.segmentIndex === 'number' ? entry.segmentIndex : 0;
                const safeSegmentCount: number = typeof entry.segmentCount === 'number' && entry.segmentCount > 0 ? entry.segmentCount : 1;
                const entryId: string = this.buildEntryId(entry.fileId, entry.unitId, safeSegmentIndex, normalizedLang);

                const langEntry: LangEntry = {
                    id: entryId,
                    language: normalizedLang,
                    pureText: entry.pureText,
                    element: entry.element.toString(),
                    fileId: entry.fileId,
                    original: entry.original,
                    unitId: entry.unitId,
                    vector: vectorEmbeddings,
                    segmentIndex: safeSegmentIndex,
                    segmentCount: safeSegmentCount,
                    metadata: entry.metadata ?? {}
                };

                langEntries.push(langEntry);
                entryIds.push(entryId);
            }

            // Delete any existing entries with these IDs to prevent duplicates
            // This ensures that if the same file is imported twice, entries are overwritten
            if (entryIds.length > 0) {
                const idsFilter: string = entryIds.map(id => '\'' + Utils.replaceQuotes(id) + '\'').join(',');
                try {
                    await table.delete('id IN (' + idsFilter + ')');
                } catch (deleteErr: unknown) {
                    // Entries might not exist, which is fine for first import
                }
            }

            // Bulk insert all entries at once
            const flattenedEntries: Record<string, unknown>[] = langEntries.map((item: LangEntry) => this.flattenEntry(item));
            await table.add(flattenedEntries);
        } catch (err: unknown) {
            console.error('Error storing batch entries:', err);
            throw err;
        }
    }

    async entryExists(fileId: string, unitId: string, lang: string, segmentIndex: number = 0): Promise<boolean> {
        try {
            const table: Table = await this.ensureTable();
            const normalizedLang: string | undefined = Utils.normalizeLanguage(lang);
            if (!normalizedLang) {
                throw new Error('Invalid language code "' + lang + '"');
            }
            const entryId: string = this.buildEntryId(fileId, unitId, segmentIndex, normalizedLang);
            const existingEntries: LangEntry[] = this.hydrateEntries(await table
                .query()
                .where('id = ' + '\'' + Utils.replaceQuotes(entryId) + '\'')
                .toArray());

            return existingEntries.length > 0;
        } catch (err: unknown) {
            console.error('Error checking entry existence:', err);
            return false;
        }
    }

    async getLangEntry(fileId: string, unitId: string, lang: string, segmentIndex: number = 0): Promise<LangEntry | null> {
        try {
            const table: Table = await this.ensureTable();
            const normalizedLang: string | undefined = Utils.normalizeLanguage(lang);
            if (!normalizedLang) {
                throw new Error('Invalid language code "' + lang + '"');
            }
            const entryId: string = this.buildEntryId(fileId, unitId, segmentIndex, normalizedLang);
            const existingEntries: LangEntry[] = this.hydrateEntries(await table
                .query()
                .where('id = ' + '\'' + Utils.replaceQuotes(entryId) + '\'')
                .toArray());

            return existingEntries.length > 0 ? existingEntries[0] : null;
        } catch (err: unknown) {
            console.error('Error retrieving language entry:', err);
            return null;
        }
    }

    async deleteLangEntry(fileId: string, unitId: string, lang: string, segmentIndex: number = 0): Promise<boolean> {
        try {
            const table: Table = await this.ensureTable();
            const normalizedLang: string | undefined = Utils.normalizeLanguage(lang);
            if (!normalizedLang) {
                throw new Error('Invalid language code "' + lang + '"');
            }
            const entryId: string = this.buildEntryId(fileId, unitId, segmentIndex, normalizedLang);

            // Check if entry exists first
            const exists: boolean = await this.entryExists(fileId, unitId, lang, segmentIndex);
            if (!exists) {
                return false;
            }

            // Delete the entry
            await table.delete('id = \'' + Utils.replaceQuotes(entryId) + '\'');
            return true;
        } catch (err: unknown) {
            console.error('Error deleting language entry:', err);
            return false;
        }
    }

    // ============================
    // DATA IMPORT METHODS
    // ============================

    async importXLIFF(filePath: string, options?: ImportOptions): Promise<number> {
        // Phase 1: Parse XLIFF and write to temporary JSONL file
        const resolvedOptions: ImportOptions = resolveImportOptions(options);
        const reader: XLIFFReader = new XLIFFReader(filePath, resolvedOptions);
        await reader.parse();

        // Phase 2: Batch import from JSONL file (asynchronous)
        const importer: BatchImporter = new BatchImporter(this, reader.getTempFilePath(), reader.getEntryCount());
        await importer.import();
        return reader.getEntryCount();
    }

    async importTMX(filePath: string, options?: ImportOptions): Promise<number> {
        // Phase 1: Parse TMX and write to temporary JSONL file
        const resolvedOptions: ImportOptions = resolveImportOptions(options);
        const reader: TMXReader = new TMXReader(filePath, resolvedOptions);
        await reader.parse();

        // Phase 2: Batch import from JSONL file (asynchronous)
        const importer: BatchImporter = new BatchImporter(this, reader.getTempFilePath(), reader.getEntryCount());
        await importer.import();
        return reader.getEntryCount();
    }

    async importSDLTM(filePath: string, options?: ImportOptions): Promise<number> {
        const tempDir = tmpdir();
        const tempFileName = 'tmx_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.tmx';
        const tempFilePath: string = join(tempDir, tempFileName);
        const packageJson: any = await import('../package.json', { with: { type: 'json' } });
        const productName: string = packageJson.default.productName;
        const version: string = packageJson.default.version;
        const tmReader: TMReader = new TMReader({ 'productName': productName, 'version': version });
        try {
            const data = await tmReader.convert(filePath, tempFilePath);
            if (data.status !== 'Success') {
                throw new Error('SDL TM conversion failed for file ' + filePath);
            }
            return await this.importTMX(tempFilePath, options);
        } finally {
            if (existsSync(tempFilePath)) {
                unlinkSync(tempFilePath);
            }
        }
    }

    // ============================
    // BACKUP AND RESTORE METHODS
    // ============================

    async restore(filePath: string): Promise<number> {
        const reader: BackupReader = new BackupReader(filePath);
        await reader.parse();

        const importer: BatchImporter = new BatchImporter(this, reader.getTempFilePath(), reader.getEntryCount());
        await importer.import();
        return reader.getEntryCount();
    }

    async backup(outputPath: string): Promise<number> {
        try {
            const table: Table = await this.ensureTable();
            const schema: Schema = await table.schema();
            const columns: string[] = schema.fields
                .map((field: Field) => field.name)
                .filter((name: string) => name !== 'vector');

            const writeStream: WriteStream = createWriteStream(outputPath, { encoding: 'utf8' });
            const completionPromise: Promise<void> = new Promise<void>((resolve, reject) => {
                writeStream.once('finish', resolve);
                writeStream.once('error', reject);
            });

            const rootElement: XMLElement = new XMLElement('backup');
            rootElement.setAttribute(new XMLAttribute('name', this.name));
            rootElement.setAttribute(new XMLAttribute('model', this.modelName));
            rootElement.setAttribute(new XMLAttribute('date', new Date().toISOString()));

            writeStream.write('<?xml version="1.0" encoding="UTF-8"?>\n');
            writeStream.write(rootElement.getHead() + '\n');

            let entryCount: number = 0;
            for await (const batch of table.query().select(columns)) {
                for (const row of batch) {
                    const entry: LangEntry = this.hydrateEntry(row as unknown as Record<string, unknown>);
                    writeStream.write(this.buildBackupEntryElement(entry).toString() + '\n');
                    entryCount++;
                }
            }

            writeStream.write(rootElement.getTail() + '\n');
            writeStream.end();
            await completionPromise;
            return entryCount;
        } catch (err: unknown) {
            console.error('Error creating backup:', err);
            throw err;
        }
    }

    private buildBackupEntryElement(entry: LangEntry): XMLElement {
        const entryElement: XMLElement = new XMLElement('entry');
        entryElement.setAttribute(new XMLAttribute('id', entry.id));
        entryElement.setAttribute(new XMLAttribute('language', entry.language));
        entryElement.setAttribute(new XMLAttribute('fileId', entry.fileId));
        entryElement.setAttribute(new XMLAttribute('original', entry.original));
        entryElement.setAttribute(new XMLAttribute('unitId', entry.unitId));
        entryElement.setAttribute(new XMLAttribute('segmentIndex', entry.segmentIndex.toString()));
        entryElement.setAttribute(new XMLAttribute('segmentCount', entry.segmentCount.toString()));

        const pureTextElement: XMLElement = new XMLElement('pureText');
        pureTextElement.addString(entry.pureText);
        entryElement.addElement(pureTextElement);

        const elementWrapper: XMLElement = new XMLElement('element');
        elementWrapper.addElement(Utils.buildXMLElement(entry.element));
        entryElement.addElement(elementWrapper);

        const metadataElement: XMLElement | undefined = this.buildBackupMetadataElement(entry.metadata);
        if (metadataElement) {
            entryElement.addElement(metadataElement);
        }

        return entryElement;
    }

    private buildBackupMetadataElement(metadata: EntryMetadata | undefined): XMLElement | undefined {
        if (!metadata || Object.keys(metadata).length === 0) {
            return undefined;
        }

        const metadataElement: XMLElement = new XMLElement('metadata');
        this.appendTextElement(metadataElement, 'state', metadata.state);
        this.appendTextElement(metadataElement, 'subState', metadata.subState);
        this.appendTextElement(metadataElement, 'quality', typeof metadata.quality === 'number' ? metadata.quality.toString() : undefined);
        this.appendTextElement(metadataElement, 'creationDate', metadata.creationDate);
        this.appendTextElement(metadataElement, 'creationId', metadata.creationId);
        this.appendTextElement(metadataElement, 'changeDate', metadata.changeDate);
        this.appendTextElement(metadataElement, 'changeId', metadata.changeId);
        this.appendTextElement(metadataElement, 'creationTool', metadata.creationTool);
        this.appendTextElement(metadataElement, 'creationToolVersion', metadata.creationToolVersion);
        this.appendTextElement(metadataElement, 'context', metadata.context);
        this.appendTextElement(metadataElement, 'usageCount', typeof metadata.usageCount === 'number' ? metadata.usageCount.toString() : undefined);
        this.appendTextElement(metadataElement, 'lastUsageDate', metadata.lastUsageDate);

        if (metadata.notes && metadata.notes.length > 0) {
            const notesElement: XMLElement = new XMLElement('notes');
            metadata.notes.forEach((note: string) => {
                const noteElement: XMLElement = new XMLElement('note');
                noteElement.addString(note);
                notesElement.addElement(noteElement);
            });
            metadataElement.addElement(notesElement);
        }

        if (metadata.properties && Object.keys(metadata.properties).length > 0) {
            const propertiesElement: XMLElement = new XMLElement('properties');
            Object.entries(metadata.properties).forEach(([key, value]: [string, string]) => {
                const propertyElement: XMLElement = new XMLElement('property');
                propertyElement.setAttribute(new XMLAttribute('name', key));
                propertyElement.addString(value);
                propertiesElement.addElement(propertyElement);
            });
            metadataElement.addElement(propertiesElement);
        }

        if (metadata.segment) {
            const segment: SegmentMetadata = metadata.segment;
            const segmentElement: XMLElement = new XMLElement('segment');
            if (segment.provider) {
                segmentElement.setAttribute(new XMLAttribute('provider', segment.provider));
            }
            if (segment.fileHash) {
                segmentElement.setAttribute(new XMLAttribute('fileHash', segment.fileHash));
            }
            if (segment.fileId) {
                segmentElement.setAttribute(new XMLAttribute('fileId', segment.fileId));
            }
            if (segment.unitId) {
                segmentElement.setAttribute(new XMLAttribute('unitId', segment.unitId));
            }
            if (segment.segmentId) {
                segmentElement.setAttribute(new XMLAttribute('segmentId', segment.segmentId));
            }
            if (segment.segmentKey) {
                segmentElement.setAttribute(new XMLAttribute('segmentKey', segment.segmentKey));
            }
            if (typeof segment.segmentIndex === 'number') {
                segmentElement.setAttribute(new XMLAttribute('segmentIndex', segment.segmentIndex.toString()));
            }
            if (typeof segment.segmentCount === 'number') {
                segmentElement.setAttribute(new XMLAttribute('segmentCount', segment.segmentCount.toString()));
            }
            metadataElement.addElement(segmentElement);
        }

        return metadataElement;
    }

    private appendTextElement(parent: XMLElement, name: string, value: string | undefined): void {
        if (!value) {
            return;
        }
        const child: XMLElement = new XMLElement(name);
        child.addString(value);
        parent.addElement(child);
    }
}