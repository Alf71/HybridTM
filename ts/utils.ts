/*******************************************************************************
 * Copyright (c) 2025-2026 Maxprograms.
 *
 * This program and the accompanying materials
 * are made available under the terms of the Eclipse  License 1.0
 * which accompanies this distribution, and is available at
 * https://www.eclipse.org/org/documents/epl-v10.html
 *
 * Contributors:
 *     Maxprograms - initial API and implementation
 *******************************************************************************/

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanguageUtils } from "typesbcp47";
import {
    XliffCp, XliffData, XliffEc, XliffEm, XliffMatch, XliffMrk,
    XliffOriginalData, XliffPc, XliffPh, XliffSc, XliffSm, XliffSource, XliffTarget
} from "typesxliff";
import { ContentHandler, DOMBuilder, SAXParser, TextNode, XMLAttribute, XMLDocument, XMLElement, XMLNode } from "typesxml";
import { Match } from "./match.js";

type InlineContent = string | XliffCp | XliffPh | XliffPc | XliffSc | XliffEc | XliffMrk | XliffSm | XliffEm;

interface PlaceholderRef {
    phId: string;
    dataId: string;
}

export class Utils {

    private static languageCache: Map<string, string | undefined> = new Map<string, string | undefined>();
    private static readonly PLACEHOLDER_TAGS: ReadonlySet<string> = new Set(['ph', 'bpt', 'ept', 'it', 'sc', 'ec', 'cp']);
    static readonly MTC_PREFIX: string = 'mtc';
    static readonly MATCHES_NAMESPACE: string = 'urn:oasis:names:tc:xliff:matches:2.0';

    static replaceQuotes(value: string): string {
        return value.replaceAll("'", "''");
    }

    static normalizeLanguage(tag: string): string | undefined {
        if (Utils.languageCache.has(tag)) {
            return Utils.languageCache.get(tag);
        }
        const normalized: string | undefined = LanguageUtils.normalizeCode(tag);
        Utils.languageCache.set(tag, normalized);
        return normalized;
    }

    static getPureText(element: XMLElement): string {
        let text: string = '';
        let content: XMLNode[] = element.getContent();
        content.forEach((node: XMLNode) => {
            if (node instanceof TextNode) {
                text += node.getValue();
            }
            if (node instanceof XMLElement) {
                const child: XMLElement = node;
                if ("pc" === child.getName() || "mrk" === child.getName() || "hi" === child.getName()) {
                    text += this.getPureText(child);
                }
                // purposedly ignore "cp" for now
            }
        });
        return text;
    }

    static buildXliffDocument(unitXml: string, fileId: string, original: string, srcLang: string, tgtLang: string): string {
        const unitElement: XMLElement = Utils.buildXMLElement(unitXml);
        if (unitElement.getName() !== 'unit') {
            throw new Error('Expected a <unit> element, found <' + unitElement.getName() + '>');
        }

        const fileElement: XMLElement = new XMLElement('file');
        fileElement.setAttribute(new XMLAttribute('id', fileId));
        fileElement.setAttribute(new XMLAttribute('original', original));
        fileElement.addElement(unitElement);

        const xliffElement: XMLElement = new XMLElement('xliff');
        xliffElement.setAttribute(new XMLAttribute('xmlns', 'urn:oasis:names:tc:xliff:document:2.0'));
        xliffElement.setAttribute(new XMLAttribute('version', '2.1'));
        xliffElement.setAttribute(new XMLAttribute('srcLang', srcLang));
        xliffElement.setAttribute(new XMLAttribute('trgLang', tgtLang));
        xliffElement.addElement(fileElement);

        return xliffElement.toString();
    }

    static writeXliffDocument(unitXml: string, fileId: string, original: string, srcLang: string, tgtLang: string): string {
        const xliffDocument: string = Utils.buildXliffDocument(unitXml, fileId, original, srcLang, tgtLang);
        const tempFileName: string = 'unit_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.xlf';
        const tempFilePath: string = join(tmpdir(), tempFileName);
        writeFileSync(tempFilePath, xliffDocument, { encoding: 'utf-8' });
        return tempFilePath;
    }

    static buildXMLElement(str: string): XMLElement {
        const contentHandler: ContentHandler = new DOMBuilder();
        const xmlParser: SAXParser = new SAXParser();
        xmlParser.setContentHandler(contentHandler);
        xmlParser.parseString(str);
        const newDoc: XMLDocument | undefined = (contentHandler as DOMBuilder).getDocument();
        if (newDoc) {
            const root: XMLElement | undefined = newDoc.getRoot();
            if (root) {
                return root;
            }
        }
        throw new Error('Error building XMLElement from string');
    }

    static dedupeMatches(matches: Array<Match>): Array<Match> {
        const seen: Set<string> = new Set();
        return matches.filter((match: Match) => {
            const key: string = Utils.extractElementText(match.source).trim() + '\u00A0' + Utils.extractElementText(match.target).trim();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    static isNamespaceDeclared(attributes: Array<XMLAttribute>, namespace: string): boolean {
        return attributes.some((attribute: XMLAttribute) => attribute.getName().startsWith('xmlns:') && attribute.getValue() === namespace);
    }

    static extractElementText(element: XMLElement): string {
        let text: string = '';
        element.getContent().forEach((node: XMLNode) => {
            if (node instanceof TextNode) {
                text += node.getValue();
            } else if (node instanceof XMLElement) {
                text += Utils.extractElementText(node);
            }
        });
        return text;
    }

    static collectBptAnchors(element: XMLElement): Map<string, string> {
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

    static convertInlineContent(
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
                if (Utils.PLACEHOLDER_TAGS.has(name)) {
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
                        data.addText(Utils.extractElementText(node));
                        originalData.addData(data);
                        if (key) {
                            correlations.set(key, ref);
                        }
                    }

                    const ph: XliffPh = new XliffPh(ref.phId);
                    ph.setDataRef(ref.dataId);
                    result.push(ph);
                } else {
                    result.push(...Utils.convertInlineContent(node, originalData, counter, correlations, bptAnchors));
                }
            }
        });
        return result;
    }

    static trimInlineContent(content: Array<InlineContent>): Array<InlineContent> {
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

    static buildXliffMatch(ref: string, match: Match, dataCounter: { value: number }): XliffMatch {
        const xliffMatch: XliffMatch = new XliffMatch(ref);
        xliffMatch.setNamespacePrefix(Utils.MTC_PREFIX);
        xliffMatch.setType('tm');
        xliffMatch.setOrigin(match.origin);
        // @similarity is source-text similarity; @matchQuality is the overall match rating
        xliffMatch.setSimilarity(String(match.fuzzy));
        xliffMatch.setMatchQuality(String(match.similarity));

        const originalData: XliffOriginalData = new XliffOriginalData();
        const correlations: Map<string, PlaceholderRef> = new Map();

        const source: XliffSource = new XliffSource();
        source.setContent(Utils.trimInlineContent(Utils.convertInlineContent(match.source, originalData, dataCounter, correlations, Utils.collectBptAnchors(match.source))));
        xliffMatch.setSource(source);

        const target: XliffTarget = new XliffTarget();
        target.setContent(Utils.trimInlineContent(Utils.convertInlineContent(match.target, originalData, dataCounter, correlations, Utils.collectBptAnchors(match.target))));
        xliffMatch.setTarget(target);

        if (originalData.getDataItems().length > 0) {
            xliffMatch.setOriginalData(originalData);
        }

        return xliffMatch;
    }
}