/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { captureReadOnlyDebugSnapshot } from './debug-share';
import { LanFileShareServer } from './file-server';
import { GitDaemonService } from './git-daemon';
import { MdnsDiscoveryService } from './mdns-discovery';
import { runQualityAudit } from './quality-audit';
import { CollaborationSessionInfo } from './types';
import { YjsSyncProvider } from './yjs-provider';
import { WsSyncServer } from './ws-sync-server';

declare const process: {
	on?: (event: 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void) => void;
};

let outputChannel: vscode.OutputChannel;
let activeSessionCode: string | undefined;
const discoveredSessions = new Map<string, CollaborationSessionInfo>();

let shareServer: LanFileShareServer;
let mdnsService: MdnsDiscoveryService;
let yjsSyncProvider: YjsSyncProvider;
let gitDaemonService: GitDaemonService;
let wsSyncServer: WsSyncServer;
let wsSyncStatusBar: vscode.StatusBarItem;
let globalErrorGuardInstalled = false;

function logCollabError(scope: string, error: unknown): void {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	outputChannel.appendLine(`[STM32-COLLAB] ${scope} failed: ${message}`);
}

function installGlobalErrorGuard(): void {
	if (globalErrorGuardInstalled) {
		return;
	}
	globalErrorGuardInstalled = true;
	process.on?.('uncaughtException', error => {
		logCollabError('uncaughtException', error);
	});
	process.on?.('unhandledRejection', reason => {
		logCollabError('unhandledRejection', reason);
	});
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('STM32 Collaboration');
	context.subscriptions.push(outputChannel);
	installGlobalErrorGuard();
	shareServer = new LanFileShareServer(outputChannel);
	gitDaemonService = new GitDaemonService(outputChannel);
	yjsSyncProvider = new YjsSyncProvider(outputChannel);
	wsSyncServer = new WsSyncServer(outputChannel);
	wsSyncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	wsSyncStatusBar.command = 'stm32collab.stopWsSync';
	wsSyncStatusBar.tooltip = vscode.l10n.t('STM32 WebSocket 同期サーバー稼働中 — クリックで停止');
	context.subscriptions.push(wsSyncStatusBar);
	mdnsService = new MdnsDiscoveryService(outputChannel, session => {
		discoveredSessions.set(session.sessionCode, session);
	});

	context.subscriptions.push(shareServer, gitDaemonService, yjsSyncProvider, mdnsService, wsSyncServer, wsSyncStatusBar);

	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.openPanel', () => openPanel()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startSession', () => startSession()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.joinSession', () => joinSession()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.discoverSessions', () => discoverSessions()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startRealtimeSync', () => startRealtimeSync()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.stopRealtimeSync', () => stopRealtimeSync()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startLanShare', () => startLanShare()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.stopLanShare', () => stopLanShare()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startGitDaemon', () => startGitDaemon()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.stopGitDaemon', () => stopGitDaemon()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.shareDebugSnapshot', () => shareDebugSnapshot()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.runQualityAudit', () => runQualityAudit(outputChannel)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.exportProjectZip', () => exportProjectZip()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.startWsSync', () => startWsSync()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32collab.stopWsSync', () => stopWsSync()));

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('stm32-collab.panel', new CollaborationViewProvider()));
}

export function deactivate(): void {
	// Disposables are released by VS Code through context subscriptions.
}

class CollaborationViewProvider implements vscode.WebviewViewProvider {
	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getPanelHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async message => {
			try {
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
					case 'discover':
						await discoverSessions();
						break;
					case 'syncOn':
						await startRealtimeSync();
						break;
					case 'syncOff':
						await stopRealtimeSync();
						break;
					case 'shareOn':
						await startLanShare();
						break;
					case 'shareOff':
						await stopLanShare();
						break;
					case 'gitOn':
						await startGitDaemon();
						break;
					case 'gitOff':
						await stopGitDaemon();
						break;
					case 'debug':
						await shareDebugSnapshot();
						break;
					case 'audit':
						await runQualityAudit(outputChannel);
						break;
					case 'zip':
						await exportProjectZip();
						break;
					case 'wsOn':
						await startWsSync();
						break;
					case 'wsOff':
						await stopWsSync();
						break;
				}
			} catch (error) {
				logCollabError('panel message handler', error);
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

	const sharePort = vscode.workspace.getConfiguration('stm32collab').get<number>('sharePort', 8080);
	const discoveryPort = vscode.workspace.getConfiguration('stm32collab').get<number>('discoveryPort', 5353);
	const session = mdnsService.createLocalSession(activeSessionCode, sharePort);
	mdnsService.startListening(discoveryPort);
	mdnsService.announce(discoveryPort, session);

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
	const syncPort = vscode.workspace.getConfiguration('stm32collab').get<number>('syncPort', 40123);
	yjsSyncProvider.start(activeSessionCode, syncPort);
	vscode.window.showInformationMessage(vscode.l10n.t('共同作業セッションに参加しました: {0}', activeSessionCode));
	outputChannel.appendLine(`[STM32-COLLAB] Session joined: ${activeSessionCode}`);
}

async function discoverSessions(): Promise<void> {
	const discoveryPort = vscode.workspace.getConfiguration('stm32collab').get<number>('discoveryPort', 5353);
	mdnsService.startListening(discoveryPort);

	if (discoveredSessions.size === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('現在検出済みセッションはありません。再度お試しください。'));
		return;
	}

	const items = [...discoveredSessions.values()].map(session => ({
		label: `${session.sessionCode} (${session.hostName})`,
		description: `${session.workspaceName} - ${session.hostAddress}:${session.sharePort}`,
		session
	}));
	const selected = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('近くの共同作業セッション')
	});
	if (!selected) {
		return;
	}
	activeSessionCode = selected.session.sessionCode;
	vscode.window.showInformationMessage(vscode.l10n.t('セッションを選択しました: {0}', activeSessionCode));
}

async function startRealtimeSync(): Promise<void> {
	if (!activeSessionCode) {
		vscode.window.showErrorMessage(vscode.l10n.t('先に共同作業セッションを開始または参加してください。'));
		return;
	}
	const syncPort = vscode.workspace.getConfiguration('stm32collab').get<number>('syncPort', 40123);
	yjsSyncProvider.start(activeSessionCode, syncPort);
	vscode.window.showInformationMessage(vscode.l10n.t('リアルタイム同期を開始しました。'));
}

async function stopRealtimeSync(): Promise<void> {
	yjsSyncProvider.stop();
	vscode.window.showInformationMessage(vscode.l10n.t('リアルタイム同期を停止しました。'));
}

async function startLanShare(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}

	const port = vscode.workspace.getConfiguration('stm32collab').get<number>('sharePort', 8080);
	const sessionCode = activeSessionCode ?? generateSessionCode();
	activeSessionCode = sessionCode;
	const session = mdnsService.createLocalSession(sessionCode, port);
	const shareUrl = await shareServer.start(workspaceRoot, session, port);

	const discoveryPort = vscode.workspace.getConfiguration('stm32collab').get<number>('discoveryPort', 5353);
	mdnsService.startListening(discoveryPort);
	mdnsService.announce(discoveryPort, session);

	await vscode.env.clipboard.writeText(shareUrl);
	vscode.window.showInformationMessage(vscode.l10n.t('LAN共有を開始しました: {0} (URLをコピー済み)', shareUrl));
	outputChannel.appendLine(`[STM32-COLLAB] LAN share started: ${shareUrl}`);
}

async function stopLanShare(): Promise<void> {
	await shareServer.stop();
	vscode.window.showInformationMessage(vscode.l10n.t('LAN共有を停止しました。'));
	outputChannel.appendLine('[STM32-COLLAB] LAN share stopped');
}

async function startGitDaemon(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}
	const port = vscode.workspace.getConfiguration('stm32collab').get<number>('gitPort', 9418);
	const address = gitDaemonService.start(workspaceRoot, port);
	if (!address) {
		vscode.window.showErrorMessage(vscode.l10n.t('git daemon の起動に失敗しました。'));
		return;
	}
	await vscode.env.clipboard.writeText(address);
	vscode.window.showInformationMessage(vscode.l10n.t('git daemon を開始しました: {0}', address));
}

async function stopGitDaemon(): Promise<void> {
	gitDaemonService.stop();
	vscode.window.showInformationMessage(vscode.l10n.t('git daemon を停止しました。'));
}

async function startWsSync(): Promise<void> {
	if (!activeSessionCode) {
		vscode.window.showErrorMessage(vscode.l10n.t('先に共同作業セッションを開始または参加してください。'));
		return;
	}
	if (wsSyncServer.isRunning) {
		vscode.window.showInformationMessage(vscode.l10n.t('WebSocket 同期はすでに起動中です。'));
		return;
	}
	const port = vscode.workspace.getConfiguration('stm32collab').get<number>('wsSyncPort', 40200);
	wsSyncServer.start(activeSessionCode, port, () => updateWsStatusBar(port));
	await vscode.env.clipboard.writeText(`ws://localhost:${port}`);
	vscode.window.showInformationMessage(vscode.l10n.t('WebSocket 同期サーバーを開始しました: ws://localhost:{0} (URLをコピー済み)', port));
	outputChannel.appendLine(`[STM32-COLLAB] WS sync server started on port ${port}`);
	updateWsStatusBar(port);
}

async function stopWsSync(): Promise<void> {
	wsSyncServer.stop();
	wsSyncStatusBar.hide();
	vscode.window.showInformationMessage(vscode.l10n.t('WebSocket 同期サーバーを停止しました。'));
	outputChannel.appendLine('[STM32-COLLAB] WS sync server stopped');
}

function updateWsStatusBar(port: number): void {
	const n = wsSyncServer.connectedClients;
	wsSyncStatusBar.text = `$(broadcast) WS:${port} — ${n} 接続`;
	wsSyncStatusBar.show();
}

async function shareDebugSnapshot(): Promise<void> {
	const snapshot = await captureReadOnlyDebugSnapshot(outputChannel);
	if (!snapshot) {
		vscode.window.showWarningMessage(vscode.l10n.t('アクティブなデバッグセッションが見つからないか、情報取得に失敗しました。'));
		return;
	}
	const text = JSON.stringify(snapshot, null, 2);
	const document = await vscode.workspace.openTextDocument({
		language: 'json',
		content: text
	});
	await vscode.window.showTextDocument(document, { preview: false });
	vscode.window.showInformationMessage(vscode.l10n.t('読み取り専用デバッグスナップショットを作成しました。'));
}

async function exportProjectZip(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}
	const zipPath = await shareServer.exportWorkspaceZip(workspaceRoot, activeSessionCode);
	if (!zipPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('ZIP書き出しに失敗しました。'));
		return;
	}

	vscode.window.showInformationMessage(vscode.l10n.t('共有ZIPを生成しました: {0}', zipPath));
	outputChannel.appendLine(`[STM32-COLLAB] ZIP exported: ${zipPath}`);
}

function generateSessionCode(): string {
	const random = Math.floor(100000 + Math.random() * 900000);
	return `STM32-${random}`;
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
	<button id="discover" aria-label="セッション検索">近くのセッションを検索</button>
	<button id="syncOn" aria-label="同期開始">UDP同期開始</button>
	<button id="syncOff" aria-label="同期停止">UDP同期停止</button>
	<button id="wsOn" aria-label="WS同期開始">WebSocket同期開始</button>
	<button id="wsOff" aria-label="WS同期停止">WebSocket同期停止</button>
	<button id="shareOn" aria-label="LAN共有開始">LAN共有開始</button>
	<button id="shareOff" aria-label="LAN共有停止">LAN共有停止</button>
	<button id="gitOn" aria-label="git daemon開始">git daemon開始</button>
	<button id="gitOff" aria-label="git daemon停止">git daemon停止</button>
	<button id="debug" aria-label="デバッグ共有">デバッグ状態を共有(JSON)</button>
	<button id="audit" aria-label="品質監査">品質監査レポート生成</button>
	<button id="zip" aria-label="ZIP書き出し">共有ZIP書き出し</button>
	<script>
		const vscode = acquireVsCodeApi();
		for (const id of ['start', 'join', 'discover', 'syncOn', 'syncOff', 'wsOn', 'wsOff', 'shareOn', 'shareOff', 'gitOn', 'gitOff', 'debug', 'audit', 'zip']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
	</script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
