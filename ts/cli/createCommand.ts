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

import { HybridTM, HybridTMFactory } from '../index.js';
import { CliUtils } from './cliUtils.js';

export class CreateCommand {

    static usage(): void {
        console.log('Usage: hybridtm create -name <name> -path <dir> [-model compact|standard|large|<model id>]');
        console.log();
        console.log('  -name    Name to register the new instance under (required)');
        console.log('  -path    Directory where the instance\'s LanceDB data will live (required)');
        console.log('  -model   Embedding model preset (compact, standard, large [default]), or any');
        console.log('           other Hugging Face feature-extraction model id to load directly');
        console.log('           (e.g. onnx-community/gte-multilingual-base). See the README section');
        console.log('           "Choosing an embedding model" for guidance on which preset to pick.');
    }

    static async run(args: string[]): Promise<void> {
        if (CliUtils.hasFlag(args, '-help')) {
            CreateCommand.usage();
            return;
        }

        const name: string | undefined = CliUtils.getFlag(args, '-name');
        const rawPath: string | undefined = CliUtils.getFlag(args, '-path');
        if (!name || !rawPath) {
            CreateCommand.usage();
            CliUtils.fail('Missing required -name or -path.');
        }

        const modelAlias: string | undefined = CliUtils.getFlag(args, '-model');
        const modelName: string = CliUtils.resolveModelName(modelAlias);
        const resolvedPath: string = CliUtils.resolvePath(rawPath);

        try {
            const tm: HybridTM = HybridTMFactory.createInstance(name, resolvedPath, modelName);
            await tm.close();
            console.log('Created instance "' + name + '" at ' + resolvedPath + ' (model: ' + modelName + ')');
        } catch (error: unknown) {
            CliUtils.fail(error instanceof Error ? error.message : String(error));
        }
    }
}
