/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;

const childProcess = require('child_process') as {
	spawn: (command: string, args: string[], options: { cwd?: string }) => {
		pid: number | undefined;
		kill: () => void;
		stdout?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void };
		stderr?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void };
		on: (event: 'exit', listener: (code: number | null) => void) => void;
	};
};

export class GitDaemonService implements vscode.Disposable {
	private processHandle: ReturnType<typeof childProcess.spawn> | undefined;

	public constructor(private readonly outputChannel: vscode.OutputChannel) {
	}

	public start(workspaceRoot: string, port: number): string | undefined {
		if (this.processHandle) {
			return `git://0.0.0.0:${port}`;
		}

		const args = [
			'daemon',
			'--reuseaddr',
			`--port=${port}`,
			'--base-path=.',
			'--export-all',
			'.'
		];

		try {
			const handle = childProcess.spawn('git', args, { cwd: workspaceRoot });
			handle.stdout?.on('data', chunk => this.outputChannel.appendLine(`[STM32-COLLAB][git-daemon] ${chunk.toString('utf8').trim()}`));
			handle.stderr?.on('data', chunk => this.outputChannel.appendLine(`[STM32-COLLAB][git-daemon] ${chunk.toString('utf8').trim()}`));
			handle.on('exit', code => {
				this.outputChannel.appendLine(`[STM32-COLLAB] git daemon exited: ${code ?? -1}`);
				this.processHandle = undefined;
			});
			this.processHandle = handle;
			this.outputChannel.appendLine(`[STM32-COLLAB] git daemon started on ${port}`);
			return `git://0.0.0.0:${port}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'unknown error';
			this.outputChannel.appendLine(`[STM32-COLLAB] failed to start git daemon: ${message}`);
			return undefined;
		}
	}

	public stop(): void {
		if (!this.processHandle) {
			return;
		}
		this.processHandle.kill();
		this.processHandle = undefined;
		this.outputChannel.appendLine('[STM32-COLLAB] git daemon stopped');
	}

	public dispose(): void {
		this.stop();
	}
}
