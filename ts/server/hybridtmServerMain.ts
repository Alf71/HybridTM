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

import { HybridTMServer } from './hybridtmServer.js';

const DEFAULT_PORT: number = 8050;
const port: number = process.argv[2] ? Number(process.argv[2]) : DEFAULT_PORT;
const host: string | undefined = process.argv[3];

const server: HybridTMServer = host ? new HybridTMServer(port, host) : new HybridTMServer(port);
server.start();
