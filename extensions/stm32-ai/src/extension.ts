/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;

const httpModule = require('http') as {
	createServer: (handler: (req: IncomingMessageLike, res: ServerResponseLike) => void) => HttpServerLike;
};
const cryptoModule = require('crypto') as {
	randomBytes: (size: number) => { toString: (encoding: string) => string };
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

const MCP_TOKEN_SECRET_KEY = 'stm32ai.mcp.token';

export function activate(context: vscode.ExtensionContext): void {
	extensionContextRef = context;
	assistantOutput = vscode.window.createOutputChannel('STM32 AI');
	context.subscriptions.push(assistantOutput);

	const viewProvider = new Stm32AssistantViewProvider(context.extensionUri);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('stm32-ai.assistantView', viewProvider));

	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.openAssistantPanel', () => openAssistantPanel()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.openChat', () => openStm32Chat()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.runSemiAutoFlow', () => runSemiAutoFlow()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.runAutoUntilFlash', () => runAutoUntilFlash()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.runFullAutoFlow', () => runFullAutoFlow()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.fixBuildError', () => fixBuildErrorWithAi()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.analyzeHardFault', () => analyzeHardFaultWithAi()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.startMcpServer', () => startMcpServer(context)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ai.stopMcpServer', () => stopMcpServer()));
	context.subscriptions.push({ dispose: () => void stopMcpServer() });

	registerLanguageModelTools(context);
	registerChatParticipant(context);

	void ensureMcpServerToken(context);
	const autoStartServer = vscode.workspace.getConfiguration('stm32ai').get<boolean>('mcp.autoStartServer', true);
	if (autoStartServer) {
		void startMcpServer(context);
	}
}

export function deactivate(): void {
	stopMcpServer();
}

class Stm32AssistantViewProvider implements vscode.WebviewViewProvider {
	public constructor(private readonly extensionUri: vscode.Uri) {
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
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
					if (extensionContextRef) {
						await startMcpServer(extensionContextRef);
						webviewView.webview.postMessage({ type: 'status', message: `MCPサーバー起動中: http://${mcpServerHost}:${mcpServerPort}/mcp` });
					}
					break;
				case 'stopMcp':
					stopMcpServer();
					webviewView.webview.postMessage({ type: 'status', message: 'MCPサーバーを停止しました。' });
					break;
			}
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const csp = webview.cspSource;
		return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>STM32 AI Assistant</title>
	<style>
		body { font: 13px/1.5 var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
		h1 { font-size: 14px; margin: 0 0 10px; }
		.buttons { display: grid; gap: 8px; }
		button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: 1px solid transparent;
			padding: 8px;
			border-radius: 6px;
			cursor: pointer;
			text-align: left;
		}
		button.secondary {
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			border-color: var(--vscode-panel-border);
		}
		#status { min-height: 1.2em; margin-top: 8px; color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<h1>STM32 AI Assistant</h1>
	<div class="buttons" role="group" aria-label="STM32 AI actions">
		<button id="openChat" aria-label="AIチャットを開く">AIチャットを開く</button>
		<button id="semiAuto" aria-label="半自動フローを実行">半自動フロー (再生成→ビルド)</button>
		<button id="autoUntilFlash" aria-label="書込み直前まで自動実行">書込み直前まで自動 (再生成→ビルド)</button>
		<button id="fullAuto" aria-label="全自動フローを実行">全自動フロー (再生成→ビルド→書込み→デバッグ)</button>
		<button id="fixBuild" aria-label="ビルドエラーをAIで修正">ビルドエラーをAIで修正</button>
		<button id="hardFault" aria-label="HardFaultをAI解析">HardFaultをAI解析</button>
		<button id="startMcp" aria-label="MCPサーバーを起動" class="secondary">MCPサーバーを起動</button>
		<button id="stopMcp" aria-label="MCPサーバーを停止" class="secondary">MCPサーバーを停止</button>
	</div>
	<p id="status" role="status" aria-live="polite"></p>
	<script>
		const vscode = acquireVsCodeApi();
		for (const id of ['openChat','semiAuto','autoUntilFlash','fullAuto','fixBuild','hardFault','startMcp','stopMcp']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
		window.addEventListener('message', event => {
			if (event.data?.type === 'status') {
				document.getElementById('status').textContent = String(event.data.message || '');
			}
		});
	</script>
</body>
</html>`;
	}
}

async function openAssistantPanel(): Promise<void> {
	await vscode.commands.executeCommand('workbench.view.extension.stm32-ai-assistant');
}

async function openStm32Chat(extraPrompt?: string): Promise<void> {
	const basePrompt = vscode.workspace.getConfiguration('stm32ai').get<string>('chat.defaultPrompt', '現在のSTM32プロジェクトをレビューして、次の作業を提案してください。');
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
	vscode.window.showInformationMessage(vscode.l10n.t('半自動フローが完了しました。'));
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

	vscode.window.showInformationMessage(vscode.l10n.t('書込み直前まで完了しました。書込みは手動で実行してください。'));
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
			vscode.l10n.t('ビルドが成功しました。書込みを実行しますか？'),
			vscode.l10n.t('書込みを実行'),
			vscode.l10n.t('キャンセル')
		);
		if (proceed !== vscode.l10n.t('書込みを実行')) {
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
	vscode.window.showInformationMessage(vscode.l10n.t('全自動フローが完了しました。'));
}

async function fixBuildErrorWithAi(): Promise<void> {
	const diagnostics = collectBuildDiagnostics();
	const first = diagnostics[0];
	const prompt = first
		? `以下のビルドエラーを修正してください。\n\n${first}`
		: 'STM32ビルドエラーの原因を推定し、修正手順を提案してください。';

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
	const cfsr = await vscode.window.showInputBox({ prompt: vscode.l10n.t('CFSR値を入力 (0x形式)'), value: '0x00000000' });
	if (!cfsr) {
		return;
	}
	const hfsr = await vscode.window.showInputBox({ prompt: vscode.l10n.t('HFSR値を入力 (0x形式)'), value: '0x00000000' });
	if (!hfsr) {
		return;
	}

	const prompt = [
		'STM32 HardFaultを解析してください。',
		`CFSR=${cfsr}`,
		`HFSR=${hfsr}`,
		'原因候補、再現防止策、優先順位付きの調査手順を返してください。',
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

async function startMcpServer(context: vscode.ExtensionContext): Promise<void> {
	if (mcpServer) {
		return;
	}

	mcpServerHost = vscode.workspace.getConfiguration('stm32ai').get<string>('mcp.host', '127.0.0.1');
	mcpServerPort = vscode.workspace.getConfiguration('stm32ai').get<number>('mcp.port', 3737);
	const token = await ensureMcpServerToken(context);

	mcpServer = httpModule.createServer((req, res) => {
		void handleMcpHttpRequest(req, res, token);
	});

	mcpServer.on('error', error => {
		assistantOutput.appendLine(`[STM32-AI] MCP server error: ${error.message}`);
		vscode.window.showErrorMessage(vscode.l10n.t('MCPサーバーでエラーが発生しました。出力を確認してください。'));
	});

	mcpServer.listen(mcpServerPort, mcpServerHost, () => {
		assistantOutput.appendLine(`[STM32-AI] MCP server started at http://${mcpServerHost}:${mcpServerPort}/mcp`);
	});
}

function stopMcpServer(): void {
	if (!mcpServer) {
		return;
	}

	mcpServer.close();
	mcpServer = undefined;
	assistantOutput.appendLine('[STM32-AI] MCP server stopped.');
}

async function handleMcpHttpRequest(req: IncomingMessageLike, res: ServerResponseLike, token: string): Promise<void> {
	if (req.method !== 'POST' || req.url !== '/mcp') {
		writeJson(res, 404, { error: { code: -32004, message: 'Not found' } });
		return;
	}

	const authorizationHeader = readHeader(req.headers, 'authorization');
	if (authorizationHeader !== `Bearer ${token}`) {
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

async function executeMcpMethod(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
	switch (method) {
		case 'tools/list':
			return {
				tools: [
					{ name: 'stm32.build' },
					{ name: 'stm32.flash' },
					{ name: 'stm32.regenerateCode' },
					{ name: 'stm32.analyzeHardFault' },
				]
			};
		case 'stm32.build': {
			const ok = await vscode.commands.executeCommand<boolean>('stm32.buildDebug');
			return { success: Boolean(ok) };
		}
		case 'stm32.flash': {
			const ok = await vscode.commands.executeCommand<boolean>('stm32.flash');
			return { success: Boolean(ok) };
		}
		case 'stm32.regenerateCode': {
			await vscode.commands.executeCommand('stm32.regenerateCode');
			return { success: true };
		}
		case 'stm32.analyzeHardFault': {
			const cfsr = typeof params?.cfsr === 'string' ? params.cfsr : '0x00000000';
			const hfsr = typeof params?.hfsr === 'string' ? params.hfsr : '0x00000000';
			const answer = await askModel(`STM32 HardFaultを解析してください。\nCFSR=${cfsr}\nHFSR=${hfsr}`);
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
			const prompt = `STM32 HardFault解析\nCFSR=${options.input.cfsr}\nHFSR=${options.input.hfsr}`;
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
				const answer = await askModel(`次のSTM32コードを説明してください。\n\n${selection}`);
				stream.markdown(answer ?? 'No model response.');
				return { metadata: { participant: 'stm32ai', command } };
			}
			case 'hardfault': {
				const answer = await askModel(`STM32 HardFaultを解析してください。\n${prompt}`);
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
