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

import { createWriteStream, WriteStream } from "node:fs";
import { XMLAttribute } from "typesxml";
import {
    XliffCp, XliffDocument, XliffEc, XliffEm, XliffFile, XliffGroup, XliffIgnorable,
    XliffMeta, XliffMetaGroup, XliffMrk, XliffPc, XliffPh, XliffSc, XliffSegment,
    XliffSm, XliffSource, XliffTarget, XliffUnit
} from "typesxliff";
import { DEFAULT_IMPORT_OPTIONS, ImportOptions, ResolvedImportOptions, resolveImportOptions, TranslationState } from './importOptions.js';
import { EntryMetadata } from './langEntry.js';
import { Utils } from './utils.js';

type InlineContent = string | XliffCp | XliffPh | XliffPc | XliffSc | XliffEc | XliffMrk | XliffSm | XliffEm;

interface SegmentData {
    segment: XliffSegment;
    source: XliffSource;
    target: XliffTarget;
    pureSource: string;
    pureTarget: string;
    metadata?: EntryMetadata;
    segmentId?: string;
}

interface HandlerEntry {
    language: string;
    fileId: string;
    unitId: string;
    original: string;
    pureText: string;
    element: string;
    segmentIndex: number;
    segmentCount: number;
    metadata?: EntryMetadata;
}

export class XLIFFHandler {

    private srcLang: string = '';
    private tgtLang: string = '';
    private readonly writeStream: WriteStream;
    private readonly completionPromise: Promise<void>;
    private entryCount: number = 0;
    private readonly options: ResolvedImportOptions;

    constructor(tempFilePath: string, options: ImportOptions = DEFAULT_IMPORT_OPTIONS) {
        this.writeStream = createWriteStream(tempFilePath, { encoding: 'utf8' });
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this.writeStream.once('finish', resolve);
            this.writeStream.once('error', reject);
        });
        this.options = resolveImportOptions(options);
    }

    getEntryCount(): number {
        return this.entryCount;
    }

    waitForCompletion(): Promise<void> {
        return this.completionPromise;
    }

    process(document: XliffDocument): void {
        const srcLang: string = document.getSrcLang();
        const normalizedSrc: string | undefined = Utils.normalizeLanguage(srcLang);
        if (!normalizedSrc) {
            throw new Error('Invalid @srcLang value "' + srcLang + '"');
        }
        this.srcLang = normalizedSrc;
        const tgtLang: string = document.getTrgLang() ?? '';
        const normalizedTgt: string | undefined = Utils.normalizeLanguage(tgtLang);
        if (!normalizedTgt) {
            throw new Error('Invalid @trgLang value "' + tgtLang + '"');
        }
        this.tgtLang = normalizedTgt;
        document.getFiles().forEach((file: XliffFile) => {
            const fileId: string = file.getId();
            const original: string = file.getOriginal() ?? '';
            this.collectUnits(file.getEntries()).forEach((unit: XliffUnit) => {
                this.processUnit(fileId, original, unit);
            });
        });
        this.writeStream.end();
    }

    private collectUnits(entries: Array<XliffUnit | XliffGroup>): Array<XliffUnit> {
        const units: Array<XliffUnit> = [];
        entries.forEach((entry: XliffUnit | XliffGroup) => {
            if (entry instanceof XliffGroup) {
                units.push(...this.collectUnits(entry.getEntries()));
            } else {
                units.push(entry);
            }
        });
        return units;
    }

    private processUnit(fileId: string, original: string, unit: XliffUnit): void {
        const unitId: string = unit.getId();
        const items: Array<XliffSegment | XliffIgnorable> = unit.getItems();
        const segmentItems: Array<XliffSegment> = items.filter(
            (item): item is XliffSegment => item instanceof XliffSegment
        );

        const segments: SegmentData[] = this.buildSegments(fileId, unitId, unit, segmentItems);

        if (segmentItems.length === 1) {
            // A unit with exactly one <segment> has no distinct "whole unit" content:
            // store one entry, framed as the unit entry, filtered/annotated using the
            // same criteria (state, skipEmpty, metadata) a segment
            // entry would use.
            if (segments.length === 1) {
                this.writeUnitEntry(fileId, original, unitId, items, segments[0].metadata, segments[0].segmentId);
            }
            return;
        }

        const segmentCount: number = segments.length;
        segments.forEach((segment: SegmentData, index: number) => {
            const segmentIndex: number = index + 1;
            this.writeSegmentEntries(fileId, original, unitId, segmentIndex, segmentCount, segment);
        });

        const surviving: Set<XliffSegment> = new Set(segments.map((segment: SegmentData) => segment.segment));
        const survivingItems: Array<XliffSegment | XliffIgnorable> = items.filter(
            (item: XliffSegment | XliffIgnorable) => !(item instanceof XliffSegment) || surviving.has(item)
        );
        this.writeUnitEntry(fileId, original, unitId, survivingItems);
    }

    private buildSegments(fileId: string, unitId: string, unit: XliffUnit, segmentItems: Array<XliffSegment>): SegmentData[] {
        const segments: SegmentData[] = [];
        segmentItems.forEach((segment: XliffSegment) => {
            const processed: SegmentData | null = this.buildSegmentData(fileId, unitId, unit, segment);
            if (processed) {
                segments.push(processed);
            }
        });
        return segments;
    }

    private buildSegmentData(fileId: string, unitId: string, unit: XliffUnit, segment: XliffSegment): SegmentData | null {
        const sourceElement: XliffSource | undefined = segment.getSource();
        const targetElement: XliffTarget | undefined = segment.getTarget();
        if (!sourceElement || !targetElement) {
            return null;
        }

        const pureSource: string = XLIFFHandler.getPureText(sourceElement.getContent());
        const pureTarget: string = XLIFFHandler.getPureText(targetElement.getContent());
        if (pureSource.trim().length === 0) {
            return null;
        }

        const rawState: string | undefined = segment.getState();
        if (rawState !== undefined && !this.isTranslationState(rawState)) {
            throw new Error('Invalid @state value "' + rawState + '" in unit "' + unitId + '"');
        }
        const state: TranslationState = rawState === undefined ? 'initial' : rawState;
        const stateRank: number = this.getStateRank(state);
        const minRank: number = this.getStateRank(this.options.minState);

        if (stateRank < minRank) {
            return null;
        }
        if (targetElement.getContent().length === 0 && state !== 'final') {
            return null;
        }

        const segmentId: string | undefined = segment.getId();
        const metadata: EntryMetadata | undefined = this.options.extractMetadata
            ? this.extractMetadata(fileId, unitId, unit, segment, state, segmentId)
            : undefined;

        return {
            segment,
            source: sourceElement,
            target: targetElement,
            pureSource,
            pureTarget,
            metadata,
            segmentId
        };
    }

    private writeSegmentEntries(fileId: string, original: string, unitId: string, segmentIndex: number, segmentCount: number, segment: SegmentData): void {
        const metadata: EntryMetadata | undefined = this.applySegmentPosition(
            segment.metadata,
            fileId,
            unitId,
            segment.segmentId,
            segmentIndex,
            segmentCount
        );

        this.writeEntry({
            language: this.srcLang,
            fileId,
            unitId,
            original,
            pureText: segment.pureSource,
            element: segment.source.toElement().toString(),
            segmentIndex,
            segmentCount,
            metadata
        });

        this.writeEntry({
            language: this.tgtLang,
            fileId,
            unitId,
            original,
            pureText: segment.pureTarget,
            element: segment.target.toElement().toString(),
            segmentIndex,
            segmentCount,
            metadata
        });
    }

    private applySegmentPosition(
        metadata: EntryMetadata | undefined,
        fileId: string,
        unitId: string,
        explicitSegmentId: string | undefined,
        segmentIndex: number,
        segmentCount: number
    ): EntryMetadata | undefined {
        if (!metadata) {
            return undefined;
        }

        if (!metadata.segment) {
            metadata.segment = {
                provider: 'xliff',
                fileId,
                unitId,
                segmentId: explicitSegmentId
            };
        } else {
            metadata.segment.provider = metadata.segment.provider || 'xliff';
            metadata.segment.fileId = metadata.segment.fileId || fileId;
            metadata.segment.unitId = metadata.segment.unitId || unitId;
            if (!metadata.segment.segmentId && explicitSegmentId) {
                metadata.segment.segmentId = explicitSegmentId;
            }
        }

        if (!metadata.segment.segmentId && segmentIndex > 0) {
            metadata.segment.segmentId = explicitSegmentId || segmentIndex.toString();
        }

        metadata.segment.segmentIndex = segmentIndex;
        metadata.segment.segmentCount = segmentCount;
        return metadata;
    }

    private writeUnitEntry(
        fileId: string,
        original: string,
        unitId: string,
        items: Array<XliffSegment | XliffIgnorable>,
        metadata?: EntryMetadata,
        segmentId?: string
    ): void {
        const mergedSource: XliffSource = this.mergeSource(items);
        const mergedTarget: XliffTarget = this.mergeTarget(items);

        const pureSource: string = XLIFFHandler.getPureText(mergedSource.getContent());
        const pureTarget: string = XLIFFHandler.getPureText(mergedTarget.getContent());
        if (pureSource.trim().length === 0) {
            return;
        }
        if (mergedTarget.getContent().length === 0) {
            return;
        }

        const segmentCount: number = items.filter((item) => item instanceof XliffSegment).length;
        const resolvedMetadata: EntryMetadata | undefined = this.applySegmentPosition(metadata, fileId, unitId, segmentId, 0, segmentCount);

        this.writeEntry({
            language: this.srcLang,
            fileId,
            unitId,
            original,
            pureText: pureSource,
            element: mergedSource.toElement().toString(),
            segmentIndex: 0,
            segmentCount,
            metadata: resolvedMetadata
        });

        this.writeEntry({
            language: this.tgtLang,
            fileId,
            unitId,
            original,
            pureText: pureTarget,
            element: mergedTarget.toElement().toString(),
            segmentIndex: 0,
            segmentCount,
            metadata: resolvedMetadata
        });
    }

    private mergeSource(items: Array<XliffSegment | XliffIgnorable>): XliffSource {
        const merged: XliffSource = new XliffSource();
        items.forEach((item: XliffSegment | XliffIgnorable) => {
            const source: XliffSource | undefined = item.getSource();
            if (source) {
                merged.getContent().push(...source.getContent());
            }
        });
        return merged;
    }

    private mergeTarget(items: Array<XliffSegment | XliffIgnorable>): XliffTarget {
        // @order re-sequences a target relative to the source when a unit is resegmented
        // differently on the target side; items without @order keep their document position.
        const ordered = items
            .map((item, index) => ({ item, position: item.getTarget()?.getOrder() ?? (index + 1) }))
            .filter((entry) => entry.item.getTarget() !== undefined)
            .sort((a, b) => Number(a.position) - Number(b.position));

        const merged: XliffTarget = new XliffTarget();
        ordered.forEach(({ item }) => {
            const target: XliffTarget | undefined = item.getTarget();
            if (target) {
                merged.getContent().push(...target.getContent());
            }
        });
        return merged;
    }

    private writeEntry(entry: HandlerEntry): void {
        const payload: Record<string, unknown> = {
            language: entry.language,
            fileId: entry.fileId,
            original: entry.original,
            unitId: entry.unitId,
            pureText: entry.pureText,
            element: entry.element,
            segmentIndex: entry.segmentIndex,
            segmentCount: entry.segmentCount
        };

        if (this.hasMetadata(entry.metadata)) {
            payload.metadata = entry.metadata;
        }

        this.writeStream.write(JSON.stringify(payload) + '\n');
        this.entryCount++;
    }

    private hasMetadata(metadata: EntryMetadata | undefined): boolean {
        return !!metadata && Object.keys(metadata).length > 0;
    }

    private extractMetadata(
        fileId: string,
        unitId: string,
        unit: XliffUnit,
        segment: XliffSegment,
        state: TranslationState | undefined,
        segmentId?: string
    ): EntryMetadata {
        const metadata: EntryMetadata = {};

        if (this.isTranslationState(state)) {
            metadata.state = state;
        }

        const subState: string | undefined = segment.getSubState();
        if (subState) {
            metadata.subState = subState;
        }

        const unitAttrs: Array<XMLAttribute> = unit.getOtherAttributes();
        const segmentAttrs: Array<XMLAttribute> = segment.getOtherAttributes();

        this.assignMetadataString(metadata, 'creationDate', this.readOtherAttribute(segmentAttrs, 'creationDate') || this.readOtherAttribute(unitAttrs, 'creationDate'));
        this.assignMetadataString(metadata, 'creationId', this.readOtherAttribute(segmentAttrs, 'creationId') || this.readOtherAttribute(unitAttrs, 'creationId'));
        this.assignMetadataString(metadata, 'changeDate', this.readOtherAttribute(segmentAttrs, 'changeDate') || this.readOtherAttribute(unitAttrs, 'changeDate'));
        this.assignMetadataString(metadata, 'changeId', this.readOtherAttribute(segmentAttrs, 'changeId') || this.readOtherAttribute(unitAttrs, 'changeId'));
        this.assignMetadataString(metadata, 'creationTool', this.readOtherAttribute(segmentAttrs, 'creationTool') || this.readOtherAttribute(unitAttrs, 'creationTool'));
        this.assignMetadataString(metadata, 'creationToolVersion', this.readOtherAttribute(segmentAttrs, 'creationToolVersion') || this.readOtherAttribute(unitAttrs, 'creationToolVersion'));
        this.assignMetadataString(metadata, 'context', this.readOtherAttribute(segmentAttrs, 'context') || this.readOtherAttribute(unitAttrs, 'context'));

        const notes: string[] = [];
        this.collectNotes(unit, notes);
        if (notes.length > 0) {
            metadata.notes = notes;
        }

        const properties: Record<string, string> = {};
        this.collectMetadataProperties(unit, properties);
        if (Object.keys(properties).length > 0) {
            metadata.properties = properties;
            if (!metadata.context) {
                const contextKey: string | undefined = Object.keys(properties).find((key: string) => key.toLowerCase().includes('context'));
                if (contextKey) {
                    metadata.context = properties[contextKey];
                }
            }
        }

        metadata.segment = {
            provider: 'xliff',
            fileId,
            unitId,
            segmentId
        };

        return metadata;
    }

    private assignMetadataString(metadata: EntryMetadata, key: keyof EntryMetadata, value: string | undefined): void {
        if (value && value.length > 0) {
            (metadata as Record<string, unknown>)[key as string] = value;
        }
    }

    private readOtherAttribute(otherAttributes: Array<XMLAttribute>, name: string): string | undefined {
        const attribute: XMLAttribute | undefined = otherAttributes.find((att: XMLAttribute) => att.getName() === name);
        if (!attribute) {
            return undefined;
        }
        const value: string = attribute.getValue();
        return value && value.length > 0 ? value : undefined;
    }

    private collectNotes(unit: XliffUnit, accumulator: string[]): void {
        const notes = unit.getNotes()?.getNotes() ?? [];
        notes.forEach((note) => {
            const value: string = note.getText().trim();
            if (value.length > 0) {
                accumulator.push(value);
            }
        });
    }

    private collectMetadataProperties(unit: XliffUnit, properties: Record<string, string>): void {
        const metaGroups: Array<XliffMetaGroup> = unit.getMetadata()?.getMetaGroups() ?? [];
        metaGroups.forEach((metaGroup: XliffMetaGroup) => this.collectFromMetaGroup(metaGroup, properties));
    }

    private collectFromMetaGroup(metaGroup: XliffMetaGroup, properties: Record<string, string>): void {
        const category: string | undefined = metaGroup.getCategory();
        metaGroup.getItems().forEach((item: XliffMetaGroup | XliffMeta) => {
            if (item instanceof XliffMeta) {
                const key: string = category ? category + ':' + item.getType() : item.getType();
                const content: string = item.getText().trim();
                if (key.length > 0 && content.length > 0) {
                    properties[key] = content;
                }
            } else {
                this.collectFromMetaGroup(item, properties);
            }
        });
    }

    private getStateRank(state: TranslationState): number {
        switch (state) {
            case 'initial':
                return 1;
            case 'translated':
                return 2;
            case 'reviewed':
                return 3;
            case 'final':
                return 4;
        }
    }

    private isTranslationState(value: string | undefined): value is TranslationState {
        return value === 'initial'
            || value === 'translated'
            || value === 'reviewed'
            || value === 'final';
    }

    private static getPureText(content: Array<InlineContent>): string {
        let text: string = '';
        content.forEach((item: InlineContent) => {
            if (typeof item === 'string') {
                text += item;
            } else if (item instanceof XliffPc || item instanceof XliffMrk) {
                text += XLIFFHandler.getPureText(item.getContent());
            }
            // ph, sc, ec, sm, em and cp purposely ignored, matching prior pure-text extraction
        });
        return text;
    }
}
