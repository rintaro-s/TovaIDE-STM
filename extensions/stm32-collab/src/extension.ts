/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;
declare const process: { platform: string };

const childProcess = require('child_process') as {
	execFile: (command: string, args: string[], options: { cwd?: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
};

const httpModule = require('http') as {
	createServer: (listener: (req: { url?: string; method?: string }, res: { writeHead: (statusCode: number, headers: Record<string, string>) => void; end: (body?: string) => void; }) => void) => {
		on: (event: string, handler: () => void) => void;
		listen: (port: number, host: string, callback: () => void) => void;
		close: (callback?: () => void) => void;
		address: () => { port: number } | string | null;
	};
};

const osModule = require('os') as {
	networkInterfaces: () => Record<string, Array<{ family: string; internal: boolean; address: string }> | undefined>;
};

const fsModule = require('fs') as {
	promises: {
		readFile: (path: string, encoding: string) => Promise<string>;
		writeFile: (path: string, content: string, encoding: string) => Promise<void>;
	};
};

const pathModule = require('path') as {
	join: (...parts: string[]) => string;
};

let outputChannel: vscode.OutputChannel;
let shareServer: {
	close: (callback?: () => void) => void;
	address: () => { port: number } | string | null;
} | undefined;
let activeSessionCode: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('STM32 Collaboration');
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.openPanel', () => openPanel()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startSession', () => startSession()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.joinSession', () => joinSession()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startLanShare', () => startLanShare()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.stopLanShare', () => stopLanShare()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.exportProjectZip', () => exportProjectZip()));

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('stm32-collab.panel', new CollaborationViewProvider()));
}

export function deactivate(): void {
	if (shareServer) {
		shareServer.close();
		shareServer = undefined;
	}
}

class CollaborationViewProvider implements vscode.WebviewViewProvider {
	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getPanelHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async message => {
			if (!isRecord(message) || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'start':
					await startSession();
					break;
				case 'join':
					await joinSession();
					break;
				case 'shareOn':
					await startLanShare();
					break;
				case 'shareOff':
					await stopLanShare();
					break;
				case 'zip':
					await exportProjectZip();
					break;
			}
		});
	}
}

async function openPanel(): Promise<void> {
	await vscode.commands.executeCommand('workbench.view.extension.stm32-collab');
}

async function startSession(): Promise<void> {
	activeSessionCode = generateSessionCode();
	await vscode.env.clipboard.writeText(activeSessionCode);
	vscode.window.showInformationMessage(vscode.l10n.t('共同作業セッションを開始しました。コードをクリップボードにコピーしました: {0}', activeSessionCode));
	outputChannel.appendLine(`[STM32-COLLAB] Session started: ${activeSessionCode}`);
}

async function joinSession(): Promise<void> {
	const code = await vscode.window.showInputBox({
		title: vscode.l10n.t('共同作業セッションに参加'),
		prompt: vscode.l10n.t('参加コードを入力してください')
	});
	if (!code) {
		return;
	}
	activeSessionCode = code.trim();
	vscode.window.showInformationMessage(vscode.l10n.t('共同作業セッションに参加しました: {0}', activeSessionCode));
	outputChannel.appendLine(`[STM32-COLLAB] Session joined: ${activeSessionCode}`);
}

async function startLanShare(): Promise<void> {
	if (shareServer) {
		vscode.window.showInformationMessage(vscode.l10n.t('LAN共有はすでに開始済みです。'));
		return;
	}

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}

	const port = vscode.workspace.getConfiguration('stm32collab').get<number>('sharePort', 8080);
	const server = httpModule.createServer((_req, res) => {
		const body = JSON.stringify({
			name: 'STM32 LAN Share',
			workspaceRoot,
			sessionCode: activeSessionCode ?? '(not started)',
			timestamp: new Date().toISOString()
		}, null, 2);
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
		res.end(body);
	});

	await new Promise<void>(resolve => server.listen(port, '0.0.0.0', () => resolve()));
	shareServer = server;

	const hostIp = getLocalIpv4Address();
	const shareUrl = `http://${hostIp}:${port}`;
	await vscode.env.clipboard.writeText(shareUrl);
	vscode.window.showInformationMessage(vscode.l10n.t('LAN共有を開始しました: {0} (URLをコピー済み)', shareUrl));
	outputChannel.appendLine(`[STM32-COLLAB] LAN share started: ${shareUrl}`);
}

async function stopLanShare(): Promise<void> {
	if (!shareServer) {
		vscode.window.showInformationMessage(vscode.l10n.t('LAN共有は開始されていません。'));
		return;
	}
	await new Promise<void>(resolve => shareServer?.close(() => resolve()));
	shareServer = undefined;
	vscode.window.showInformationMessage(vscode.l10n.t('LAN共有を停止しました。'));
	outputChannel.appendLine('[STM32-COLLAB] LAN share stopped');
}

async function exportProjectZip(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}

	const zipPath = pathModule.join(workspaceRoot, '.stm32-share.zip');
	const command = process.platform === 'win32' ? 'powershell' : 'zip';
	const args = process.platform === 'win32'
		? ['-NoProfile', '-Command', `Compress-Archive -Path "${workspaceRoot}\*" -DestinationPath "${zipPath}" -Force`]
		: ['-r', zipPath, '.'];

	const ok = await execFileAsync(command, args, workspaceRoot);
	if (!ok) {
		vscode.window.showErrorMessage(vscode.l10n.t('ZIP書き出しに失敗しました。'));
		return;
	}

	const reportPath = pathModule.join(workspaceRoot, '.stm32-share.json');
	const report = JSON.stringify({
		zipPath,
		sessionCode: activeSessionCode ?? '(not started)',
		createdAt: new Date().toISOString()
	}, null, 2);
	await fsModule.promises.writeFile(reportPath, report, 'utf8');

	vscode.window.showInformationMessage(vscode.l10n.t('共有ZIPを生成しました: {0}', zipPath));
	outputChannel.appendLine(`[STM32-COLLAB] ZIP exported: ${zipPath}`);
}

function generateSessionCode(): string {
	const random = Math.floor(100000 + Math.random() * 900000);
	return `STM32-${random}`;
}

function getLocalIpv4Address(): string {
	const network = osModule.networkInterfaces();
	for (const key of Object.keys(network)) {
		const values = network[key] ?? [];
		for (const value of values) {
			if (!value.internal && value.family === 'IPv4') {
				return value.address;
			}
		}
	}
	return '127.0.0.1';
}

function execFileAsync(command: string, args: string[], cwd: string): Promise<boolean> {
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

function getPanelHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		body { font-family: var(--vscode-font-family); margin: 0; padding: 12px; }
		button { width: 100%; margin-bottom: 8px; padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); }
	</style>
</head>
<body>
	<button id="start" aria-label="セッション開始">セッション開始</button>
	<button id="join" aria-label="セッション参加">セッション参加</button>
	<button id="shareOn" aria-label="LAN共有開始">LAN共有開始</button>
	<button id="shareOff" aria-label="LAN共有停止">LAN共有停止</button>
	<button id="zip" aria-label="ZIP書き出し">共有ZIP書き出し</button>
	<script>
		const vscode = acquireVsCodeApi();
		for (const id of ['start', 'join', 'shareOn', 'shareOff', 'zip']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
	</script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
