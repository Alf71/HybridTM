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

import { tmpdir } from "node:os";
import { join } from 'node:path';
import { SAXParser } from "typesxml";
import { BackupHandler } from './backupHandler.js';

export class BackupReader {

    parser: SAXParser;
    filePath: string;
    handler: BackupHandler;
    jsonlTempPath: string;

    constructor(filePath: string) {
        this.filePath = filePath;

        const tempDir = tmpdir();
        const tempFileName = 'backup_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.jsonl';
        this.jsonlTempPath = join(tempDir, tempFileName);

        this.parser = new SAXParser();
        this.handler = new BackupHandler(this.jsonlTempPath);
        this.parser.setContentHandler(this.handler);
    }

    async parse(): Promise<void> {
        try {
            this.parser.parseFile(this.filePath);
            await this.handler.waitForCompletion();
        } catch (error: unknown) {
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    getTempFilePath(): string {
        return this.jsonlTempPath;
    }

    getEntryCount(): number {
        return this.handler.getEntryCount();
    }

    getBackupName(): string {
        return this.handler.getBackupName();
    }

    getBackupModel(): string {
        return this.handler.getBackupModel();
    }

    getBackupDate(): string {
        return this.handler.getBackupDate();
    }
}
