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

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { XliffMatch, XliffMatches } from "typesxliff";
import { XMLAttribute, XMLElement } from "typesxml";
import { CliUtils } from "../cli/cliUtils.js";
import { ImportCommand, ImportType } from "../cli/importCommand.js";
import { MatchCommand } from "../cli/matchCommand.js";
import { RestoreCommand } from "../cli/restoreCommand.js";
import { HybridTM } from "../hybridtm.js";
import { HybridTMFactory, HybridTMInstanceMetadata } from '../hybridtmFactory.js';
import { ImportOptions } from "../importOptions.js";
import { SearchResult } from "../langEntry.js";
import { Match } from "../match.js";
import { MetadataFilter, TranslationSearchFilters } from "../searchFilters.js";
import { Utils } from "../utils.js";

interface JobRecord {
    status: 'running' | 'completed' | 'failed';
    payload?: unknown;
    reason?: string;
}


export class HybridTMServer {

    private readonly port: number;
    private readonly host: string;
    private server: Server | null = null;
    private instances: Map<string, HybridTM> = new Map();
    private jobs: Map<string, JobRecord> = new Map();
    private stopAfterResponse: boolean = false;

    constructor(port: number, host: string = '127.0.0.1') {
        this.port = port;
        // '0.0.0.0' accepts connections from other machines; 
        this.host = host;
    }

    private startJob(task: () => Promise<unknown>): string {
        // caller polls the "status" command with this ticket to learn when the job finishes
        const ticket: string = randomUUID();
        this.jobs.set(ticket, { status: 'running' });
        task()
            .then((payload: unknown) => {
                this.jobs.set(ticket, { status: 'completed', payload });
            })
            .catch((error: unknown) => {
                this.jobs.set(ticket, { status: 'failed', reason: error instanceof Error ? error.message : String(error) });
            });
        return ticket;
    }

    start(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
                this.handleRequest(req, res);
            });
            this.server.listen(this.port, this.host, () => {
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
        res.end(data, () => {
            if (this.stopAfterResponse) {
                this.stop().catch(() => { });
            }
        });
    }

    private async processRequest(request: any): Promise<unknown> {
        const command: any = request.command;
        if (command === 'stop') {
            return this.handleStop();
        }
        if (command === 'list') {
            return this.handleList();
        }
        if (command === 'create') {
            return this.handleCreate(request);
        }
        if (command === 'import') {
            return this.handleImport(request);
        }
        if (command === 'match') {
            return this.handleMatch(request);
        }
        if (command === 'backup') {
            return this.handleBackup(request);
        }
        if (command === 'restore') {
            return this.handleRestore(request);
        }
        if (command === 'remove') {
            return this.handleRemove(request);
        }
        if (command === 'status') {
            return this.handleStatus(request);
        }
        if (command === 'open') {
            return this.handleOpen(request);
        }
        if (command === 'close') {
            return this.handleClose(request);
        }
        if (command === 'concordanceSearch') {
            return this.handleConcordanceSearch(request);
        }
        if (command === 'semanticSearch') {
            return this.handleSemanticSearch(request);
        }
        if (command === 'semanticTranslationSearch') {
            return this.handleSemanticTranslationSearch(request);
        }
        if (command === 'storeXliffUnit') {
            return this.handleStoreXliffUnit(request);
        }
        if (command === 'batchTranslate') {
            return this.handleBatchTranslate(request);
        }
        return { status: 'failed', reason: 'Unknown command' };
    }

    private handleStop(): unknown {
        if (!this.server) {
            return { status: 'failed', reason: 'Server is not running' };
        }
        this.stopAfterResponse = true;
        return { status: 'success', payload: {} };
    }

    private handleList(): unknown {
        try {
            const instances: HybridTMInstanceMetadata[] = HybridTMFactory.listInstances();
            return { status: 'success', payload: instances };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleCreate(request: any): Promise<unknown> {
        const name: any = request.name;
        const rawPath: any = request.path;
        if (typeof name !== 'string' || name.trim().length === 0 || typeof rawPath !== 'string' || rawPath.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name or path parameter' };
        }
        const modelAlias: any = request.model;
        const modelName: string = CliUtils.resolveModelName(typeof modelAlias === 'string' ? modelAlias : undefined);
        const resolvedPath: string = CliUtils.resolvePath(rawPath);
        try {
            const tm: HybridTM = HybridTMFactory.createInstance(name, resolvedPath, modelName);
            await tm.close();
            return { status: 'success', payload: {} };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleImport(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const rawFile: any = request.file;
        if (typeof rawFile !== 'string' || rawFile.trim().length === 0) {
            return { status: 'failed', reason: 'Missing file parameter' };
        }
        const filePath: string = CliUtils.resolvePath(rawFile);
        if (!existsSync(filePath)) {
            return { status: 'failed', reason: 'Import file "' + filePath + '" does not exist' };
        }
        let type: ImportType;
        try {
            type = ImportCommand.resolveImportType(typeof request.type === 'string' ? request.type : undefined, filePath);
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
        const options: ImportOptions = {
            extractMetadata: request.noMetadata !== true
        };
        if (typeof request.minState === 'string') {
            if (!ImportCommand.isTranslationState(request.minState)) {
                return { status: 'failed', reason: 'Unknown minState value "' + request.minState + '". Expected initial, translated, reviewed, or final.' };
            }
            options.minState = request.minState;
        }
        const ticket: string = this.startJob(async () => {
            const imported: number = await ImportCommand.importFile(instance, filePath, type, options);
            return { imported: imported };
        });
        return { status: 'success', payload: { ticket: ticket } };
    }

    private handleMatch(request: any): unknown {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const rawFile: any = request.file;
        if (typeof rawFile !== 'string' || rawFile.trim().length === 0) {
            return { status: 'failed', reason: 'Missing file parameter' };
        }
        const filePath: string = CliUtils.resolvePath(rawFile);
        if (!existsSync(filePath)) {
            return { status: 'failed', reason: 'XLIFF file "' + filePath + '" does not exist' };
        }
        const rawOutput: any = request.output;
        const outputPath: string = MatchCommand.resolveOutputPath(typeof rawOutput === 'string' && rawOutput.trim().length > 0 ? rawOutput : undefined, filePath);
        const quality: any = request.quality;
        if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 0 || quality > 100) {
            return { status: 'failed', reason: 'Invalid quality parameter; expected an integer between 0 and 100' };
        }
        const limit: number | undefined = typeof request.limit === 'number' ? request.limit : undefined;

        const ticket: string = this.startJob(() => MatchCommand.matchXliffFile(instance, filePath, outputPath, quality, limit));
        return { status: 'success', payload: { ticket: ticket } };
    }

    private handleBackup(request: any): unknown {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const rawFile: any = request.file;
        if (typeof rawFile !== 'string' || rawFile.trim().length === 0) {
            return { status: 'failed', reason: 'Missing file parameter' };
        }
        const outputPath: string = CliUtils.resolvePath(rawFile);

        const ticket: string = this.startJob(async () => {
            const count: number = await instance.backup(outputPath);
            return { backedUp: count };
        });
        return { status: 'success', payload: { ticket: ticket } };
    }

    private async handleRestore(request: any): Promise<unknown> {
        const rawFile: any = request.file;
        if (typeof rawFile !== 'string' || rawFile.trim().length === 0) {
            return { status: 'failed', reason: 'Missing file parameter' };
        }
        const filePath: string = CliUtils.resolvePath(rawFile);
        if (!existsSync(filePath)) {
            return { status: 'failed', reason: 'Backup file "' + filePath + '" does not exist' };
        }

        let target: HybridTM;
        let targetName: string;
        if (request.create === true) {
            const rawPath: any = request.path;
            if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
                return { status: 'failed', reason: 'Missing path parameter for create' };
            }
            const resolvedPath: string = CliUtils.resolvePath(rawPath);

            let name: string | undefined = typeof request.name === 'string' && request.name.trim().length > 0 ? request.name : undefined;
            const modelAlias: string | undefined = typeof request.model === 'string' ? request.model : undefined;
            let modelName: string | undefined = modelAlias ? CliUtils.resolveModelName(modelAlias) : undefined;

            if (!name || !modelName) {
                try {
                    const header: { name: string; model: string } = await RestoreCommand.peekBackupHeader(filePath);
                    name = name || header.name || undefined;
                    modelName = modelName || header.model || undefined;
                } catch (error: unknown) {
                    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
                }
            }
            if (!name) {
                return { status: 'failed', reason: 'Could not determine an instance name; pass name or restore from a backup file with a recorded name.' };
            }
            if (!modelName) {
                return { status: 'failed', reason: 'Could not determine an embedding model; pass model or restore from a backup file with a recorded model.' };
            }
            try {
                target = HybridTMFactory.createInstance(name, resolvedPath, modelName);
            } catch (error: unknown) {
                return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
            }
            targetName = name;
            this.instances.set(targetName, target);
        } else {
            const name: any = request.name;
            if (typeof name !== 'string' || name.trim().length === 0) {
                return { status: 'failed', reason: 'Missing name parameter' };
            }
            const instance: HybridTM | undefined = this.instances.get(name);
            if (!instance) {
                return { status: 'failed', reason: 'Requested instance is not open' };
            }
            target = instance;
            targetName = name;
        }

        const ticket: string = this.startJob(async () => {
            const count: number = await target.restore(filePath);
            return { restored: count, name: targetName };
        });
        return { status: 'success', payload: { ticket: ticket } };
    }

    private async handleRemove(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        try {
            const openInstance: HybridTM | undefined = this.instances.get(name);
            if (openInstance) {
                await openInstance.close();
                this.instances.delete(name);
            }
            HybridTMFactory.removeInstance(name);
            return { status: 'success', payload: {} };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private handleStatus(request: any): unknown {
        const ticket: any = request.ticket;
        if (typeof ticket !== 'string' || ticket.trim().length === 0) {
            return { status: 'failed', reason: 'Missing ticket parameter' };
        }
        const job: JobRecord | undefined = this.jobs.get(ticket);
        if (!job) {
            return { status: 'failed', reason: 'Unknown ticket' };
        }
        if (job.status === 'running') {
            return { status: 'success', payload: { ticket: ticket, jobStatus: job.status } };
        }
        this.jobs.delete(ticket);
        if (job.status === 'failed') {
            return { status: 'success', payload: { ticket: ticket, jobStatus: job.status, reason: job.reason } };
        }
        return { status: 'success', payload: { ticket: ticket, jobStatus: job.status, result: job.payload } };
    }

    private handleOpen(request: any): unknown {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        if (this.instances.has(name)) {
            return { status: 'success', payload: {} };
        }
        try {
            const instance: HybridTM | undefined = HybridTMFactory.getInstance(name);
            if (!instance) {
                return { status: 'failed', reason: 'Requested instance does not exist' };
            }
            this.instances.set(name, instance);
            return { status: 'success', payload: {} };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleClose(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        try {
            await instance.close();
            this.instances.delete(name);
            return { status: 'success', payload: {} };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleConcordanceSearch(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const textFragment: any = request.textFragment;
        const language: any = request.language;
        if (typeof textFragment !== 'string' || typeof language !== 'string') {
            return { status: 'failed', reason: 'Missing textFragment or language parameter' };
        }
        const limit: number | undefined = typeof request.limit === 'number' ? request.limit : undefined;
        const filters: MetadataFilter | undefined = request.filters;
        try {
            const results: Map<string, XMLElement>[] = await instance.concordanceSearch(textFragment, language, limit, filters);
            const payload: Record<string, string>[] = results.map((languageMap: Map<string, XMLElement>) => {
                const entry: Record<string, string> = {};
                languageMap.forEach((element: XMLElement, lang: string) => {
                    entry[lang] = element.toString();
                });
                return entry;
            });
            return { status: 'success', payload: payload };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleSemanticSearch(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const queryText: any = request.queryText;
        const language: any = request.language;
        if (typeof queryText !== 'string' || typeof language !== 'string') {
            return { status: 'failed', reason: 'Missing queryText or language parameter' };
        }
        const limit: number | undefined = typeof request.limit === 'number' ? request.limit : undefined;
        const filters: MetadataFilter | undefined = request.filters;
        try {
            const results: SearchResult[] = await instance.semanticSearch(queryText, language, limit, filters);
            return { status: 'success', payload: results };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleSemanticTranslationSearch(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const searchStr: any = request.searchStr;
        const srcLang: any = request.srcLang;
        const tgtLang: any = request.tgtLang;
        const similarity: any = request.similarity;
        if (typeof searchStr !== 'string' || typeof srcLang !== 'string' || typeof tgtLang !== 'string' || typeof similarity !== 'number') {
            return { status: 'failed', reason: 'Missing searchStr, srcLang, tgtLang or similarity parameter' };
        }
        const limit: number | undefined = typeof request.limit === 'number' ? request.limit : undefined;
        const filters: TranslationSearchFilters | undefined = request.filters;
        try {
            const results: Match[] = await instance.semanticTranslationSearch(searchStr, srcLang, tgtLang, similarity, limit, filters);
            return { status: 'success', payload: results };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private async handleStoreXliffUnit(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const unit: any = request.unit;
        const fileId: any = request.fileId;
        const original: any = request.original;
        const srcLang: any = request.srcLang;
        const tgtLang: any = request.tgtLang;
        if (typeof unit !== 'string' || typeof fileId !== 'string' || typeof original !== 'string'
            || typeof srcLang !== 'string' || typeof tgtLang !== 'string') {
            return { status: 'failed', reason: 'Missing unit, fileId, original, srcLang or tgtLang parameter' };
        }
        let tempFilePath: string | undefined;
        try {
            tempFilePath = Utils.writeXliffDocument(unit, fileId, original, srcLang, tgtLang);
            await instance.importXLIFF(tempFilePath);
            return { status: 'success', payload: {} };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        } finally {
            if (tempFilePath && existsSync(tempFilePath)) {
                unlinkSync(tempFilePath);
            }
        }
    }

    private async handleBatchTranslate(request: any): Promise<unknown> {
        const name: any = request.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
            return { status: 'failed', reason: 'Missing name parameter' };
        }
        const instance: HybridTM | undefined = this.instances.get(name);
        if (!instance) {
            return { status: 'failed', reason: 'Requested instance is not open' };
        }
        const units: any = request.units;
        const srcLang: any = request.srcLang;
        const tgtLang: any = request.tgtLang;
        if (!Array.isArray(units) || units.length === 0 || units.some((unit: unknown) => typeof unit !== 'string')
            || typeof srcLang !== 'string' || typeof tgtLang !== 'string') {
            return { status: 'failed', reason: 'Missing units, srcLang or tgtLang parameter' };
        }
        const quality: any = request.quality;
        if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 0 || quality > 100) {
            return { status: 'failed', reason: 'Invalid quality parameter; expected an integer between 0 and 100' };
        }
        const limit: number | undefined = typeof request.limit === 'number' ? request.limit : undefined;
        const fileId: string | undefined = typeof request.fileId === 'string' ? request.fileId : undefined;

        try {
            let segmentsProcessed: number = 0;
            let segmentsWithMatches: number = 0;
            let totalMatches: number = 0;
            const resultUnits: string[] = [];

            for (const unitXml of units as string[]) {
                const unitElement: XMLElement = Utils.buildXMLElement(unitXml);
                if (unitElement.getName() !== 'unit') {
                    throw new Error('Expected a <unit> element, found <' + unitElement.getName() + '>');
                }
                const unitId: string = unitElement.getAttribute('id')?.getValue() ?? '';
                const segments: XMLElement[] = unitElement.getChildren().filter((child: XMLElement) => child.getName() === 'segment');

                const unitMatches: XliffMatch[] = [];
                const dataCounter: { value: number } = { value: 0 };

                for (const segment of segments) {
                    if (segment.getAttribute('state')?.getValue() === 'final') {
                        continue;
                    }
                    const source: XMLElement | undefined = segment.getChild('source');
                    const pureSource: string = source ? Utils.getPureText(source) : '';
                    if (pureSource.trim().length === 0) {
                        continue;
                    }
                    segmentsProcessed++;
                    const results: Match[] = Utils.dedupeMatches(await instance.semanticTranslationSearch(pureSource, srcLang, tgtLang, quality, limit));
                    if (results.length === 0) {
                        continue;
                    }
                    segmentsWithMatches++;
                    totalMatches += results.length;
                    const segmentId: string | undefined = segment.getAttribute('id')?.getValue();
                    let ref: string;
                    if (segmentId) {
                        ref = '#' + segmentId;
                    } else if (fileId) {
                        ref = '#/f=' + fileId + '/u=' + unitId;
                    } else {
                        ref = '#/u=' + unitId;
                    }
                    results.forEach((match: Match) => unitMatches.push(Utils.buildXliffMatch(ref, match, dataCounter)));
                }

                if (unitMatches.length > 0) {
                    const matches: XliffMatches = new XliffMatches();
                    matches.setNamespacePrefix(Utils.MTC_PREFIX);
                    unitMatches.forEach((match: XliffMatch) => matches.addMatch(match));
                    unitElement.setContent([matches.toElement(), ...unitElement.getContent()]);
                    this.declareMatchesNamespace(unitElement);
                }

                resultUnits.push(unitElement.toString());
            }

            return {
                status: 'success',
                payload: {
                    units: resultUnits,
                    segmentsProcessed: segmentsProcessed,
                    segmentsWithMatches: segmentsWithMatches,
                    totalMatches: totalMatches
                }
            };
        } catch (error: unknown) {
            return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }

    private declareMatchesNamespace(unit: XMLElement): void {
        if (!Utils.isNamespaceDeclared(unit.getAttributes(), Utils.MATCHES_NAMESPACE)) {
            unit.setAttribute(new XMLAttribute('xmlns:' + Utils.MTC_PREFIX, Utils.MATCHES_NAMESPACE));
        }
    }

}
