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

import { basename, dirname, extname, join } from "node:path";
import { XMLAttribute } from "typesxml";
import {
    XliffCp, XliffDocument, XliffEc, XliffEm, XliffFile, XliffGroup, XliffIgnorable,
    XliffMatch, XliffMatches, XliffMrk, XliffParser, XliffPc, XliffPh, XliffSc,
    XliffSegment, XliffSm, XliffSource, XliffTarget, XliffUnit
} from 'typesxliff';
import { HybridTM, HybridTMFactory, Match, Utils } from '../index.js';
import { CliUtils } from './cliUtils.js';

const MATCHES_NAMESPACE: string = 'urn:oasis:names:tc:xliff:matches:2.0';
const DEFAULT_PREFIX: string = 'mtc';
const DEFAULT_LIMIT: number = 5;
const DEFAULT_SIMILARITY: number = 60;

type InlineContent = string | XliffCp | XliffPh | XliffPc | XliffSc | XliffEc | XliffMrk | XliffSm | XliffEm;

export function usage(): void {
    console.log('Usage: hybridtm match -name <name> -file <path> [-output <path>]');
    console.log('                       [-limit N] [-similarity N] [-all]');
    console.log();
    console.log('  -name        TM instance to search against (required)');
    console.log('  -file        XLIFF file to enrich with match candidates (required)');
    console.log('  -output      Output path (default: <file-without-ext>.matches.xlf)');
    console.log('  -limit       Max candidates per segment (default: ' + DEFAULT_LIMIT + ')');
    console.log('  -similarity  Minimum hybrid match score 0-100 (default: ' + DEFAULT_SIMILARITY + ')');
    console.log('  -all         Consider every segment, not just untranslated ones');
    console.log();
    console.log('Never modifies <target>. Adds spec Translation Candidates module');
    console.log('(<mtc:matches>/<mtc:match>) entries and writes the result to a new file.');
}

export async function runMatchCommand(args: string[]): Promise<void> {
    if (CliUtils.hasFlag(args, '-help')) {
        usage();
        return;
    }

    const name: string | undefined = CliUtils.getFlag(args, '-name');
    const rawFile: string | undefined = CliUtils.getFlag(args, '-file');
    if (!name || !rawFile) {
        usage();
        CliUtils.fail('Missing required -name or -file.');
    }

    const filePath: string = CliUtils.requireExistingFile(rawFile, 'XLIFF file');
    const limit: number = parsePositiveInt(CliUtils.getFlag(args, '-limit'), DEFAULT_LIMIT, '-limit');
    const similarity: number = parsePositiveInt(CliUtils.getFlag(args, '-similarity'), DEFAULT_SIMILARITY, '-similarity');
    const processAll: boolean = CliUtils.hasFlag(args, '-all');
    const outputPath: string = resolveOutputPath(CliUtils.getFlag(args, '-output'), filePath);

    const tm: HybridTM | undefined = HybridTMFactory.getInstance(name);
    if (!tm) {
        CliUtils.fail('No instance named "' + name + '". Run "hybridtm create" or "hybridtm list" first.');
    }

    try {
        const parser: XliffParser = new XliffParser();
        parser.parseFile(filePath);
        const document: XliffDocument | undefined = parser.getXliffDocument();
        if (!document) {
            CliUtils.fail('Unable to parse "' + filePath + '".');
        }
        const srcLang: string = document.getSrcLang();
        const tgtLang: string | undefined = document.getTrgLang();
        if (!tgtLang) {
            CliUtils.fail('"' + filePath + '" is missing @trgLang; nothing to match against.');
        }

        let segmentsProcessed: number = 0;
        let segmentsWithMatches: number = 0;
        let totalMatches: number = 0;
        let usedModule: boolean = false;

        for (const file of document.getFiles()) {
            const fileId: string = file.getId();
            for (const unit of collectUnits(file.getEntries())) {
                const unitMatches: Array<XliffMatch> = [];
                const unitId: string = unit.getId();
                for (const item of unit.getItems()) {
                    if (!(item instanceof XliffSegment)) {
                        continue;
                    }
                    if (!processAll && !needsMatches(item)) {
                        continue;
                    }
                    const source: XliffSource | undefined = item.getSource();
                    const pureSource: string = source ? getPureText(source.getContent()) : '';
                    if (pureSource.trim().length === 0) {
                        continue;
                    }
                    segmentsProcessed++;
                    const results: Array<Match> = await tm.semanticTranslationSearch(pureSource, srcLang, tgtLang, similarity, limit);
                    if (results.length === 0) {
                        continue;
                    }
                    segmentsWithMatches++;
                    totalMatches += results.length;
                    const ref: string = '#/f=' + fileId + '/u=' + unitId + (item.getId() ? '/' + item.getId() : '');
                    results.forEach((match: Match) => unitMatches.push(buildXliffMatch(ref, match)));
                }
                if (unitMatches.length > 0) {
                    const matches: XliffMatches = new XliffMatches();
                    matches.setNamespacePrefix(DEFAULT_PREFIX);
                    unitMatches.forEach((match: XliffMatch) => matches.addMatch(match));
                    unit.setMatches(matches);
                    usedModule = true;
                }
            }
        }

        if (usedModule) {
            declareMatchesNamespace(document);
        }

        document.writeDocument(outputPath, true);
        console.log('Segments processed: ' + segmentsProcessed);
        console.log('Segments with matches: ' + segmentsWithMatches);
        console.log('Total match candidates: ' + totalMatches);
        console.log('Output: ' + outputPath);
    } catch (error: unknown) {
        CliUtils.fail(error instanceof Error ? error.message : String(error));
    } finally {
        await tm.close();
    }
}

function collectUnits(entries: Array<XliffUnit | XliffGroup>): Array<XliffUnit> {
    const units: Array<XliffUnit> = [];
    entries.forEach((entry: XliffUnit | XliffGroup) => {
        if (entry instanceof XliffGroup) {
            units.push(...collectUnits(entry.getEntries()));
        } else {
            units.push(entry);
        }
    });
    return units;
}

function needsMatches(segment: XliffSegment): boolean {
    const state = segment.getState();
    if (state === undefined || state === 'initial') {
        return true;
    }
    const target: XliffTarget | undefined = segment.getTarget();
    if (!target) {
        return true;
    }
    return getPureText(target.getContent()).trim().length === 0;
}

function buildXliffMatch(ref: string, match: Match): XliffMatch {
    const xliffMatch: XliffMatch = new XliffMatch(ref);
    xliffMatch.setNamespacePrefix(DEFAULT_PREFIX);
    xliffMatch.setType('tm');
    xliffMatch.setOrigin(match.origin);
    xliffMatch.setSimilarity(String(match.similarity));

    const source: XliffSource = new XliffSource();
    source.addText(Utils.getPureText(match.source));
    xliffMatch.setSource(source);

    const target: XliffTarget = new XliffTarget();
    target.addText(Utils.getPureText(match.target));
    xliffMatch.setTarget(target);

    return xliffMatch;
}

function declareMatchesNamespace(document: XliffDocument): void {
    const alreadyDeclared: boolean = document.getOtherAttributes().some(
        (attribute: XMLAttribute) => attribute.getName().startsWith('xmlns:') && attribute.getValue() === MATCHES_NAMESPACE
    );
    if (!alreadyDeclared) {
        document.setOtherAttribute('xmlns:' + DEFAULT_PREFIX, MATCHES_NAMESPACE);
    }
}

function resolveOutputPath(explicit: string | undefined, inputPath: string): string {
    if (explicit) {
        return CliUtils.resolvePath(explicit);
    }
    const ext: string = extname(inputPath);
    const stem: string = basename(inputPath, ext);
    return join(dirname(inputPath), stem + '.matches.xlf');
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
    if (raw === undefined) {
        return fallback;
    }
    const parsed: number = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        CliUtils.fail('Invalid ' + flag + ' value "' + raw + '"; expected a positive integer.');
    }
    return parsed;
}

function getPureText(content: Array<InlineContent>): string {
    let text: string = '';
    content.forEach((item: InlineContent) => {
        if (typeof item === 'string') {
            text += item;
        } else if (item instanceof XliffPc || item instanceof XliffMrk) {
            text += getPureText(item.getContent());
        }
    });
    return text;
}
