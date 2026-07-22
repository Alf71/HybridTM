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

import { ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT: number = 8050;

export function usage(): void {
    console.log('Usage: hybridtm serve');
    console.log();
    console.log('  Starts the HybridTM HTTP server on port ' + PORT + '.');
}

export async function runServeCommand(args: string[]): Promise<void> {
    const serverPath: string = fileURLToPath(new URL('../server/hybridtmServerMain.js', import.meta.url));
    const child: ChildProcess = spawn(process.execPath, [serverPath], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    console.log('HybridTM server starting on port ' + PORT);
}
