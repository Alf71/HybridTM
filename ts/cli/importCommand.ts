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

type ImportType = 'xliff' | 'tmx' | 'sdltm';

export function usage(): void {
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

export async function runImportCommand(args: string[]): Promise<void> {
    if (CliUtils.hasFlag(args, '-help')) {
        usage();
        return;
    }

    const name: string | undefined = CliUtils.getFlag(args, '-name');
    const rawFile: string | undefined = CliUtils.getFlag(args, '-file');
    if (!name || !rawFile) {
        usage();
        CliUtils.fail('Missing required -name or -file.');
    }

    const filePath: string = CliUtils.requireExistingFile(rawFile, 'Import file');
    const type: ImportType = resolveImportType(CliUtils.getFlag(args, '-type'), filePath);
    const options: ImportOptions = buildImportOptions(args);

    const tm: HybridTM | undefined = HybridTMFactory.getInstance(name);
    if (!tm) {
        CliUtils.fail('No instance named "' + name + '". Run "hybridtm create" or "hybridtm list" first.');
    }

    try {
        let count: number;
        switch (type) {
            case 'xliff':
                count = await tm.importXLIFF(filePath, options);
                break;
            case 'tmx':
                count = await tm.importTMX(filePath, options);
                break;
            case 'sdltm':
                count = await tm.importSDLTM(filePath, options);
                break;
        }
        console.log('Imported ' + count + ' entries from ' + filePath + ' into "' + name + '".');
    } catch (error: unknown) {
        CliUtils.fail(error instanceof Error ? error.message : String(error));
    } finally {
        await tm.close();
    }
}

function resolveImportType(explicit: string | undefined, filePath: string): ImportType {
    if (explicit === 'xliff' || explicit === 'tmx' || explicit === 'sdltm') {
        return explicit;
    }
    if (explicit !== undefined) {
        CliUtils.fail('Unknown -type value "' + explicit + '". Expected xliff, tmx, or sdltm.');
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
    CliUtils.fail('Could not infer import type from "' + filePath + '". Pass -type explicitly.');
}

function buildImportOptions(args: string[]): ImportOptions {
    const options: ImportOptions = {
        skipEmpty: !CliUtils.hasFlag(args, '-keepEmpty'),
        extractMetadata: !CliUtils.hasFlag(args, '-noMetadata')
    };
    const minState: string | undefined = CliUtils.getFlag(args, '-minState');
    if (minState !== undefined) {
        if (!isTranslationState(minState)) {
            CliUtils.fail('Unknown -minState value "' + minState + '". Expected initial, translated, reviewed, or final.');
        }
        options.minState = minState;
    }
    return options;
}

function isTranslationState(value: string): value is TranslationState {
    return value === 'initial' || value === 'translated' || value === 'reviewed' || value === 'final';
}
