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

import { HybridTM, HybridTMFactory } from '../index.js';
import { CliUtils } from './cliUtils.js';

export class BackupCommand {

    static usage(): void {
        console.log('Usage: hybridtm backup -name <name> -file <path>');
        console.log();
        console.log('  -name   Instance to back up (required)');
        console.log('  -file   Output XML file path (required)');
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            BackupCommand.usage();
            return;
        }

        const name: string | undefined = CliUtils.getFlag(args, '-name');
        const rawFile: string | undefined = CliUtils.getFlag(args, '-file');
        if (!name || !rawFile) {
            BackupCommand.usage();
            CliUtils.fail('Missing required -name or -file.');
        }

        const outputPath: string = CliUtils.resolvePath(rawFile);

        const tm: HybridTM | undefined = HybridTMFactory.getInstance(name);
        if (!tm) {
            CliUtils.fail('No instance named "' + name + '". Run "hybridtm create" or "hybridtm list" first.');
        }

        try {
            const count: number = await tm.backup(outputPath);
            console.log('Backed up ' + count + ' entries from "' + name + '" to ' + outputPath + '.');
        } catch (error: unknown) {
            CliUtils.fail(error instanceof Error ? error.message : String(error));
        } finally {
            await tm.close();
        }
    }
}
