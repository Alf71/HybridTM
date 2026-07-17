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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HybridTM } from '../hybridtm.js';

export class CliUtils {

    static getFlag(args: string[], flag: string): string | undefined {
        const index: number = args.indexOf(flag);
        if (index !== -1 && index + 1 < args.length) {
            return args[index + 1];
        }
        return undefined;
    }

    static hasFlag(args: string[], flag: string): boolean {
        return args.includes(flag);
    }

    static resolvePath(rawPath: string): string {
        let expanded: string = rawPath;
        if (expanded.startsWith('~')) {
            const home: string = homedir();
            if (expanded === '~') {
                expanded = home;
            } else if (expanded.startsWith('~/')) {
                expanded = join(home, expanded.slice(2));
            }
        }
        return resolve(expanded);
    }

    static requireExistingFile(rawPath: string, label: string): string {
        const resolved: string = CliUtils.resolvePath(rawPath);
        if (!existsSync(resolved)) {
            console.error(label + ' "' + resolved + '" does not exist.');
            process.exit(1);
        }
        return resolved;
    }

    static resolveModelName(alias: string | undefined): string {
        switch (alias) {
            case 'speed':
                return HybridTM.SPEED_MODEL;
            case 'resource':
                return HybridTM.RESOURCE_MODEL;
            case 'quality':
            case undefined:
                return HybridTM.QUALITY_MODEL;
            default:
                console.error('Unknown -model value "' + alias + '". Expected speed, quality, or resource.');
                process.exit(1);
        }
    }

    static fail(message: string): never {
        console.error(message);
        process.exit(1);
    }
}
