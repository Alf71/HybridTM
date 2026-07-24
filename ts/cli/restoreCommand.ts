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

import { existsSync, unlinkSync } from "node:fs";
import { BackupReader, HybridTM, HybridTMFactory } from '../index.js';
import { CliUtils } from './cliUtils.js';

interface RestoreTarget {
    tm: HybridTM;
    name: string;
}

export class RestoreCommand {

    static usage(): void {
        console.log('Usage: hybridtm restore -file <path> -name <name>');
        console.log('       hybridtm restore -file <path> -create -path <dir> [-name <name>] [-model compact|standard|large|<model id>]');
        console.log();
        console.log('  -file     Backup XML file to restore (required)');
        console.log('  -name     Existing instance to restore into, appending its entries. With');
        console.log('            -create, the name for the new instance (default: the name');
        console.log('            recorded in the backup file)');
        console.log('  -create   Create a fresh instance before restoring, instead of appending');
        console.log('            to an existing one');
        console.log('  -path     Directory for the new instance\'s LanceDB data (required with -create)');
        console.log('  -model    Embedding model for the new instance (default: the model recorded');
        console.log('            in the backup file)');
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            RestoreCommand.usage();
            return;
        }

        const rawFile: string | undefined = CliUtils.getFlag(args, '-file');
        if (!rawFile) {
            RestoreCommand.usage();
            CliUtils.fail('Missing required -file.');
        }
        const filePath: string = CliUtils.requireExistingFile(rawFile, 'Backup file');

        const target: RestoreTarget = CliUtils.hasFlag(args, '-create')
            ? await RestoreCommand.createTargetInstance(args, filePath)
            : RestoreCommand.getExistingTargetInstance(args);

        try {
            const count: number = await target.tm.restore(filePath);
            console.log('Restored ' + count + ' entries from ' + filePath + ' into "' + target.name + '".');
        } catch (error: unknown) {
            CliUtils.fail(error instanceof Error ? error.message : String(error));
        } finally {
            await target.tm.close();
        }
    }

    private static getExistingTargetInstance(args: string[]): RestoreTarget {
        const name: string | undefined = CliUtils.getFlag(args, '-name');
        if (!name) {
            RestoreCommand.usage();
            CliUtils.fail('Missing required -name (or pass -create to make a new instance).');
        }
        const tm: HybridTM | undefined = HybridTMFactory.getInstance(name);
        if (!tm) {
            CliUtils.fail('No instance named "' + name + '". Run "hybridtm create" or "hybridtm list" first.');
        }
        return { tm, name };
    }

    private static async createTargetInstance(args: string[], filePath: string): Promise<RestoreTarget> {
        const rawPath: string | undefined = CliUtils.getFlag(args, '-path');
        if (!rawPath) {
            RestoreCommand.usage();
            CliUtils.fail('Missing required -path when using -create.');
        }
        const resolvedPath: string = CliUtils.resolvePath(rawPath);

        let name: string | undefined = CliUtils.getFlag(args, '-name');
        const modelAlias: string | undefined = CliUtils.getFlag(args, '-model');
        let modelName: string | undefined = modelAlias ? CliUtils.resolveModelName(modelAlias) : undefined;

        if (!name || !modelName) {
            const header: { name: string; model: string } = await RestoreCommand.peekBackupHeader(filePath);
            name = name || header.name || undefined;
            modelName = modelName || header.model || undefined;
        }
        if (!name) {
            CliUtils.fail('Could not determine an instance name; pass -name or restore from a backup file with a recorded name.');
        }
        if (!modelName) {
            CliUtils.fail('Could not determine an embedding model; pass -model or restore from a backup file with a recorded model.');
        }

        const tm: HybridTM = HybridTMFactory.createInstance(name, resolvedPath, modelName);
        return { tm, name };
    }

    private static async peekBackupHeader(filePath: string): Promise<{ name: string; model: string }> {
        const reader: BackupReader = new BackupReader(filePath);
        await reader.parse();
        if (existsSync(reader.getTempFilePath())) {
            unlinkSync(reader.getTempFilePath());
        }
        return { name: reader.getBackupName(), model: reader.getBackupModel() };
    }
}
