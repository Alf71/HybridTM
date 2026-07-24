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

import { ChildProcess, spawn } from "node:child_process";
import { IncomingMessage, request } from "node:http";
import { fileURLToPath } from "node:url";
import { CliUtils } from './cliUtils.js';

const DEFAULT_PORT: number = 8050;
const LOCALHOST: string = '127.0.0.1';
const ALL_INTERFACES: string = '0.0.0.0';
const STARTUP_TIMEOUT_MS: number = 5000;
const POLL_INTERVAL_MS: number = 100;

export class ServeCommand {

    static usage(): void {
        console.log('Usage: hybridtm serve [-port <number>] [-network]');
        console.log();
        console.log('  Starts the HybridTM HTTP server.');
        console.log();
        console.log('  -port      Port to listen on (default: ' + DEFAULT_PORT + ')');
        console.log('  -network   Accept connections from other machines on the network');
        console.log('             (default: only this machine). The server has no');
        console.log('             authentication, so only use this on a trusted network.');
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            ServeCommand.usage();
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
        try {
            await ServeCommand.waitForServer(host, port, STARTUP_TIMEOUT_MS);
            console.log('HybridTM server started on ' + host + ':' + port);
        } catch (error: unknown) {
            console.error('HybridTM server failed to start on ' + host + ':' + port);
            process.exit(1);
        }
    }

    private static waitForServer(host: string, port: number, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const startTime: number = Date.now();
            const check = (): void => {
                if (Date.now() - startTime > timeoutMs) {
                    reject(new Error('Server did not start within ' + timeoutMs + 'ms'));
                    return;
                }
                ServeCommand.pingServer(host, port)
                    .then(() => resolve())
                    .catch(() => setTimeout(check, POLL_INTERVAL_MS));
            };
            check();
        });
    }

    private static pingServer(host: string, port: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const client = request({
                host: host,
                port: port,
                method: 'POST',
                path: '/',
                headers: { 'Content-Type': 'application/json' }
            }, (res: IncomingMessage) => {
                res.on('data', () => {});
                res.on('end', () => resolve());
            });
            client.on('error', (error: Error) => reject(error));
            client.write('{}');
            client.end();
        });
    }
}
