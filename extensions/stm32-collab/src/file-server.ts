/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CollaborationSessionInfo } from './types';

declare const require: (moduleName: string) => unknown;
declare const process: { platform: string };

const childProcess = require('child_process') as {
	execFile: (command: string, args: string[], options: { cwd?: string }, callback: (error: Error | null) => void) => void;
};

const httpModule = require('http') as {
	createServer: (listener: (req: { method?: string; url?: string }, res: { writeHead: (statusCode: number, headers: Record<string, string>) => void; end: (body?: string) => void; }) => void) => {
		listen: (port: number, host: string, callback?: () => void) => void;
		close: (callback?: () => void) => void;
	};
};

const fsModule = require('fs') as {
	promises: {
		writeFile: (path: string, content: string, encoding: string) => Promise<void>;
	};
};

const pathModule = require('path') as {
	join: (...parts: string[]) => string;
};

export class LanFileShareServer implements vscode.Disposable {
	private server: ReturnType<typeof httpModule.createServer> | undefined;

	public constructor(private readonly outputChannel: vscode.OutputChannel) {
	}

	public async start(workspaceRoot: string, sessionInfo: CollaborationSessionInfo, port: number): Promise<string> {
		if (this.server) {
			return `http://${sessionInfo.hostAddress}:${port}`;
		}

		const server = httpModule.createServer((req, res) => {
			if (req.url === '/health') {
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ ok: true, service: 'stm32-collab', timestamp: new Date().toISOString() }));
				return;
			}

			const body = JSON.stringify({
				name: 'STM32 LAN Share',
				workspaceRoot,
				session: sessionInfo,
				timestamp: new Date().toISOString()
			}, null, 2);
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(body);
		});

		await new Promise<void>(resolve => server.listen(port, '0.0.0.0', resolve));
		this.server = server;
		this.outputChannel.appendLine(`[STM32-COLLAB] LAN share server started: ${port}`);
		return `http://${sessionInfo.hostAddress}:${port}`;
	}

	public async stop(): Promise<void> {
		if (!this.server) {
			return;
		}
		await new Promise<void>(resolve => this.server?.close(() => resolve()));
		this.server = undefined;
		this.outputChannel.appendLine('[STM32-COLLAB] LAN share server stopped');
	}

	public async exportWorkspaceZip(workspaceRoot: string, sessionCode: string | undefined): Promise<string | undefined> {
		const zipPath = pathModule.join(workspaceRoot, '.stm32-share.zip');
		const command = process.platform === 'win32' ? 'powershell' : 'zip';
		const args = process.platform === 'win32'
			? ['-NoProfile', '-Command', `Compress-Archive -Path "${workspaceRoot}\\*" -DestinationPath "${zipPath}" -Force`]
			: ['-r', zipPath, '.'];

		const ok = await execFileAsync(command, args, workspaceRoot, this.outputChannel);
		if (!ok) {
			return undefined;
		}

		const reportPath = pathModule.join(workspaceRoot, '.stm32-share.json');
		const report = JSON.stringify({
			zipPath,
			sessionCode: sessionCode ?? '(not started)',
			createdAt: new Date().toISOString()
		}, null, 2);
		await fsModule.promises.writeFile(reportPath, report, 'utf8');
		return zipPath;
	}

	public dispose(): void {
		void this.stop();
	}
}

function execFileAsync(command: string, args: string[], cwd: string, outputChannel: vscode.OutputChannel): Promise<boolean> {
	return new Promise(resolve => {
		childProcess.execFile(command, args, { cwd }, error => {
			if (error) {
				outputChannel.appendLine(`[STM32-COLLAB] Command failed: ${command} ${args.join(' ')}`);
				outputChannel.appendLine(`[STM32-COLLAB] ${error.message}`);
				resolve(false);
				return;
			}
			resolve(true);
		});
	});
}
