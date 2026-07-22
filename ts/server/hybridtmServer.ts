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

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { HybridTMFactory, HybridTMInstanceMetadata } from '../hybridtmFactory.js';

export class HybridTMServer {

    private readonly port: number;
    private server: Server | null = null;

    constructor(port: number) {
        this.port = port;
    }

    start(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
                this.handleRequest(req, res);
            });
            this.server.listen(this.port, '127.0.0.1', () => {
                resolve();
            });
        });
    }

    stop(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (!this.server) {
                resolve();
                return;
            }
            const server: Server = this.server;
            this.server = null;
            server.close((error?: Error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        let request: any;
        try {
            request = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch (error: unknown) {
            const reason: string = error instanceof Error ? error.message : String(error);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'failed', reason: reason }));
            return;
        }
        const result: unknown = await this.processRequest(request);
        const data: string = JSON.stringify(result);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
    }

    private async processRequest(request: any): Promise<unknown> {
        const command: any = request.command;
        if (command === 'stop') {
            if (!this.server) {
                return { status: 'failed', reason: 'Server is not running' };
            }
            this.stop().catch(() => { });
            return { status: 'success', payload: {} };
        }
        if (command === 'list') {
            try {
                const instances: HybridTMInstanceMetadata[] = HybridTMFactory.listInstances();
                return { status: 'success', payload: instances };
            } catch (error: unknown) {
                return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
            }
        }
        return request;
    }
}
