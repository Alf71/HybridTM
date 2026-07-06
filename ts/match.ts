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

import { XMLElement } from "typesxml";
import type { Match as SharedMatch, MatchType } from "typesmatch";

export class Match implements SharedMatch {

    id: string;
    source: XMLElement;
    target: XMLElement;
    origin: string;
    type: MatchType;
    similarity: number;
    properties: Record<string, string>;
    semantic: number;
    fuzzy: number;

    constructor(id: string, source: XMLElement, target: XMLElement, origin: string, semantic: number, fuzzy: number,
        properties?: Record<string, string>) {
        this.id = id;
        this.source = source;
        this.target = target;
        this.origin = origin;
        this.type = 'tm';
        this.semantic = semantic;
        this.fuzzy = fuzzy;
        this.similarity = Math.round((semantic + fuzzy) / 2);
        this.properties = properties === undefined ? {} : properties;
    }

    toJSON(): any {
        return {
            id: this.id,
            source: this.source.toString(),
            target: this.target.toString(),
            origin: this.origin,
            type: this.type,
            similarity: this.similarity,
            properties: this.properties,
            semantic: this.semantic,
            fuzzy: this.fuzzy
        }
    }

    hybridScore(): number {
        return this.similarity;
    }

}
