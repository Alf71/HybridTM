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

import { IncomingMessage, request } from "node:http";
import { CliUtils } from './cliUtils.js';

const DEFAULT_PORT: number = 8050;

export class StopCommand {

    static usage(): void {
        console.log('Usage: hybridtm stop [-port <number>]');
        console.log();
        console.log('  Stops the HybridTM HTTP server (default port: ' + DEFAULT_PORT + ').');
        console.log('  Pass -port if the server was started with a non-default -port.');
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            StopCommand.usage();
            return;
        }
        const port: number = CliUtils.parseIntFlag(args, '-port', DEFAULT_PORT, 1, 65535);
        const body: string = JSON.stringify({ command: 'stop' });
        const response: unknown = await new Promise<unknown>((resolve, reject) => {
            const req = request({
                hostname: '127.0.0.1',
                port: port,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res: IncomingMessage) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                    } catch (error: unknown) {
                        reject(error);
                    }
                });
            });
            req.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'ECONNREFUSED') {
                    reject(new Error('HybridTM server is not running on port ' + port + '.'));
                } else {
                    reject(error);
                }
            });
            req.write(body);
            req.end();
        });

        const status: unknown = response && typeof response === 'object' ? (response as Record<string, unknown>).status : undefined;
        if (status === 'success') {
            console.log('HybridTM server stopped.');
        } else {
            const reason: unknown = response && typeof response === 'object' ? (response as Record<string, unknown>).reason : undefined;
            console.error('Failed to stop HybridTM server: ' + (typeof reason === 'string' ? reason : 'Server did not confirm a successful stop.'));
        }
    }
}
