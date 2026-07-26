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

import { basename, dirname, extname, join } from "node:path";
import {
    XliffDocument, XliffGroup, XliffMatch, XliffMatches, XliffParser,
    XliffSegment, XliffSource, XliffUnit
} from 'typesxliff';
import { HybridTM, HybridTMFactory, Match, Utils } from '../index.js';
import { CliUtils } from './cliUtils.js';

export interface MatchResult {
    segmentsProcessed: number;
    segmentsWithMatches: number;
    totalMatches: number;
    outputPath: string;
}

export class MatchCommand {

    static usage(): void {
        console.log('Usage: hybridtm match -name <name> -file <path> -quality N [-output <path>]');
        console.log('                       [-limit N]');
        console.log();
        console.log('  -name        TM instance to search against (required)');
        console.log('  -file        XLIFF file to enrich with match candidates (required)');
        console.log('  -quality     Minimum hybrid match score 0-100, written as @matchQuality (required)');
        console.log('  -output      Output path (default: <file-without-ext>.matches.xlf)');
        console.log('  -limit       Max candidates per segment (default: 10)');
        console.log();
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            MatchCommand.usage();
            return;
        }

        const name: string | undefined = CliUtils.getFlag(args, '-name');
        const rawFile: string | undefined = CliUtils.getFlag(args, '-file');
        const rawQuality: string | undefined = CliUtils.getFlag(args, '-quality');
        if (!name || !rawFile || !rawQuality) {
            MatchCommand.usage();
            CliUtils.fail('Missing required -name, -file, or -quality.');
        }

        const filePath: string = CliUtils.requireExistingFile(rawFile, 'XLIFF file');
        const rawLimit: string | undefined = CliUtils.getFlag(args, '-limit');
        const limit: number | undefined = rawLimit !== undefined ? MatchCommand.parseIntOption(rawLimit, '-limit', 1) : undefined;
        const quality: number = MatchCommand.parseIntOption(rawQuality, '-quality', 0, 100);
        const outputPath: string = MatchCommand.resolveOutputPath(CliUtils.getFlag(args, '-output'), filePath);

        const tm: HybridTM | undefined = HybridTMFactory.getInstance(name);
        if (!tm) {
            CliUtils.fail('No instance named "' + name + '". Run "hybridtm create" or "hybridtm list" first.');
        }

        try {
            const result: MatchResult = await MatchCommand.matchXliffFile(tm, filePath, outputPath, quality, limit);
            console.log('Segments processed: ' + result.segmentsProcessed);
            console.log('Segments with matches: ' + result.segmentsWithMatches);
            console.log('Total match candidates: ' + result.totalMatches);
            console.log('Output: ' + result.outputPath);
        } catch (error: unknown) {
            CliUtils.fail(error instanceof Error ? error.message : String(error));
        } finally {
            await tm.close();
        }
    }

    static async matchXliffFile(tm: HybridTM, filePath: string, outputPath: string, quality: number, limit?: number): Promise<MatchResult> {
        const parser: XliffParser = new XliffParser();
        parser.parseFile(filePath);
        const document: XliffDocument | undefined = parser.getXliffDocument();
        if (!document) {
            throw new Error('Unable to parse "' + filePath + '".');
        }
        const rawSrcLang: string = document.getSrcLang();
        const srcLang: string | undefined = Utils.normalizeLanguage(rawSrcLang);
        if (!srcLang) {
            throw new Error('"' + filePath + '" has an invalid @srcLang value "' + rawSrcLang + '".');
        }
        const rawTgtLang: string | undefined = document.getTrgLang();
        if (!rawTgtLang) {
            throw new Error('"' + filePath + '" is missing @trgLang; nothing to match against.');
        }
        const tgtLang: string | undefined = Utils.normalizeLanguage(rawTgtLang);
        if (!tgtLang) {
            throw new Error('"' + filePath + '" has an invalid @trgLang value "' + rawTgtLang + '".');
        }

        let segmentsProcessed: number = 0;
        let segmentsWithMatches: number = 0;
        let totalMatches: number = 0;
        let usedModule: boolean = false;

        for (const file of document.getFiles()) {
            const fileId: string = file.getId();
            for (const unit of MatchCommand.collectUnits(file.getEntries())) {
                const unitMatches: Array<XliffMatch> = [];
                const unitId: string = unit.getId();
                // shared so <ph>/<data> ids stay unique across the whole unit
                const dataCounter: { value: number } = { value: 0 };
                for (const item of unit.getItems()) {
                    if (!(item instanceof XliffSegment)) {
                        continue;
                    }
                    if (item.getState() === 'final') {
                        continue;
                    }
                    const source: XliffSource | undefined = item.getSource();
                    const pureSource: string = source ? Utils.getPureText(source.toElement()) : '';
                    if (pureSource.trim().length === 0) {
                        continue;
                    }
                    segmentsProcessed++;
                    const results: Array<Match> = Utils.dedupeMatches(await tm.semanticTranslationSearch(pureSource, srcLang, tgtLang, quality, limit));
                    if (results.length === 0) {
                        continue;
                    }
                    segmentsWithMatches++;
                    totalMatches += results.length;
                    const ref: string = item.getId() ? '#' + item.getId() : '#/f=' + fileId + '/u=' + unitId;
                    results.forEach((match: Match) => unitMatches.push(Utils.buildXliffMatch(ref, match, dataCounter)));
                }
                if (unitMatches.length > 0) {
                    const matches: XliffMatches = new XliffMatches();
                    matches.setNamespacePrefix(Utils.MTC_PREFIX);
                    unitMatches.forEach((match: XliffMatch) => matches.addMatch(match));
                    unit.setMatches(matches);
                    usedModule = true;
                }
            }
        }

        if (usedModule) {
            MatchCommand.declareMatchesNamespace(document);
        }

        document.writeDocument(outputPath, true);
        return { segmentsProcessed, segmentsWithMatches, totalMatches, outputPath };
    }

    static resolveOutputPath(explicit: string | undefined, inputPath: string): string {
        if (explicit) {
            return CliUtils.resolvePath(explicit);
        }
        const ext: string = extname(inputPath);
        const stem: string = basename(inputPath, ext);
        return join(dirname(inputPath), stem + '.matches.xlf');
    }

    private static collectUnits(entries: Array<XliffUnit | XliffGroup>): Array<XliffUnit> {
        const units: Array<XliffUnit> = [];
        entries.forEach((entry: XliffUnit | XliffGroup) => {
            if (entry instanceof XliffGroup) {
                units.push(...MatchCommand.collectUnits(entry.getEntries()));
            } else {
                units.push(entry);
            }
        });
        return units;
    }

    private static declareMatchesNamespace(document: XliffDocument): void {
        if (!Utils.isNamespaceDeclared(document.getOtherAttributes(), Utils.MATCHES_NAMESPACE)) {
            document.setOtherAttribute('xmlns:' + Utils.MTC_PREFIX, Utils.MATCHES_NAMESPACE);
        }
    }

    private static parseIntOption(raw: string, flag: string, min: number, max?: number): number {
        const parsed: number = Number(raw);
        if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
            const range: string = max !== undefined ? 'an integer between ' + min + ' and ' + max : 'an integer of at least ' + min;
            CliUtils.fail('Invalid ' + flag + ' value "' + raw + '"; expected ' + range + '.');
        }
        return parsed;
    }
}
