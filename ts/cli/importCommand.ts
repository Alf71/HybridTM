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

import { extname } from "node:path";
import { HybridTM, HybridTMFactory, ImportOptions, TranslationState } from '../index.js';
import { CliUtils } from './cliUtils.js';

export type ImportType = 'xliff' | 'tmx' | 'sdltm';

export class ImportCommand {

    static usage(): void {
        console.log('Usage: hybridtm import -name <name> -file <path> [-type xliff|tmx|sdltm]');
        console.log('                        [-minState initial|translated|reviewed|final]');
        console.log('                        [-keepEmpty] [-noMetadata]');
        console.log();
        console.log('  -name             Instance to import into (required)');
        console.log('  -file             File to import (required)');
        console.log('  -type             Import format; inferred from the file extension when omitted');
        console.log('  -minState         Minimum segment state to import (default: translated)');
        console.log('  -keepEmpty        Import segments with an empty target (default: skipped)');
        console.log('  -noMetadata       Skip extracting notes/metadata/extension attributes');
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            ImportCommand.usage();
            return;
        }

        const name: string | undefined = CliUtils.getFlag(args, '-name');
        const rawFile: string | undefined = CliUtils.getFlag(args, '-file');
        if (!name || !rawFile) {
            ImportCommand.usage();
            CliUtils.fail('Missing required -name or -file.');
        }

        const filePath: string = CliUtils.requireExistingFile(rawFile, 'Import file');
        const options: ImportOptions = ImportCommand.buildImportOptions(args);

        const tm: HybridTM | undefined = HybridTMFactory.getInstance(name);
        if (!tm) {
            CliUtils.fail('No instance named "' + name + '". Run "hybridtm create" or "hybridtm list" first.');
        }

        try {
            const type: ImportType = ImportCommand.resolveImportType(CliUtils.getFlag(args, '-type'), filePath);
            const count: number = await ImportCommand.importFile(tm, filePath, type, options);
            console.log('Imported ' + count + ' entries from ' + filePath + ' into "' + name + '".');
        } catch (error: unknown) {
            CliUtils.fail(error instanceof Error ? error.message : String(error));
        } finally {
            await tm.close();
        }
    }

    static async importFile(tm: HybridTM, filePath: string, type: ImportType, options: ImportOptions): Promise<number> {
        switch (type) {
            case 'xliff':
                return await tm.importXLIFF(filePath, options);
            case 'tmx':
                return await tm.importTMX(filePath, options);
            case 'sdltm':
                return await tm.importSDLTM(filePath, options);
        }
    }

    static resolveImportType(explicit: string | undefined, filePath: string): ImportType {
        if (explicit === 'xliff' || explicit === 'tmx' || explicit === 'sdltm') {
            return explicit;
        }
        if (explicit !== undefined) {
            throw new Error('Unknown import type "' + explicit + '". Expected xliff, tmx, or sdltm.');
        }
        const ext: string = extname(filePath).toLowerCase();
        if (ext === '.xlf' || ext === '.xliff') {
            return 'xliff';
        }
        if (ext === '.tmx') {
            return 'tmx';
        }
        if (ext === '.sdltm') {
            return 'sdltm';
        }
        throw new Error('Could not infer import type from "' + filePath + '". Pass an explicit type.');
    }

    static isTranslationState(value: string): value is TranslationState {
        return value === 'initial' || value === 'translated' || value === 'reviewed' || value === 'final';
    }

    private static buildImportOptions(args: string[]): ImportOptions {
        const options: ImportOptions = {
            skipEmpty: !CliUtils.hasFlag(args, '-keepEmpty'),
            extractMetadata: !CliUtils.hasFlag(args, '-noMetadata')
        };
        const minState: string | undefined = CliUtils.getFlag(args, '-minState');
        if (minState !== undefined) {
            if (!ImportCommand.isTranslationState(minState)) {
                CliUtils.fail('Unknown -minState value "' + minState + '". Expected initial, translated, reviewed, or final.');
            }
            options.minState = minState;
        }
        return options;
    }
}
