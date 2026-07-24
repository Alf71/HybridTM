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

export type TranslationState = 'initial' | 'translated' | 'reviewed' | 'final';

export interface ImportOptions {
    minState?: TranslationState;
    extractMetadata?: boolean;
}

export type ResolvedImportOptions = Required<ImportOptions>;

export class ImportOptionsResolver {

    static readonly DEFAULT: ResolvedImportOptions = {
        minState: 'translated',
        extractMetadata: true
    };

    static resolve(options?: ImportOptions): ResolvedImportOptions {
        return {
            ...ImportOptionsResolver.DEFAULT,
            ...(options ?? {})
        };
    }
}
