/*******************************************************************************
 * Copyright (c) 2025-2026 Maxprograms.
 *
 * This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * https://www.eclipse.org/org/documents/epl-v10.html
 *
 * Contributors:
 *     Maxprograms - initial API and implementation
 *******************************************************************************/

import { createWriteStream, WriteStream } from "node:fs";
import { Catalog, ContentHandler, Grammar, XMLAttribute, XMLElement } from "typesxml";
import { EntryMetadata, SegmentMetadata } from './langEntry.js';
import { TranslationState } from './importOptions.js';

export class BackupHandler implements ContentHandler {

    private writeStream: WriteStream;
    private readonly completionPromise: Promise<void>;
    private entryCount: number = 0;

    private name: string = '';
    private model: string = '';
    private date: string = '';

    private inEntry: boolean = false;
    private stack: Array<XMLElement> = [];
    private entryChildren: Array<XMLElement> = [];
    private entryLanguage: string = '';
    private entryFileId: string = '';
    private entryOriginal: string = '';
    private entryUnitId: string = '';
    private entrySegmentIndex: number = 0;
    private entrySegmentCount: number = 1;

    constructor(tempFilePath: string) {
        this.writeStream = createWriteStream(tempFilePath, { encoding: 'utf8' });
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this.writeStream.once('finish', resolve);
            this.writeStream.once('error', reject);
        });
    }

    getEntryCount(): number {
        return this.entryCount;
    }

    waitForCompletion(): Promise<void> {
        return this.completionPromise;
    }

    getBackupName(): string {
        return this.name;
    }

    getBackupModel(): string {
        return this.model;
    }

    getBackupDate(): string {
        return this.date;
    }

    setGrammar(grammar: Grammar | undefined): void {
        // do nothing
    }

    getGrammar(): Grammar | undefined {
        return undefined;
    }

    initialize(): void {
        this.stack = [];
        this.entryChildren = [];
        this.inEntry = false;
    }

    setCatalog(catalog: Catalog): void {
        // do nothing
    }

    startDocument(): void {
        // do nothing
    }

    endDocument(): void {
        this.writeStream.end();
    }

    xmlDeclaration(version: string, encoding: string, standalone: string | undefined): void {
        // do nothing
    }

    startElement(name: string, atts: Array<XMLAttribute>): void {
        if ('backup' === name) {
            const element: XMLElement = new XMLElement(name);
            atts.forEach((att: XMLAttribute) => element.setAttribute(att));
            this.name = element.getAttribute('name')?.getValue() ?? '';
            this.model = element.getAttribute('model')?.getValue() ?? '';
            this.date = element.getAttribute('date')?.getValue() ?? '';
            return;
        }
        if ('entry' === name) {
            const element: XMLElement = new XMLElement(name);
            atts.forEach((att: XMLAttribute) => element.setAttribute(att));
            this.inEntry = true;
            this.stack = [];
            this.entryChildren = [];
            this.entryLanguage = element.getAttribute('language')?.getValue() ?? '';
            this.entryFileId = element.getAttribute('fileId')?.getValue() ?? '';
            this.entryOriginal = element.getAttribute('original')?.getValue() ?? '';
            this.entryUnitId = element.getAttribute('unitId')?.getValue() ?? '';
            this.entrySegmentIndex = this.parseNumber(element.getAttribute('segmentIndex')?.getValue(), 0);
            this.entrySegmentCount = this.parseNumber(element.getAttribute('segmentCount')?.getValue(), 1);
            return;
        }
        if (!this.inEntry) {
            return;
        }
        const element: XMLElement = new XMLElement(name);
        atts.forEach((att: XMLAttribute) => element.setAttribute(att));
        if (this.stack.length > 0) {
            this.stack[this.stack.length - 1].addElement(element);
        }
        this.stack.push(element);
    }

    endElement(name: string): void {
        if ('backup' === name) {
            return;
        }
        if ('entry' === name) {
            this.emitEntry();
            this.inEntry = false;
            this.stack = [];
            this.entryChildren = [];
            return;
        }
        if (!this.inEntry) {
            return;
        }
        const finished: XMLElement | undefined = this.stack.pop();
        if (finished && this.stack.length === 0) {
            this.entryChildren.push(finished);
        }
    }

    internalSubset(declaration: string): void {
        // do nothing
    }

    characters(ch: string): void {
        if (!this.inEntry || this.stack.length === 0) {
            return;
        }
        this.stack[this.stack.length - 1].addString(ch);
    }

    ignorableWhitespace(ch: string): void {
        this.characters(ch);
    }

    comment(ch: string): void {
        // do nothing
    }

    processingInstruction(target: string, data: string): void {
        // do nothing
    }

    startCDATA(): void {
        // do nothing
    }

    endCDATA(): void {
        // do nothing
    }

    startDTD(name: string, publicId: string, systemId: string): void {
        // do nothing
    }

    endDTD(): void {
        // do nothing
    }

    skippedEntity(name: string): void {
        // do nothing
    }

    getCurrentText(): string {
        return '';
    }

    private emitEntry(): void {
        const pureTextElement: XMLElement | undefined = this.entryChildren.find((child: XMLElement) => child.getName() === 'pureText');
        const elementWrapper: XMLElement | undefined = this.entryChildren.find((child: XMLElement) => child.getName() === 'element');
        const metadataElement: XMLElement | undefined = this.entryChildren.find((child: XMLElement) => child.getName() === 'metadata');
        if (!pureTextElement || !elementWrapper) {
            return;
        }
        const innerElements: Array<XMLElement> = elementWrapper.getChildren();
        if (innerElements.length === 0) {
            return;
        }

        const jsonEntry: Record<string, unknown> = {
            language: this.entryLanguage,
            fileId: this.entryFileId,
            original: this.entryOriginal,
            unitId: this.entryUnitId,
            pureText: pureTextElement.getText(),
            element: innerElements[0].toString(),
            segmentIndex: this.entrySegmentIndex,
            segmentCount: this.entrySegmentCount
        };

        if (metadataElement) {
            const metadata: EntryMetadata = this.parseMetadataElement(metadataElement);
            if (Object.keys(metadata).length > 0) {
                jsonEntry.metadata = metadata;
            }
        }

        this.writeStream.write(JSON.stringify(jsonEntry) + '\n');
        this.entryCount++;
    }

    private parseMetadataElement(metadataElement: XMLElement): EntryMetadata {
        const metadata: EntryMetadata = {};

        const childText = (childName: string): string | undefined => {
            const child: XMLElement | undefined = metadataElement.getChild(childName);
            if (!child) {
                return undefined;
            }
            const text: string = child.getText();
            return text.length > 0 ? text : undefined;
        };

        const state: string | undefined = childText('state');
        const validStates: string[] = ['initial', 'translated', 'reviewed', 'final'];
        if (state && validStates.includes(state)) {
            metadata.state = state as TranslationState;
        }
        const subState: string | undefined = childText('subState');
        if (subState) {
            metadata.subState = subState;
        }
        const quality: number | undefined = this.parseOptionalNumber(childText('quality'));
        if (quality !== undefined) {
            metadata.quality = quality;
        }
        const creationDate: string | undefined = childText('creationDate');
        if (creationDate) {
            metadata.creationDate = creationDate;
        }
        const creationId: string | undefined = childText('creationId');
        if (creationId) {
            metadata.creationId = creationId;
        }
        const changeDate: string | undefined = childText('changeDate');
        if (changeDate) {
            metadata.changeDate = changeDate;
        }
        const changeId: string | undefined = childText('changeId');
        if (changeId) {
            metadata.changeId = changeId;
        }
        const creationTool: string | undefined = childText('creationTool');
        if (creationTool) {
            metadata.creationTool = creationTool;
        }
        const creationToolVersion: string | undefined = childText('creationToolVersion');
        if (creationToolVersion) {
            metadata.creationToolVersion = creationToolVersion;
        }
        const context: string | undefined = childText('context');
        if (context) {
            metadata.context = context;
        }
        const usageCount: number | undefined = this.parseOptionalNumber(childText('usageCount'));
        if (usageCount !== undefined) {
            metadata.usageCount = usageCount;
        }
        const lastUsageDate: string | undefined = childText('lastUsageDate');
        if (lastUsageDate) {
            metadata.lastUsageDate = lastUsageDate;
        }

        const notesElement: XMLElement | undefined = metadataElement.getChild('notes');
        if (notesElement) {
            const notes: string[] = notesElement.getChildren()
                .filter((child: XMLElement) => child.getName() === 'note')
                .map((child: XMLElement) => child.getText())
                .filter((text: string) => text.length > 0);
            if (notes.length > 0) {
                metadata.notes = notes;
            }
        }

        const propertiesElement: XMLElement | undefined = metadataElement.getChild('properties');
        if (propertiesElement) {
            const properties: Record<string, string> = {};
            propertiesElement.getChildren().forEach((child: XMLElement) => {
                if (child.getName() === 'property') {
                    const key: string | undefined = child.getAttribute('name')?.getValue();
                    if (key && key.length > 0) {
                        properties[key] = child.getText();
                    }
                }
            });
            if (Object.keys(properties).length > 0) {
                metadata.properties = properties;
            }
        }

        const segmentElement: XMLElement | undefined = metadataElement.getChild('segment');
        if (segmentElement) {
            const segment: SegmentMetadata = this.parseSegmentElement(segmentElement);
            if (Object.keys(segment).length > 0) {
                metadata.segment = segment;
            }
        }

        return metadata;
    }

    private parseSegmentElement(segmentElement: XMLElement): SegmentMetadata {
        const segment: SegmentMetadata = {};
        const attr = (attrName: string): string | undefined => segmentElement.getAttribute(attrName)?.getValue();

        const provider: string | undefined = attr('provider');
        if (provider) {
            segment.provider = provider;
        }
        const fileHash: string | undefined = attr('fileHash');
        if (fileHash) {
            segment.fileHash = fileHash;
        }
        const fileId: string | undefined = attr('fileId');
        if (fileId) {
            segment.fileId = fileId;
        }
        const unitId: string | undefined = attr('unitId');
        if (unitId) {
            segment.unitId = unitId;
        }
        const segmentId: string | undefined = attr('segmentId');
        if (segmentId) {
            segment.segmentId = segmentId;
        }
        const segmentKey: string | undefined = attr('segmentKey');
        if (segmentKey) {
            segment.segmentKey = segmentKey;
        }
        const segmentIndex: number | undefined = this.parseOptionalNumber(attr('segmentIndex'));
        if (segmentIndex !== undefined) {
            segment.segmentIndex = segmentIndex;
        }
        const segmentCount: number | undefined = this.parseOptionalNumber(attr('segmentCount'));
        if (segmentCount !== undefined) {
            segment.segmentCount = segmentCount;
        }
        return segment;
    }

    private parseOptionalNumber(value: string | undefined): number | undefined {
        if (!value) {
            return undefined;
        }
        const parsed: number = Number(value);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    private parseNumber(value: string | undefined, fallback: number): number {
        const parsed: number | undefined = this.parseOptionalNumber(value);
        return parsed !== undefined ? parsed : fallback;
    }
}
