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

import { LanguageUtils } from "typesbcp47";
import { ContentHandler, DOMBuilder, SAXParser, TextNode, XMLDocument, XMLElement, XMLNode } from "typesxml";

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