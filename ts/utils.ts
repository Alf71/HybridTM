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

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanguageUtils } from "typesbcp47";
import { ContentHandler, DOMBuilder, SAXParser, TextNode, XMLAttribute, XMLDocument, XMLElement, XMLNode } from "typesxml";

export class Utils {

    private static languageCache: Map<string, string | undefined> = new Map<string, string | undefined>();

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
}