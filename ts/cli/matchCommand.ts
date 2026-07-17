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
import { TextNode, XMLAttribute, XMLElement, XMLNode } from "typesxml";
import {
    XliffCp, XliffData, XliffDocument, XliffEc, XliffEm, XliffFile, XliffGroup, XliffIgnorable,
    XliffMatch, XliffMatches, XliffMrk, XliffOriginalData, XliffParser, XliffPc, XliffPh, XliffSc,
    XliffSegment, XliffSm, XliffSource, XliffTarget, XliffUnit
} from 'typesxliff';
import { HybridTM, HybridTMFactory, Match } from '../index.js';
import { CliUtils } from './cliUtils.js';

const MATCHES_NAMESPACE: string = 'urn:oasis:names:tc:xliff:matches:2.0';
const DEFAULT_PREFIX: string = 'mtc';
const DEFAULT_LIMIT: number = 5;
const DEFAULT_SIMILARITY: number = 60;

const PLACEHOLDER_TAGS: ReadonlySet<string> = new Set(['ph', 'bpt', 'ept', 'it', 'sc', 'ec', 'cp']);

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
                // shared so <ph>/<data> ids stay unique across the whole unit
                const dataCounter: { value: number } = { value: 0 };
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
                    const results: Array<Match> = dedupeMatches(await tm.semanticTranslationSearch(pureSource, srcLang, tgtLang, similarity, limit));
                    if (results.length === 0) {
                        continue;
                    }
                    segmentsWithMatches++;
                    totalMatches += results.length;
                    const ref: string = '#/f=' + fileId + '/u=' + unitId + (item.getId() ? '/' + item.getId() : '');
                    results.forEach((match: Match) => unitMatches.push(buildXliffMatch(ref, match, dataCounter)));
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

function dedupeMatches(matches: Array<Match>): Array<Match> {
    const seen: Set<string> = new Set();
    return matches.filter((match: Match) => {
        const key: string = extractElementText(match.source).trim() + '\u00A0' + extractElementText(match.target).trim();
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
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

function buildXliffMatch(ref: string, match: Match, dataCounter: { value: number }): XliffMatch {
    const xliffMatch: XliffMatch = new XliffMatch(ref);
    xliffMatch.setNamespacePrefix(DEFAULT_PREFIX);
    xliffMatch.setType('tm');
    xliffMatch.setOrigin(match.origin);
    // @similarity is source-text similarity; @matchQuality is the overall match rating
    xliffMatch.setSimilarity(String(match.fuzzy));
    xliffMatch.setMatchQuality(String(match.similarity));

    const originalData: XliffOriginalData = new XliffOriginalData();
    const correlations: Map<string, PlaceholderRef> = new Map();

    const source: XliffSource = new XliffSource();
    source.setContent(trimInlineContent(convertInlineContent(match.source, originalData, dataCounter, correlations, collectBptAnchors(match.source))));
    xliffMatch.setSource(source);

    const target: XliffTarget = new XliffTarget();
    target.setContent(trimInlineContent(convertInlineContent(match.target, originalData, dataCounter, correlations, collectBptAnchors(match.target))));
    xliffMatch.setTarget(target);

    if (originalData.getDataItems().length > 0) {
        xliffMatch.setOriginalData(originalData);
    }

    return xliffMatch;
}

interface PlaceholderRef {
    phId: string;
    dataId: string;
}

function collectBptAnchors(element: XMLElement): Map<string, string> {
    const anchors: Map<string, string> = new Map();
    const walk = (node: XMLElement): void => {
        node.getContent().forEach((child: XMLNode) => {
            if (!(child instanceof XMLElement)) {
                return;
            }
            if (child.getName() === 'bpt') {
                const i: string | undefined = child.getAttribute('i')?.getValue();
                const x: string | undefined = child.getAttribute('x')?.getValue();
                if (i && x) {
                    anchors.set(i, x);
                }
            }
            walk(child);
        });
    };
    walk(element);
    return anchors;
}

function convertInlineContent(
    element: XMLElement,
    originalData: XliffOriginalData,
    counter: { value: number },
    correlations: Map<string, PlaceholderRef>,
    bptAnchors: Map<string, string>
): Array<InlineContent> {
    const result: Array<InlineContent> = [];
    element.getContent().forEach((node: XMLNode) => {
        if (node instanceof TextNode) {
            result.push(node.getValue());
        } else if (node instanceof XMLElement) {
            const name: string = node.getName();
            if (PLACEHOLDER_TAGS.has(name)) {
                let anchor: string | undefined = node.getAttribute('x')?.getValue() ?? node.getAttribute('id')?.getValue();
                if (!anchor && name === 'ept') {
                    const i: string | undefined = node.getAttribute('i')?.getValue();
                    anchor = i ? bptAnchors.get(i) : undefined;
                }
                const key: string | undefined = anchor ? name + ':' + anchor : undefined;
                let ref: PlaceholderRef | undefined = key ? correlations.get(key) : undefined;

                if (!ref) {
                    counter.value++;
                    ref = { phId: 'mtcph' + counter.value, dataId: 'mtcd' + counter.value };
                    const data: XliffData = new XliffData(ref.dataId);
                    data.addText(extractElementText(node));
                    originalData.addData(data);
                    if (key) {
                        correlations.set(key, ref);
                    }
                }

                const ph: XliffPh = new XliffPh(ref.phId);
                ph.setDataRef(ref.dataId);
                result.push(ph);
            } else {
                result.push(...convertInlineContent(node, originalData, counter, correlations, bptAnchors));
            }
        }
    });
    return result;
}

function trimInlineContent(content: Array<InlineContent>): Array<InlineContent> {
    const trimmed: Array<InlineContent> = [...content];
    while (trimmed.length > 0 && typeof trimmed[0] === 'string' && (trimmed[0] as string).trim().length === 0) {
        trimmed.shift();
    }
    while (trimmed.length > 0 && typeof trimmed[trimmed.length - 1] === 'string' && (trimmed[trimmed.length - 1] as string).trim().length === 0) {
        trimmed.pop();
    }
    if (trimmed.length > 0 && typeof trimmed[0] === 'string') {
        trimmed[0] = (trimmed[0] as string).replace(/^\s+/, '');
    }
    if (trimmed.length > 0 && typeof trimmed[trimmed.length - 1] === 'string') {
        trimmed[trimmed.length - 1] = (trimmed[trimmed.length - 1] as string).replace(/\s+$/, '');
    }
    return trimmed;
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

function extractElementText(element: XMLElement): string {
    let text: string = '';
    element.getContent().forEach((node: XMLNode) => {
        if (node instanceof TextNode) {
            text += node.getValue();
        } else if (node instanceof XMLElement) {
            text += extractElementText(node);
        }
    });
    return text;
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
