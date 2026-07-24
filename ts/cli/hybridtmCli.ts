#!/usr/bin/env node
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

import { BackupCommand } from './backupCommand.js';
import { CreateCommand } from './createCommand.js';
import { ImportCommand } from './importCommand.js';
import { MatchCommand } from './matchCommand.js';
import { RegistryCommands } from './registryCommands.js';
import { RestoreCommand } from './restoreCommand.js';
import { ServeCommand } from './serveCommand.js';
import { StopCommand } from './stopCommand.js';

class HybridTMCli {

    constructor() {
        this.run(process.argv.slice(2));
    }

    private async run(argv: string[]): Promise<void> {
        const command: string | undefined = argv[0];
        const rest: string[] = argv.slice(1);
        try {
            if (command === 'create') {
                await CreateCommand.run(rest);
            } else if (command === 'import') {
                await ImportCommand.run(rest);
            } else if (command === 'match') {
                await MatchCommand.run(rest);
            } else if (command === 'backup') {
                await BackupCommand.run(rest);
            } else if (command === 'restore') {
                await RestoreCommand.run(rest);
            } else if (command === 'list') {
                await RegistryCommands.runList(rest);
            } else if (command === 'remove') {
                await RegistryCommands.runRemove(rest);
            } else if (command === 'serve') {
                await ServeCommand.run(rest);
            } else if (command === 'stop') {
                await StopCommand.run(rest);
            } else if (command === '-help' || command === '--help') {
                this.usage();
                process.exit(0);
            } else if (command === undefined) {
                this.usage();
                process.exit(1);
            } else {
                console.error('Unknown command "' + command + '".');
                this.usage();
                process.exit(1);
            }
        } catch (error: unknown) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    }

    private usage(): void {
        console.log('Usage: hybridtm <command> [options]');
        console.log();
        console.log('Commands:');
        console.log('  create    Create a new named TM instance');
        console.log('  import    Import an XLIFF/TMX/SDLTM file into an instance');
        console.log('  match     Enrich an XLIFF file with TM match candidates');
        console.log('  backup    Export an instance to a format-agnostic backup XML file');
        console.log('  restore   Reimport a backup XML file into an existing or new instance');
        console.log('  list      List registered instances');
        console.log('  remove    Delete a registered instance and its data');
        console.log('  serve     Start the HybridTM HTTP server');
        console.log('  stop      Stop the HybridTM HTTP server');
        console.log();
        console.log('Run "hybridtm <command> -help" for command-specific options.');
    }
}

new HybridTMCli();
