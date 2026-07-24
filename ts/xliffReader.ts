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

import { tmpdir } from "node:os";
import { join } from 'node:path';
import { XliffDocument, XliffParser } from "typesxliff";
import { DEFAULT_IMPORT_OPTIONS, ImportOptions, ResolvedImportOptions, resolveImportOptions } from './importOptions.js';
import { XLIFFHandler } from './xliffHandler.js';

export class XLIFFReader {

    filePath: string;
    tempFilePath: string;
    handler: XLIFFHandler;
    private readonly options: ResolvedImportOptions;

    constructor(filePath: string, options: ImportOptions = DEFAULT_IMPORT_OPTIONS) {
        this.filePath = filePath;
        this.options = resolveImportOptions(options);

        // Generate temp file path
        const tempDir = tmpdir();
        const tempFileName = 'xliff_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.jsonl';
        this.tempFilePath = join(tempDir, tempFileName);

        this.handler = new XLIFFHandler(this.tempFilePath, this.options);
    }

    async parse(): Promise<void> {
        try {
            const parser: XliffParser = new XliffParser();
            parser.parseFile(this.filePath);
            const document: XliffDocument | undefined = parser.getXliffDocument();
            if (!document) {
                throw new Error('Unable to parse XLIFF document');
            }
            if (!document.getTrgLang()) {
                throw new Error('Missing @trgLang attribute in <xliff>');
            }
            this.handler.process(document);
            await this.handler.waitForCompletion();
        } catch (error: unknown) {
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    getTempFilePath(): string {
        return this.tempFilePath;
    }

    getEntryCount(): number {
        return this.handler.getEntryCount();
    }
}
