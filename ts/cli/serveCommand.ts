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

import { ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliUtils } from './cliUtils.js';

const DEFAULT_PORT: number = 8050;
const LOCALHOST: string = '127.0.0.1';
const ALL_INTERFACES: string = '0.0.0.0';

export function usage(): void {
    console.log('Usage: hybridtm serve [-port <number>] [-network]');
    console.log();
    console.log('  Starts the HybridTM HTTP server.');
    console.log();
    console.log('  -port      Port to listen on (default: ' + DEFAULT_PORT + ')');
    console.log('  -network   Accept connections from other machines on the network');
    console.log('             (default: only this machine). The server has no');
    console.log('             authentication, so only use this on a trusted network.');
}

export async function runServeCommand(args: string[]): Promise<void> {
    if (CliUtils.hasFlag(args, '-help')) {
        usage();
        return;
    }
    const port: number = CliUtils.parseIntFlag(args, '-port', DEFAULT_PORT, 1, 65535);
    const host: string = CliUtils.hasFlag(args, '-network') ? ALL_INTERFACES : LOCALHOST;
    const serverPath: string = fileURLToPath(new URL('../server/hybridtmServerMain.js', import.meta.url));
    const child: ChildProcess = spawn(process.execPath, [serverPath, String(port), host], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    console.log('HybridTM server starting on ' + host + ':' + port);
}
