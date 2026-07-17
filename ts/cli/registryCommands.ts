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

import { createInterface, Interface } from 'node:readline/promises';
import { HybridTMFactory, HybridTMInstanceMetadata } from '../index.js';
import { CliUtils } from './cliUtils.js';

export function listUsage(): void {
    console.log('Usage: hybridtm list');
}

export async function runListCommand(args: string[]): Promise<void> {
    if (CliUtils.hasFlag(args, '-help')) {
        listUsage();
        return;
    }
    const instances: HybridTMInstanceMetadata[] = HybridTMFactory.listInstances();
    if (instances.length === 0) {
        console.log('No instances registered. Run "hybridtm create" to make one.');
        return;
    }
    instances.forEach((instance: HybridTMInstanceMetadata) => {
        console.log(instance.name + '\t' + instance.filePath + '\t' + instance.modelName + '\t' + instance.createdAt);
    });
}

export function removeUsage(): void {
    console.log('Usage: hybridtm remove -name <name> [-force]');
    console.log();
    console.log('  -name   Instance to remove (required)');
    console.log('  -force  Skip the interactive confirmation prompt (for scripts/automation)');
}

export async function runRemoveCommand(args: string[]): Promise<void> {
    if (CliUtils.hasFlag(args, '-help')) {
        removeUsage();
        return;
    }
    const name: string | undefined = CliUtils.getFlag(args, '-name');
    if (!name) {
        removeUsage();
        CliUtils.fail('Missing required -name.');
    }

    const instances: HybridTMInstanceMetadata[] = HybridTMFactory.listInstances();
    const metadata: HybridTMInstanceMetadata | undefined = instances.find((instance: HybridTMInstanceMetadata) => instance.name === name);
    if (!metadata) {
        const hint: string = instances.length > 0
            ? ' Registered instances: ' + instances.map((instance: HybridTMInstanceMetadata) => '"' + instance.name + '"').join(', ') + '.'
            : ' No instances are registered yet.';
        CliUtils.fail('No instance named "' + name + '".' + hint);
    }

    if (!CliUtils.hasFlag(args, '-force')) {
        console.log('About to permanently delete instance "' + name + '" at ' + metadata.filePath + ' (model: ' + metadata.modelName + ').');
        console.log('This cannot be undone.');
        const confirmed: boolean = await confirm('Type "yes" to confirm: ');
        if (!confirmed) {
            console.log('Aborted; no changes made.');
            return;
        }
    }

    try {
        HybridTMFactory.removeInstance(name);
        console.log('Removed instance "' + name + '".');
    } catch (error: unknown) {
        CliUtils.fail(error instanceof Error ? error.message : String(error));
    }
}

async function confirm(promptText: string): Promise<boolean> {
    const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer: string = await rl.question(promptText);
        return answer.trim().toLowerCase() === 'yes';
    } finally {
        rl.close();
    }
}
