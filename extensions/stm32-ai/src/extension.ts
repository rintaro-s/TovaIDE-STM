/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;
declare const process: {
	platform: string;
	on?: (event: 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void) => void;
};

const httpModule = require('http') as {
	createServer: (handler: (req: IncomingMessageLike, res: ServerResponseLike) => void) => HttpServerLike;
	get: (url: string, callback: (res: { statusCode?: number; on(e: 'data', l: (c: unknown) => void): void; on(e: 'end', l: () => void): void; }) => void) => { on(e: 'error', l: (e: Error) => void): void; end(): void };
};
const cryptoModule = require('crypto') as {
	randomBytes: (size: number) => { toString: (encoding: string) => string };
};
const childProcess = require('child_process') as {
	execFile: (
		command: string,
		args: string[],
		options: { cwd?: string; shell?: boolean },
		callback: (error: Error | null, stdout: string, stderr: string) => void
	) => void;
};

type LmApi = {
	registerTool?: <TInput>(name: string, tool: { invoke: (options: { input: TInput }, token: vscode.CancellationToken) => Thenable<vscode.LanguageModelToolResult> | vscode.LanguageModelToolResult }) => vscode.Disposable;
	selectChatModels?: (selector?: { id?: string }) => Thenable<vscode.LanguageModelChat[]>;
};

type ChatApi = {
	createChatParticipant?: (id: string, handler: (request: unknown, context: unknown, stream: { markdown: (value: string) => void }, token: vscode.CancellationToken) => unknown) => vscode.Disposable;
};

interface IncomingMessageLike {
	url?: string;
	method?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: 'data', listener: (chunk: unknown) => void): void;
	on(event: 'end', listener: () => void): void;
}

interface ServerResponseLike {
	writeHead: (statusCode: number, headers?: Record<string, string>) => void;
	write?: (chunk: string) => void;
	on?: (event: 'close', listener: () => void) => void;
	end: (body?: string) => void;
}

interface HttpServerLike {
	listen: (port: number, host: string, callback?: () => void) => void;
	close: (callback?: (error?: Error) => void) => void;
	on: (event: 'error', listener: (error: Error) => void) => void;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

const lmApi = (vscode as unknown as { lm?: LmApi }).lm;
const chatApi = (vscode as unknown as { chat?: ChatApi }).chat;

let assistantOutput: vscode.OutputChannel;
let extensionContextRef: vscode.ExtensionContext | undefined;
let mcpServer: HttpServerLike | undefined;
let mcpServerHost = '127.0.0.1';
let mcpServerPort = 3737;
let activeAssistantView: vscode.WebviewView | undefined;
let mcpPollTimer: ReturnType<typeof setInterval> | undefined;
const sseSessions = new Map<string, ServerResponseLike>();
let mcpServerRunning = false;
let mcpServerStarting = false;
let mcpRequireAuth = false;
let mcpTakeoverInProgress = false;
let globalErrorGuardInstalled = false;

const MCP_TOKEN_SECRET_KEY = 'stm32ai.mcp.token';

function logAiError(scope: string, error: unknown): void {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	assistantOutput.appendLine(`[STM32-AI] ${scope} failed: ${message}`);
}

function installGlobalErrorGuard(): void {
	if (globalErrorGuardInstalled) {
		return;
	}
	globalErrorGuardInstalled = true;
	process.on?.('uncaughtException', error => {
		logAiError('uncaughtException', error);
	});
	process.on?.('unhandledRejection', reason => {
		logAiError('unhandledRejection', reason);
	});
}

export function activate(context: vscode.ExtensionContext): void {
	extensionContextRef = context;
	assistantOutput = vscode.window.createOutputChannel('STM32 AI');
	context.subscriptions.push(assistantOutput);
	installGlobalErrorGuard();
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.runSemiAutoFlow', () => runSemiAutoFlow()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.runAutoUntilFlash', () => runAutoUntilFlash()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.runFullAutoFlow', () => runFullAutoFlow()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.fixBuildError', () => fixBuildErrorWithAi()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.analyzeHardFault', () => analyzeHardFaultWithAi()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.startMcpServer', () => startMcpServer(context)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.stopMcpServer', () => stopMcpServer()));
	context.subscriptions.push({ dispose: () => void stopMcpServer() });

	registerLanguageModelTools(context);

	void ensureMcpServerToken(context).catch(error => {
		logAiError('ensureMcpServerToken', error);
	});
	const autoStartServer = vscode.workspace.getConfiguration('stm32ai').get<boolean>('mcp.autoStartServer', true);
	if (autoStartServer) {
		void startMcpServer(context).catch(error => {
			logAiError('autoStartMcpServer', error);
		});
	}

	startMcpStatusPolling();
	context.subscriptions.push({ dispose: () => { if (mcpPollTimer !== undefined) { clearInterval(mcpPollTimer); } } });
}

function pollMcpHealth(): void {
	const url = `http://${mcpServerHost}:${mcpServerPort}/health`;
	const req = httpModule.get(url, res => {
		const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
		res.on('data', () => { });
		res.on('end', () => {
			if (activeAssistantView) {
				activeAssistantView.webview.postMessage({
					type: 'mcpStatus',
					running: ok,
					url: ok ? `${mcpServerHost}:${mcpServerPort}` : ''
				});
			}
		});
	});
	req.on('error', () => {
		if (activeAssistantView) {
			activeAssistantView.webview.postMessage({ type: 'mcpStatus', running: false, url: '' });
		}
	});
}

function startMcpStatusPolling(): void {
	if (mcpPollTimer !== undefined) { return; }
	pollMcpHealth();
	mcpPollTimer = setInterval(pollMcpHealth, 10000);
}

export function deactivate(): void {
	stopMcpServer();
}

class Stm32AssistantViewProvider implements vscode.WebviewViewProvider {
	public constructor(private readonly extensionUri: vscode.Uri) {
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		activeAssistantView = webviewView;
		webviewView.onDidDispose(() => { activeAssistantView = undefined; });
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async message => {
			if (!isRecord(message) || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'openChat':
					await openStm32Chat();
					break;
				case 'semiAuto':
					await runSemiAutoFlow();
					break;
				case 'autoUntilFlash':
					await runAutoUntilFlash();
					break;
				case 'fullAuto':
					await runFullAutoFlow();
					break;
				case 'fixBuild':
					await fixBuildErrorWithAi();
					break;
				case 'hardFault':
					await analyzeHardFaultWithAi();
					break;
				case 'startMcp':
					try {
						if (!extensionContextRef) {
							throw new Error('extension context unavailable');
						}
						await startMcpServer(extensionContextRef);
						webviewView.webview.postMessage({ type: 'status', message: `MCP server starting: http://${mcpServerHost}:${mcpServerPort}/mcp` });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						assistantOutput.appendLine(`[STM32-AI] MCP start failed: ${message}`);
						webviewView.webview.postMessage({ type: 'status', message: `MCP server start failed: ${message}` });
						vscode.window.showErrorMessage(vscode.l10n.t('Failed to start MCP server: {0}', message));
					}
					break;
				case 'stopMcp':
					try {
						stopMcpServer();
						webviewView.webview.postMessage({ type: 'status', message: 'MCP server stopped.' });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						assistantOutput.appendLine(`[STM32-AI] MCP stop failed: ${message}`);
						webviewView.webview.postMessage({ type: 'status', message: `MCP server stop failed: ${message}` });
						vscode.window.showErrorMessage(vscode.l10n.t('Failed to stop MCP server: {0}', message));
					}
					break;
			}
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const csp = webview.cspSource;
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>STM32 AI Assistant</title>
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{
			--bg:var(--vscode-editor-background,#0d0e14);
			--sf:var(--vscode-sideBar-background,#13151e);
			--bd:var(--vscode-panel-border,#1e2030);
			--tx:var(--vscode-editor-foreground,#e8eaed);
			--mt:var(--vscode-descriptionForeground,#6b7280);
			--ac:#6366f1;--ac2:rgba(99,102,241,.14);
			--ok:#22c55e;--wn:#f59e0b;--er:#ef4444;
		}
		body{font:12px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);padding:8px 6px;background:var(--sf);color:var(--tx);}
		.sec{margin-bottom:10px}
		.sec-hd{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mt);padding:0 4px 5px}
		.btn{display:flex;align-items:center;gap:7px;width:100%;padding:6px 9px;margin-bottom:3px;background:transparent;border:1px solid var(--bd);border-radius:6px;color:var(--tx);cursor:pointer;font:inherit;text-align:left;transition:background .1s,border-color .1s}
		.btn:hover{background:var(--ac2);border-color:rgba(99,102,241,.45)}
		.btn:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
		.btn.pri{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:600}
		.btn.pri:hover{background:#4f52d9;border-color:#4f52d9}
		.btn.wn{border-color:rgba(245,158,11,.3)}
		.btn.wn:hover{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.6)}
		.ic{width:15px;text-align:center;flex-shrink:0;font-style:normal}
		.lbl{flex:1;font-size:12px}
		.badge{font-size:9px;padding:1px 5px;border-radius:8px;background:var(--ac2);color:var(--ac);font-weight:700;letter-spacing:.03em}
		.mcp-row{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--bd);border-radius:6px;margin-bottom:4px}
		.dot{width:7px;height:7px;border-radius:50%;background:var(--mt);flex-shrink:0;transition:background .3s}
		.dot.on{background:var(--ok);box-shadow:0 0 5px var(--ok)}
		.mcp-info{flex:1;font-size:11px;color:var(--mt);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.mcp-url{color:var(--tx);font-weight:500}
		.mcp-btn{font-size:10px;padding:2px 7px;border-radius:4px;border:1px solid var(--bd);background:transparent;color:var(--mt);cursor:pointer;white-space:nowrap}
		.mcp-btn:hover{color:var(--tx);border-color:var(--tx)}
		#log{padding:6px 8px;border-radius:5px;background:var(--bg);border:1px solid var(--bd);font-size:10.5px;color:var(--mt);font-family:var(--vscode-editor-font-family,monospace);word-break:break-all;min-height:28px;max-height:72px;overflow:auto;line-height:1.4}
	</style>
</head>
<body>

<div class="sec">
	<div class="sec-hd">MCP Server</div>
	<div class="mcp-row">
		<div class="dot" id="mcpDot"></div>
		<div class="mcp-info" id="mcpInfo">Stopped</div>
		<button class="mcp-btn" id="mcpToggle" aria-label="Toggle MCP server">Start</button>
	</div>
</div>

<div class="sec">
	<div class="sec-hd">AI Chat</div>
	<button class="btn pri" id="openChat" aria-label="Open AI Chat">
		<i class="ic">&#x25CE;</i>
		<span class="lbl">Open AI Chat</span>
		<span class="badge">@stm32</span>
	</button>
</div>

<div class="sec">
	<div class="sec-hd">AI Automation</div>
	<button class="btn" id="semiAuto" aria-label="Run semi-auto flow">
		<i class="ic">&#x25B6;</i>
		<span class="lbl">Semi-Auto (Regen &#x2192; Build)</span>
	</button>
	<button class="btn" id="autoUntilFlash" aria-label="Auto until flash">
		<i class="ic">&#x23E9;</i>
		<span class="lbl">Auto Until Flash</span>
	</button>
	<button class="btn wn" id="fullAuto" aria-label="Run full-auto flow">
		<i class="ic">&#x26A1;</i>
		<span class="lbl">Full Auto (&#x2192; Flash &#x2192; Debug)</span>
	</button>
</div>

<div class="sec">
	<div class="sec-hd">AI Diagnostics</div>
	<button class="btn" id="fixBuild" aria-label="Fix build error with AI">
		<i class="ic">&#x1F527;</i>
		<span class="lbl">Fix Build Error with AI</span>
	</button>
	<button class="btn" id="hardFault" aria-label="Analyze HardFault with AI">
		<i class="ic">&#x26A0;</i>
		<span class="lbl">HardFault AI Analysis</span>
	</button>
</div>

<div class="sec">
	<div class="sec-hd">Status</div>
	<div id="log" role="status" aria-live="polite">Ready</div>
</div>

<script>
	const vscode = acquireVsCodeApi();
	let mcpOn = false;
	const mcpDot = document.getElementById('mcpDot');
	const mcpInfo = document.getElementById('mcpInfo');
	const mcpToggle = document.getElementById('mcpToggle');
	const log = document.getElementById('log');

	function setMcp(on, url) {
		mcpOn = on;
		mcpDot.className = 'dot' + (on ? ' on' : '');
		mcpInfo.innerHTML = on
			? 'Running&nbsp;<span class="mcp-url">' + (url||'') + '</span>'
			: 'Stopped';
		mcpToggle.textContent = on ? 'Stop' : 'Start';
	}
	function setLog(msg) { log.textContent = msg; }

	mcpToggle.addEventListener('click', () => {
		if (mcpOn) { vscode.postMessage({type:'stopMcp'}); setLog('Stopping MCP server...'); }
		else { vscode.postMessage({type:'startMcp'}); setLog('Starting MCP server...'); }
	});

	const actionMap = {
		openChat:'AI Chat',semiAuto:'Semi-Auto Flow',autoUntilFlash:'Auto Until Flash',
		fullAuto:'Full Auto Flow',fixBuild:'Build Error AI Fix',hardFault:'HardFault Analysis'
	};
	for (const [id, label] of Object.entries(actionMap)) {
		document.getElementById(id).addEventListener('click', () => {
			setLog('Running ' + label + '...');
			vscode.postMessage({type: id});
		});
	}

	window.addEventListener('message', e => {
		const d = e.data;
		if (!d) return;
		if (d.type === 'status') setLog(String(d.message || ''));
		if (d.type === 'mcpStatus') { setMcp(d.running, d.url); if (d.message) setLog(String(d.message)); }
	});
</script>
</body>
</html>`;
	}
}

const _unusedAssistantViewProviderRef = Stm32AssistantViewProvider;
void _unusedAssistantViewProviderRef;

async function openAssistantPanel(): Promise<void> {
	await vscode.commands.executeCommand('workbench.view.extension.stm32-ai-assistant');
}

const _unusedOpenAssistantPanelRef = openAssistantPanel;
void _unusedOpenAssistantPanelRef;

async function openStm32Chat(extraPrompt?: string): Promise<void> {
	const basePrompt = vscode.workspace.getConfiguration('stm32ai').get<string>('chat.defaultPrompt', 'Review the current STM32 project and suggest next steps.');
	const contextText = await buildStm32ContextSummary();
	const merged = [basePrompt, contextText, extraPrompt ?? ''].filter(Boolean).join('\n\n');
	await vscode.commands.executeCommand('workbench.action.chat.open', { query: merged });
}

async function runSemiAutoFlow(): Promise<void> {
	assistantOutput.appendLine('[STM32-AI] Semi-auto flow started.');

	const includeRegenerate = vscode.workspace.getConfiguration('stm32ai').get<boolean>('autoFlow.includeRegenerate', true);
	if (includeRegenerate) {
		await vscode.commands.executeCommand('stm32.regenerateCode');
	}

	const buildResult = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
	if (!buildResult) {
		assistantOutput.appendLine('[STM32-AI] Build failed. Escalating to AI fix flow.');
		await fixBuildErrorWithAi();
		return;
	}

	assistantOutput.appendLine('[STM32-AI] Semi-auto flow completed.');
	vscode.window.showInformationMessage(vscode.l10n.t('Semi-auto flow completed.'));
}

async function runAutoUntilFlash(): Promise<void> {
	assistantOutput.appendLine('[STM32-AI] Auto-until-flash flow started.');

	const includeRegenerate = vscode.workspace.getConfiguration('stm32ai').get<boolean>('autoFlow.includeRegenerate', true);
	if (includeRegenerate) {
		await vscode.commands.executeCommand('stm32.regenerateCode');
	}

	const buildResult = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
	if (!buildResult) {
		assistantOutput.appendLine('[STM32-AI] Build failed before flash boundary.');
		await fixBuildErrorWithAi();
		return;
	}

	vscode.window.showInformationMessage(vscode.l10n.t('Auto-until-flash completed. Flash manually when ready.'));
	assistantOutput.appendLine('[STM32-AI] Auto-until-flash flow completed.');
}

async function runFullAutoFlow(): Promise<void> {
	assistantOutput.appendLine('[STM32-AI] Full-auto flow started.');

	const includeRegenerate = vscode.workspace.getConfiguration('stm32ai').get<boolean>('autoFlow.includeRegenerate', true);
	if (includeRegenerate) {
		await vscode.commands.executeCommand('stm32.regenerateCode');
	}

	const buildResult = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
	if (!buildResult) {
		assistantOutput.appendLine('[STM32-AI] Build failed. Escalating to AI fix flow.');
		await fixBuildErrorWithAi();
		return;
	}

	const requireFlashConfirmation = vscode.workspace.getConfiguration('stm32ai').get<boolean>('autoFlow.requireFlashConfirmation', true);
	if (requireFlashConfirmation) {
		const proceed = await vscode.window.showWarningMessage(
			vscode.l10n.t('Build succeeded. Proceed with flash?'),
			vscode.l10n.t('Flash Now'),
			vscode.l10n.t('Cancel')
		);
		if (proceed !== vscode.l10n.t('Flash Now')) {
			assistantOutput.appendLine('[STM32-AI] Flash canceled by user confirmation gate.');
			return;
		}
	}

	const flashResult = await vscode.commands.executeCommand<boolean>('stm32.flash');
	if (!flashResult) {
		assistantOutput.appendLine('[STM32-AI] Flash failed.');
		return;
	}

	await vscode.commands.executeCommand('stm32.startDebug');
	assistantOutput.appendLine('[STM32-AI] Full-auto flow completed.');
	vscode.window.showInformationMessage(vscode.l10n.t('Full-auto flow completed.'));
}

async function fixBuildErrorWithAi(): Promise<void> {
	const diagnostics = collectBuildDiagnostics();
	const first = diagnostics[0];
	const prompt = first
		? `Fix the following STM32 build error:\n\n${first}`
		: 'Diagnose the STM32 build error and suggest a fix.';

	const answer = await askModel(prompt);
	if (answer) {
		assistantOutput.appendLine('[STM32-AI] Build fix suggestion generated.');
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# Build Error Auto-Fix\n\n${answer}` });
		await vscode.window.showTextDocument(doc, { preview: false });
		return;
	}

	await openStm32Chat(prompt);
}

async function analyzeHardFaultWithAi(): Promise<void> {
	const cfsr = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter CFSR value (0x format)'), value: '0x00000000' });
	if (!cfsr) {
		return;
	}
	const hfsr = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter HFSR value (0x format)'), value: '0x00000000' });
	if (!hfsr) {
		return;
	}

	const prompt = [
		'Analyze this STM32 HardFault.',
		`CFSR=${cfsr}`,
		`HFSR=${hfsr}`,
		'Return probable causes, prevention steps, and a prioritized investigation procedure.',
	].join('\n');

	const answer = await askModel(prompt);
	if (answer) {
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# HardFault AI Analysis\n\n${answer}` });
		await vscode.window.showTextDocument(doc, { preview: false });
		return;
	}

	await openStm32Chat(prompt);
}

async function ensureMcpServerToken(context: vscode.ExtensionContext): Promise<string> {
	const existing = await context.secrets.get(MCP_TOKEN_SECRET_KEY);
	if (existing && existing.length > 0) {
		return existing;
	}
	const generated = cryptoModule.randomBytes(24).toString('hex');
	await context.secrets.store(MCP_TOKEN_SECRET_KEY, generated);
	return generated;
}

async function startMcpServer(context: vscode.ExtensionContext, takeoverAttempt = 0): Promise<void> {
	if (mcpServerRunning || mcpServerStarting) {
		return;
	}
	if (mcpServer) {
		try {
			mcpServer.close();
		} catch {
			// ignore stale close errors
		}
		mcpServer = undefined;
	}
	mcpServerStarting = true;

	mcpServerHost = vscode.workspace.getConfiguration('stm32ai').get<string>('mcp.host', '127.0.0.1');
	mcpServerPort = vscode.workspace.getConfiguration('stm32ai').get<number>('mcp.port', 3737);
	mcpRequireAuth = vscode.workspace.getConfiguration('stm32ai').get<boolean>('mcp.requireAuth', false);
	const token = await ensureMcpServerToken(context);

	const server = httpModule.createServer((req, res) => {
		void handleMcpHttpRequest(req, res, token).catch(error => {
			logAiError('handleMcpHttpRequest', error);
			writeJson(res, 500, { error: { code: -32000, message: 'Internal MCP server error' } });
		});
	});
	mcpServer = server;

	server.on('error', error => {
		mcpServerStarting = false;
		mcpServerRunning = false;
		if (mcpServer === server) {
			mcpServer = undefined;
		}
		const anyError = error as Error & { code?: string };
		assistantOutput.appendLine(`[STM32-AI] MCP server error: ${anyError.message}`);
		if (anyError.code === 'EADDRINUSE') {
			if (!mcpTakeoverInProgress && takeoverAttempt < 3) {
				mcpTakeoverInProgress = true;
				void forceTakeoverAndRestart(context, takeoverAttempt + 1)
					.catch(restartError => {
						logAiError('forceTakeoverAndRestart', restartError);
					})
					.finally(() => {
						mcpTakeoverInProgress = false;
					});
				return;
			}
			vscode.window.showErrorMessage(vscode.l10n.t('MCP server failed to start: could not release port ({0}:{1}).', mcpServerHost, String(mcpServerPort)));
			return;
		}
		vscode.window.showErrorMessage(vscode.l10n.t('MCP server encountered an error. Check the output log.'));
	});

	server.listen(mcpServerPort, mcpServerHost, () => {
		mcpServerStarting = false;
		mcpServerRunning = true;
		const url = `http://${mcpServerHost}:${mcpServerPort}/mcp`;
		assistantOutput.appendLine(`[STM32-AI] MCP server started at ${url}`);
		activeAssistantView?.webview.postMessage({ type: 'mcpStatus', running: true, url, message: `MCP server started: ${url}` });
	});
}

async function forceTakeoverAndRestart(context: vscode.ExtensionContext, nextAttempt: number): Promise<void> {
	assistantOutput.appendLine(`[STM32-AI] MCP takeover attempt ${String(nextAttempt)} on ${mcpServerHost}:${String(mcpServerPort)}`);

	const alive = await isMcpHealthReachable(mcpServerHost, mcpServerPort, 900);
	if (alive) {
		mcpServerRunning = true;
		mcpServerStarting = false;
		const url = `http://${mcpServerHost}:${mcpServerPort}/mcp`;
		assistantOutput.appendLine(`[STM32-AI] Reusing running MCP at ${url}`);
		activeAssistantView?.webview.postMessage({ type: 'mcpStatus', running: true, url, message: `Reusing existing MCP at: ${url}` });
		return;
	}

	const pids = await findListeningPidsOnPort(mcpServerPort);
	if (pids.length === 0) {
		assistantOutput.appendLine('[STM32-AI] Port is reported in use but no PID was resolved. Retrying start.');
		await waitMs(250);
		await startMcpServer(context, nextAttempt);
		return;
	}

	assistantOutput.appendLine(`[STM32-AI] Force-stopping MCP port occupants: ${pids.join(', ')}`);
	for (const pid of pids) {
		await killPid(pid);
	}

	await waitMs(300);
	await startMcpServer(context, nextAttempt);
}

async function isMcpHealthReachable(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
	return await new Promise<boolean>(resolve => {
		const req = httpModule.get(`http://${host}:${String(port)}/health`, res => {
			res.on('data', () => undefined);
			res.on('end', () => resolve((res.statusCode ?? 0) > 0));
		});
		req.on('error', () => resolve(false));
		setTimeout(() => resolve(false), timeoutMs);
		req.end();
	});
}

async function findListeningPidsOnPort(port: number): Promise<number[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	try {
		const result = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], undefined);
		const pids = new Set<number>();
		for (const line of result.stdout.split(/\r?\n/u)) {
			if (!line.includes('LISTENING') || !line.includes(`:${String(port)}`)) {
				continue;
			}
			const parts = line.trim().split(/\s+/u);
			const pid = Number(parts[parts.length - 1]);
			if (Number.isFinite(pid) && pid > 0) {
				pids.add(pid);
			}
		}
		return Array.from(pids);
	} catch {
		return [];
	}
}

async function killPid(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		try {
			await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], undefined);
		} catch {
			// ignore
		}
	}
}

async function waitMs(ms: number): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, ms));
}

function stopMcpServer(): void {
	if (!mcpServer && !mcpServerStarting && !mcpServerRunning) {
		return;
	}

	for (const session of sseSessions.values()) {
		session.end();
	}
	sseSessions.clear();

	if (mcpServer) {
		mcpServer.close();
		mcpServer = undefined;
	}
	mcpServerStarting = false;
	mcpServerRunning = false;
	assistantOutput.appendLine('[STM32-AI] MCP server stopped.');
	activeAssistantView?.webview.postMessage({ type: 'mcpStatus', running: false, url: '', message: 'MCP server stopped.' });
}

async function handleMcpHttpRequest(req: IncomingMessageLike, res: ServerResponseLike, token: string): Promise<void> {
	const parsedUrl = new URL(req.url ?? '/', `http://${mcpServerHost}:${mcpServerPort}`);

	if (req.method === 'GET' && parsedUrl.pathname === '/health') {
		writeJson(res, 200, { status: 'ok' });
		return;
	}

	if (req.method === 'GET' && (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/mcp/sse')) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
		});

		const sessionId = cryptoModule.randomBytes(16).toString('hex');
		sseSessions.set(sessionId, res);
		sendSseEvent(res, 'endpoint', `/messages?sessionId=${sessionId}`);
		sendSseEvent(res, 'ready', { sessionId });

		res.on?.('close', () => {
			sseSessions.delete(sessionId);
		});
		return;
	}

	if (req.method === 'POST' && (parsedUrl.pathname === '/messages' || parsedUrl.pathname === '/mcp/messages')) {
		const sessionId = parsedUrl.searchParams.get('sessionId') ?? '';
		const session = sseSessions.get(sessionId);
		if (!session) {
			writeJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32004, message: 'Unknown SSE session' } });
			return;
		}

		const body = await readRequestBody(req);
		let payload: JsonRpcRequest;
		try {
			payload = JSON.parse(body) as JsonRpcRequest;
		} catch {
			writeJson(res, 400, { error: { code: -32700, message: 'Invalid JSON' } });
			return;
		}

		const id = payload.id ?? null;
		try {
			const result = await executeMcpMethod(payload.method, payload.params);
			sendSseEvent(session, 'message', { jsonrpc: '2.0', id, result });
			res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendSseEvent(session, 'message', { jsonrpc: '2.0', id, error: { code: -32000, message } });
			res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true }));
		}
		return;
	}

	if (req.method !== 'POST' || parsedUrl.pathname !== '/mcp') {
		writeJson(res, 404, { error: { code: -32004, message: 'Not found' } });
		return;
	}

	const authorizationHeader = readHeader(req.headers, 'authorization');
	if (mcpRequireAuth && authorizationHeader !== `Bearer ${token}`) {
		writeJson(res, 401, { error: { code: -32001, message: 'Unauthorized' } });
		return;
	}

	const body = await readRequestBody(req);
	let payload: JsonRpcRequest;
	try {
		payload = JSON.parse(body) as JsonRpcRequest;
	} catch {
		writeJson(res, 400, { error: { code: -32700, message: 'Invalid JSON' } });
		return;
	}

	const id = payload.id ?? null;
	try {
		const result = await executeMcpMethod(payload.method, payload.params);
		writeJson(res, 200, { jsonrpc: '2.0', id, result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeJson(res, 500, { jsonrpc: '2.0', id, error: { code: -32000, message } });
	}
}

function sendSseEvent(res: ServerResponseLike, event: string, data: unknown): void {
	if (!res.write) {
		return;
	}
	const payload = typeof data === 'string' ? data : JSON.stringify(data);
	res.write(`event: ${event}\n`);
	res.write(`data: ${payload}\n\n`);
}

async function executeMcpMethod(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
	if (method === 'initialize') {
		return {
			protocolVersion: '2024-11-05',
			capabilities: { tools: {} },
			serverInfo: { name: 'stm32-ai-mcp', version: '1.0.0' },
		};
	}
	if (method === 'notifications/initialized') {
		return null;
	}
	if (method === 'ping') {
		return { ok: true };
	}

	if (method === 'tools/call') {
		const name = typeof params?.name === 'string' ? params.name : '';
		const argumentsValue = isRecord(params?.arguments) ? params.arguments : undefined;
		if (!name) {
			throw new Error('tools/call requires params.name');
		}
		const result = await executeMcpMethod(name, argumentsValue);
		return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
	}

	switch (method) {
		case 'tools/list':
			return {
				tools: [
					{ name: 'stm32.build' },
					{ name: 'stm32.flash' },
					{ name: 'stm32.buildAndFlash' },
					{ name: 'stm32.startDebug' },
					{ name: 'stm32.stopDebug' },
					{ name: 'stm32.newProject' },
					{ name: 'stm32.importCubeIDE' },
					{ name: 'stm32.regenerateCode' },
					{ name: 'stm32.openBoardConfigurator' },
					{ name: 'stm32.openPinVisualizer' },
					{ name: 'stm32.runEnvironmentCheck' },
					{ name: 'stm32.syncMcuCatalog' },
					{ name: 'stm32.refreshRegisters' },
					{ name: 'stm32.mcp.start' },
					{ name: 'stm32.mcp.stop' },
					{ name: 'stm32.analyzeHardFault' },
				]
			};
		case 'stm32.mcp.start': {
			if (extensionContextRef) {
				await startMcpServer(extensionContextRef);
			}
			return { success: true };
		}
		case 'stm32.mcp.stop': {
			stopMcpServer();
			return { success: true };
		}
		case 'stm32.build': {
			const ok = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
			return { success: Boolean(ok) };
		}
		case 'stm32.flash': {
			const ok = await vscode.commands.executeCommand<boolean>('stm32.flash');
			return { success: Boolean(ok) };
		}
		case 'stm32.buildAndFlash': {
			await vscode.commands.executeCommand('stm32.buildAndFlash');
			return { success: true };
		}
		case 'stm32.startDebug': {
			await vscode.commands.executeCommand('stm32.startDebug');
			return { success: true };
		}
		case 'stm32.stopDebug': {
			await vscode.commands.executeCommand('stm32.stopDebug');
			return { success: true };
		}
		case 'stm32.newProject': {
			await vscode.commands.executeCommand('stm32.newProject');
			return { success: true };
		}
		case 'stm32.importCubeIDE': {
			await vscode.commands.executeCommand('stm32.importCubeIDE');
			return { success: true };
		}
		case 'stm32.regenerateCode': {
			await vscode.commands.executeCommand('stm32.regenerateCode');
			return { success: true };
		}
		case 'stm32.openBoardConfigurator': {
			await vscode.commands.executeCommand('stm32ux.openBoardConfigurator');
			return { success: true };
		}
		case 'stm32.openPinVisualizer': {
			await vscode.commands.executeCommand('stm32ux.openPinVisualizer');
			return { success: true };
		}
		case 'stm32.runEnvironmentCheck': {
			await vscode.commands.executeCommand('stm32ux.runEnvironmentCheck');
			return { success: true };
		}
		case 'stm32.syncMcuCatalog': {
			await vscode.commands.executeCommand('stm32ux.syncMcuCatalogFromCubeMX');
			return { success: true };
		}
		case 'stm32.refreshRegisters': {
			await vscode.commands.executeCommand('stm32.debug.refreshRegisters');
			return { success: true };
		}
		case 'stm32.analyzeHardFault': {
			const cfsr = typeof params?.cfsr === 'string' ? params.cfsr : '0x00000000';
			const hfsr = typeof params?.hfsr === 'string' ? params.hfsr : '0x00000000';
			const answer = await askModel(`Analyze this STM32 HardFault.\nCFSR=${cfsr}\nHFSR=${hfsr}`);
			return { success: true, analysis: answer ?? '' };
		}
		default:
			throw new Error(`Unknown method: ${method}`);
	}
}

function readHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
	const value = headers[key];
	if (Array.isArray(value)) {
		return value[0] ?? '';
	}
	return value ?? '';
}

function readRequestBody(req: IncomingMessageLike): Promise<string> {
	return new Promise(resolve => {
		let text = '';
		req.on('data', chunk => {
			text += String(chunk);
		});
		req.on('end', () => resolve(text));
	});
}

function execFileAsync(command: string, args: string[], cwd: string | undefined): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const needsShell = command.endsWith('.bat') || command.endsWith('.sh');
		childProcess.execFile(command, args, { cwd, shell: needsShell }, (error, stdout, stderr) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function writeJson(res: ServerResponseLike, statusCode: number, data: unknown): void {
	res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(data));
}

function registerLanguageModelTools(context: vscode.ExtensionContext): void {
	if (!lmApi?.registerTool) {
		assistantOutput.appendLine('[STM32-AI] vscode.lm.registerTool is unavailable in this runtime.');
		return;
	}

	context.subscriptions.push(lmApi.registerTool<{}>('stm32Build', {
		invoke: async () => {
			const ok = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
			return toToolResult(ok ? 'Build succeeded.' : 'Build failed.');
		}
	}));

	context.subscriptions.push(lmApi.registerTool<{}>('stm32Flash', {
		invoke: async () => {
			const ok = await vscode.commands.executeCommand<boolean>('stm32.flash');
			return toToolResult(ok ? 'Flash succeeded.' : 'Flash failed.');
		}
	}));

	context.subscriptions.push(lmApi.registerTool<{}>('stm32RegenerateCode', {
		invoke: async () => {
			await vscode.commands.executeCommand('stm32.regenerateCode');
			return toToolResult('Code regeneration requested.');
		}
	}));

	context.subscriptions.push(lmApi.registerTool<{ cfsr: string; hfsr: string }>('stm32AnalyzeHardFault', {
		invoke: async options => {
			const prompt = `Analyze this STM32 HardFault.\nCFSR=${options.input.cfsr}\nHFSR=${options.input.hfsr}`;
			const answer = await askModel(prompt);
			return toToolResult(answer ?? 'No language model available.');
		}
	}));
}

function registerChatParticipant(context: vscode.ExtensionContext): void {
	if (!chatApi?.createChatParticipant) {
		assistantOutput.appendLine('[STM32-AI] chat participant API is unavailable in this runtime.');
		return;
	}

	const participant = chatApi.createChatParticipant('stm32ai', async (request, _context, stream) => {
		const command = getChatRequestCommand(request);
		const prompt = getChatRequestPrompt(request);
		switch (command) {
			case 'build': {
				const ok = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
				stream.markdown(ok ? 'Build succeeded.' : 'Build failed.');
				return { metadata: { participant: 'stm32ai', command } };
			}
			case 'flash': {
				const ok = await vscode.commands.executeCommand<boolean>('stm32.flash');
				stream.markdown(ok ? 'Flash succeeded.' : 'Flash failed.');
				return { metadata: { participant: 'stm32ai', command } };
			}
			case 'debug': {
				await vscode.commands.executeCommand('stm32.startDebug');
				stream.markdown('Debug session requested.');
				return { metadata: { participant: 'stm32ai', command } };
			}
			case 'explain': {
				const selection = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection) ?? '';
				const answer = await askModel(`Explain the following STM32 code:\n\n${selection}`);
				stream.markdown(answer ?? 'No model response.');
				return { metadata: { participant: 'stm32ai', command } };
			}
			case 'hardfault': {
				const answer = await askModel(`Analyze this STM32 HardFault.\n${prompt}`);
				stream.markdown(answer ?? 'No model response.');
				return { metadata: { participant: 'stm32ai', command } };
			}
			default: {
				stream.markdown('STM32 AI participant is ready. Commands: /build /flash /debug /explain /hardfault');
				return { metadata: { participant: 'stm32ai' } };
			}
		}
	});
	context.subscriptions.push(participant);
}

const _unusedRegisterChatParticipantRef = registerChatParticipant;
void _unusedRegisterChatParticipantRef;

function collectBuildDiagnostics(): string[] {
	const lines: string[] = [];
	for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
		for (const diag of diagnostics) {
			if (diag.severity !== vscode.DiagnosticSeverity.Error) {
				continue;
			}
			lines.push(`${uri.fsPath}:${diag.range.start.line + 1}:${diag.range.start.character + 1} ${diag.message}`);
		}
	}
	return lines;
}

async function askModel(prompt: string): Promise<string | undefined> {
	if (!lmApi?.selectChatModels) {
		return undefined;
	}

	const models = await lmApi.selectChatModels();
	if (!models || models.length === 0) {
		return undefined;
	}

	const response = await models[0].sendRequest([vscode.LanguageModelChatMessage.User(prompt)]);
	let text = '';
	for await (const chunk of response.text) {
		text += chunk;
	}
	return text.trim().length > 0 ? text : undefined;
}

async function buildStm32ContextSummary(): Promise<string> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	const name = workspaceFolder?.name ?? '-';
	const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '-';
	const diagnosticsCount = vscode.languages.getDiagnostics().reduce((sum, [, diagnostics]) => sum + diagnostics.length, 0);
	return [
		'[STM32 Context]',
		`workspace=${name}`,
		`activeFile=${activeFile}`,
		`diagnostics=${diagnosticsCount}`,
	].join('\n');
}

function toToolResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function getChatRequestCommand(request: unknown): string {
	if (!isRecord(request) || !isRecord(request.request)) {
		return '';
	}
	const value = request.request.command;
	return typeof value === 'string' ? value.toLowerCase() : '';
}

function getChatRequestPrompt(request: unknown): string {
	if (!isRecord(request) || !isRecord(request.request)) {
		return '';
	}
	const value = request.request.prompt;
	return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
