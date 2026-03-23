/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => any;

type DirentLike = {
	name: string;
	isFile: () => boolean;
	isDirectory: () => boolean;
};

const fsModule = require('fs') as {
	constants: { F_OK: number };
	promises: {
		access: (path: string, mode?: number) => Promise<void>;
		mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
		readFile: (path: string, encoding: string) => Promise<string>;
		readdir: (path: string, options?: unknown) => Promise<DirentLike[]>;
		unlink: (path: string) => Promise<void>;
		writeFile: (path: string, data: string, encoding: string) => Promise<void>;
	};
};

const pathModule = require('path') as {
	basename: (path: string) => string;
	extname: (path: string) => string;
	isAbsolute: (path: string) => boolean;
	join: (...parts: string[]) => string;
	relative: (from: string, to: string) => string;
	resolve: (...parts: string[]) => string;
};

const osModule = require('os') as { tmpdir: () => string };

const fs = fsModule.promises;
const basename = pathModule.basename;
const extname = pathModule.extname;
const isAbsolute = pathModule.isAbsolute;
const join = pathModule.join;
const relative = pathModule.relative;
const resolve = pathModule.resolve;
const tmpdir = osModule.tmpdir;

const IOC_EDITOR_VIEW_TYPE = 'stm32.iocEditor';

type CliRunner = (command: string, args: string[], cwd: string, title: string) => Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>;

interface Phase2Dependencies {
	outputChannel: vscode.OutputChannel;
	getWorkspaceRoot: () => string | undefined;
	findTopLevelIocFile: (workspaceRoot: string) => Promise<string | undefined>;
	openCubeMx: () => Promise<void>;
	runCli: CliRunner;
}

interface UserCodeSnapshot {
	sectionsByFile: Map<string, Map<string, string>>;
}

interface ParsedSection {
	name: string;
	content: string;
}

interface IocSummary {
	mcu: string;
	board: string;
	projectName: string;
	usedPeripherals: string[];
	clockHints: string[];
}

interface MapSectionSummary {
	name: string;
	size: number;
}

interface SymbolSummary {
	name: string;
	size: number;
}

interface RegisterInfo {
	name: string;
	description: string;
	addressHex: string;
	evaluationExpression: string;
}

interface PeripheralInfo {
	name: string;
	description: string;
	registers: RegisterInfo[];
}

type RegisterTreeElement =
	| {
		kind: 'peripheral';
		label: string;
		description: string;
		children: RegisterTreeElement[];
	}
	| {
		kind: 'register';
		label: string;
		description: string;
		addressHex: string;
		evaluationExpression: string;
	};

type LiveExpressionElement = {
	expression: string;
};

interface SwvRuntimeState {
	running: boolean;
	lastSessionId: string;
	lines: string[];
}

let swvOutputChannel: vscode.OutputChannel | undefined;
const swvState: SwvRuntimeState = {
	running: false,
	lastSessionId: '',
	lines: [],
};

class IocCustomEditorProvider implements vscode.CustomTextEditorProvider {
	public constructor(private readonly dependencies: Phase2Dependencies) {
	}

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

		const updateWebview = (): void => {
			const text = document.getText();
			const summary = parseIocSummary(text);
			webviewPanel.webview.postMessage({
				type: 'update',
				iocText: text,
				summary,
			});
		};

		const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
			if (event.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		webviewPanel.onDidDispose(() => {
			documentChangeSubscription.dispose();
		});

		webviewPanel.webview.onDidReceiveMessage(async message => {
			const messageType = isRecord(message) ? message.type : undefined;
			if (messageType === 'save') {
				const text = isRecord(message) && typeof message.iocText === 'string' ? message.iocText : '';
				await this.saveDocument(document, text);
				return;
			}
			if (messageType === 'openCubeMx') {
				await this.dependencies.openCubeMx();
				return;
			}
			if (messageType === 'regenerateCode') {
				await vscode.commands.executeCommand('stm32.regenerateCode', document.uri);
				return;
			}
			if (messageType === 'previewDiff') {
				await vscode.commands.executeCommand('stm32.ioc.previewDiff', document.uri);
			}
		});

		updateWebview();
	}

	private async saveDocument(document: vscode.TextDocument, newText: string): Promise<void> {
		const fullRange = fullDocumentRange(document);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, fullRange, newText);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to save from IOC Editor.'));
			return;
		}
		await document.save();
		vscode.window.setStatusBarMessage(vscode.l10n.t('IOC file saved.'), 2000);
	}

	private getHtml(webview: vscode.Webview): string {
		const noneLabel = vscode.l10n.t('None');
		const csp = webview.cspSource;
		const i18n = {
			openCubeMx: vscode.l10n.t('Launch CubeMX'),
			regenerateCode: vscode.l10n.t('Regenerate Code'),
			previewDiff: vscode.l10n.t('Preview Diff'),
			unsavedChanges: vscode.l10n.t('Unsaved changes'),
			save: vscode.l10n.t('Save'),
			projectOverview: vscode.l10n.t('Project Overview'),
			projectInfo: vscode.l10n.t('Project Info'),
			board: vscode.l10n.t('Board'),
			project: vscode.l10n.t('Project'),
			enabledPeripherals: vscode.l10n.t('Enabled Peripherals'),
			clockSettings: vscode.l10n.t('Clock Settings'),
			iocContent: vscode.l10n.t('IOC file content'),
			lines: vscode.l10n.t('{0} lines'),
		};
		const i18nJson = JSON.stringify(i18n);
		const lang = vscode.env.language.split('-')[0] ?? 'en';

		return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>IOC Editor</title>
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{
			--bg:var(--vscode-editor-background,#0d0e14);
			--sf:var(--vscode-sideBar-background,#13151e);
			--bd:var(--vscode-panel-border,#1e2030);
			--tx:var(--vscode-editor-foreground,#e8eaed);
			--mt:var(--vscode-descriptionForeground,#6b7280);
			--ac:#6366f1;--ac2:rgba(99,102,241,.12);
			--ok:#22c55e;--wn:#f59e0b;
			--font-mono:var(--vscode-editor-font-family,monospace);
		}
		body{font:13px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);height:100vh;display:flex;flex-direction:column;overflow:hidden}
		.topbar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--bd);background:var(--sf);flex-shrink:0;flex-wrap:wrap}
		.topbar-title{font-size:13px;font-weight:600;margin-right:4px}
		.topbar-mcu{font-size:11px;color:var(--mt);font-family:var(--font-mono);background:var(--bg);border:1px solid var(--bd);border-radius:4px;padding:2px 7px}
		.spacer{flex:1}
		.btn{padding:5px 12px;border-radius:5px;cursor:pointer;font:600 11px/1 var(--vscode-font-family,'Segoe UI',sans-serif);border:1px solid transparent;transition:background .1s}
		.btn:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
		.btn-pri{background:var(--ac);color:#fff}
		.btn-pri:hover{background:#4f52d9}
		.btn-sec{background:transparent;border-color:var(--bd);color:var(--tx)}
		.btn-sec:hover{background:var(--ac2);border-color:rgba(99,102,241,.4)}
		.btn-ok{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.4);color:var(--ok)}
		.btn-ok:hover{background:rgba(34,197,94,.25)}
		.layout{display:grid;grid-template-columns:280px 1fr;flex:1;overflow:hidden}
		@media(max-width:780px){.layout{grid-template-columns:1fr}}
		.sidebar{border-right:1px solid var(--bd);overflow-y:auto;padding:12px}
		.sec-hd{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--mt);margin:12px 0 6px}
		.sec-hd:first-child{margin-top:0}
		.info-row{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--bd)}
		.info-row:last-child{border-bottom:none}
		.info-key{color:var(--mt);font-size:12px}
		.info-val{font-size:12px;font-weight:600;max-width:55%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.badge-list{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
		.badge{font-size:10px;padding:2px 6px;border-radius:4px;background:var(--ac2);color:var(--ac);font-weight:600}
		.badge.clock{background:rgba(245,158,11,.12);color:var(--wn)}
		.editor-pane{display:flex;flex-direction:column;overflow:hidden}
		.editor-toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--bd);background:var(--sf);flex-shrink:0}
		.editor-label{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mt)}
		.editor-spacer{flex:1}
		textarea{flex:1;width:100%;border:none;background:var(--bg);color:var(--tx);font:12px/1.6 var(--font-mono);padding:12px;resize:none;outline:none;overflow:auto}
		textarea::selection{background:rgba(99,102,241,.3)}
		.dirty-dot{width:6px;height:6px;border-radius:50%;background:var(--wn);display:none;flex-shrink:0}
		.dirty-dot.visible{display:block}
	</style>
</head>
<body>

<div class="topbar">
	<span class="topbar-title">IOC Editor</span>
	<span class="topbar-mcu" id="topMcu">—</span>
	<span class="spacer"></span>
	<button class="btn btn-sec" id="openCubeMx">⬡ </button>
	<button class="btn btn-sec" id="regenerateCode">↻ </button>
	<button class="btn btn-sec" id="previewDiff">≠ </button>
	<span class="dirty-dot" id="dirtyDot"></span>
	<button class="btn btn-ok" id="save">✓ </button>
</div>

<div class="layout">
	<div class="sidebar" role="complementary" id="sidebar">
		<div class="sec-hd" id="secProjectInfo"></div>
		<div class="info-row"><span class="info-key">MCU</span><span id="mcu" class="info-val">—</span></div>
		<div class="info-row"><span class="info-key" id="keyBoard"></span><span id="board" class="info-val">—</span></div>
		<div class="info-row"><span class="info-key" id="keyProject"></span><span id="project" class="info-val">—</span></div>

		<div class="sec-hd" id="secPeripherals"></div>
		<div class="badge-list" id="peripherals"></div>

		<div class="sec-hd" id="secClock"></div>
		<div class="badge-list" id="clockHints"></div>
	</div>

	<div class="editor-pane">
		<div class="editor-toolbar">
			<span class="editor-label">IOC Raw Editor</span>
			<span class="editor-spacer"></span>
			<span style="font-size:11px;color:var(--mt)" id="lineCount"></span>
		</div>
		<textarea id="iocText" spellcheck="false" id="iocTextArea"></textarea>
	</div>
</div>

<script>
	const _i18n = ${i18nJson};
	const vscode = acquireVsCodeApi();
	const mcuEl = document.getElementById('mcu');
	const boardEl = document.getElementById('board');
	const projectEl = document.getElementById('project');
	const topMcuEl = document.getElementById('topMcu');
	const peripheralsEl = document.getElementById('peripherals');
	const clockHintsEl = document.getElementById('clockHints');
	const iocTextEl = document.getElementById('iocText');
	const lineCountEl = document.getElementById('lineCount');
	const dirtyDot = document.getElementById('dirtyDot');
	let dirty = false;

	// Apply i18n strings to DOM
	document.getElementById('openCubeMx').append(_i18n.openCubeMx);
	document.getElementById('openCubeMx').setAttribute('aria-label', _i18n.openCubeMx);
	document.getElementById('regenerateCode').append(_i18n.regenerateCode);
	document.getElementById('regenerateCode').setAttribute('aria-label', _i18n.regenerateCode);
	document.getElementById('previewDiff').append(_i18n.previewDiff);
	document.getElementById('previewDiff').setAttribute('aria-label', _i18n.previewDiff);
	document.getElementById('dirtyDot').setAttribute('title', _i18n.unsavedChanges);
	document.getElementById('save').append(_i18n.save);
	document.getElementById('save').setAttribute('aria-label', _i18n.save);
	document.getElementById('sidebar').setAttribute('aria-label', _i18n.projectOverview);
	document.getElementById('secProjectInfo').textContent = _i18n.projectInfo;
	document.getElementById('keyBoard').textContent = _i18n.board;
	document.getElementById('keyProject').textContent = _i18n.project;
	document.getElementById('secPeripherals').textContent = _i18n.enabledPeripherals;
	document.getElementById('secClock').textContent = _i18n.clockSettings;
	iocTextEl.setAttribute('aria-label', _i18n.iocContent);

	function renderBadges(el, items, cls) {
		el.innerHTML = '';
		if (!Array.isArray(items) || items.length === 0) {
			el.innerHTML = '<span style="font-size:11px;color:var(--mt)">${escapeHtml(noneLabel)}</span>';
			return;
		}
		for (const item of items) {
			const b = document.createElement('span');
			b.className = 'badge' + (cls ? ' ' + cls : '');
			b.textContent = String(item);
			el.appendChild(b);
		}
	}

	function updateLineCount() {
		const lines = iocTextEl.value.split('\\n').length;
		lineCountEl.textContent = _i18n.lines.replace('{0}', lines);
	}

	iocTextEl.addEventListener('input', () => {
		dirty = true;
		dirtyDot.className = 'dirty-dot visible';
		updateLineCount();
	});

	window.addEventListener('message', event => {
		const data = event.data;
		if (!data || data.type !== 'update') return;
		const s = data.summary || {};
		mcuEl.textContent = s.mcu || '—';
		boardEl.textContent = s.board || '—';
		projectEl.textContent = s.projectName || '—';
		topMcuEl.textContent = s.mcu || '—';
		renderBadges(peripheralsEl, s.usedPeripherals, null);
		renderBadges(clockHintsEl, s.clockHints, 'clock');
		iocTextEl.value = data.iocText || '';
		dirty = false;
		dirtyDot.className = 'dirty-dot';
		updateLineCount();
	});

	document.getElementById('save').addEventListener('click', () => {
		vscode.postMessage({ type: 'save', iocText: iocTextEl.value });
		dirty = false;
		dirtyDot.className = 'dirty-dot';
	});
	document.getElementById('openCubeMx').addEventListener('click', () => vscode.postMessage({ type: 'openCubeMx' }));
	document.getElementById('regenerateCode').addEventListener('click', () => vscode.postMessage({ type: 'regenerateCode' }));
	document.getElementById('previewDiff').addEventListener('click', () => vscode.postMessage({ type: 'previewDiff' }));
</script>
</body>
</html>`;
	}
}

class SvdRegisterProvider implements vscode.TreeDataProvider<RegisterTreeElement> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RegisterTreeElement | undefined | void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private cachedRootElements: RegisterTreeElement[] = [];
	private cachedSvdPath = '';

	public constructor(private readonly dependencies: Phase2Dependencies) {
	}

	public async refresh(): Promise<void> {
		const workspaceRoot = this.dependencies.getWorkspaceRoot();
		if (!workspaceRoot) {
			this.cachedRootElements = [];
			this.cachedSvdPath = '';
			this.onDidChangeTreeDataEmitter.fire();
			return;
		}

		const svdPath = await resolveSvdPath(workspaceRoot);
		if (!svdPath) {
			this.cachedRootElements = await buildFallbackRegisterTree(workspaceRoot, this.dependencies);
			this.cachedSvdPath = '';
			this.onDidChangeTreeDataEmitter.fire();
			return;
		}

		this.cachedSvdPath = svdPath;
		const raw = await fs.readFile(svdPath, 'utf8').catch(() => '');
		const parsed = parseSvdToTree(raw);
		this.cachedRootElements = parsed.length > 0 ? parsed : await buildFallbackRegisterTree(workspaceRoot, this.dependencies);
		this.onDidChangeTreeDataEmitter.fire();
	}

	public async getChildren(element?: RegisterTreeElement): Promise<RegisterTreeElement[]> {
		if (element) {
			if (element.kind === 'peripheral') {
				return element.children;
			}
			return [];
		}

		if (this.cachedRootElements.length === 0) {
			await this.refresh();
		}
		return this.cachedRootElements;
	}

	public async getTreeItem(element: RegisterTreeElement): Promise<vscode.TreeItem> {
		if (element.kind === 'peripheral') {
			const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.tooltip = element.description.length > 0 ? element.description : element.label;
			item.description = element.children.length > 0 ? `${element.children.length}` : '';
			item.contextValue = 'stm32.peripheral';
			return item;
		}

		const value = await evaluateExpression(element.evaluationExpression);
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.description = `${element.addressHex}${value ? ` = ${value}` : ''}`;
		item.tooltip = `${element.label}\n${element.addressHex}${element.description.length > 0 ? `\n${element.description}` : ''}`;
		item.contextValue = 'stm32.register';
		return item;
	}

	public getCurrentSvdPath(): string {
		return this.cachedSvdPath;
	}
}

class LiveExpressionsProvider implements vscode.TreeDataProvider<LiveExpressionElement> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<LiveExpressionElement | undefined | void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	public async getChildren(_element?: LiveExpressionElement): Promise<LiveExpressionElement[]> {
		const expressions = vscode.workspace.getConfiguration('stm32').get<string[]>('debug.liveExpressions', []);
		return expressions.map(expression => ({ expression }));
	}

	public async getTreeItem(element: LiveExpressionElement): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(element.expression, vscode.TreeItemCollapsibleState.None);
		const value = await evaluateExpression(element.expression);
		item.description = value ?? vscode.l10n.t('Pending evaluation');
		item.tooltip = `${element.expression}${value ? `\n= ${value}` : ''}`;
		item.contextValue = 'stm32.liveExpression';
		return item;
	}
}

interface QuickActionElement {
	label: string;
	command: string;
	icon?: string;
}

class QuickActionsProvider implements vscode.TreeDataProvider<QuickActionElement> {
	constructor(private readonly actions: QuickActionElement[]) { }

	public async getChildren(_element?: QuickActionElement): Promise<QuickActionElement[]> {
		return this.actions;
	}

	public async getTreeItem(element: QuickActionElement): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.command = { command: element.command, title: element.label };
		if (element.icon) {
			item.iconPath = new vscode.ThemeIcon(element.icon);
		}
		return item;
	}
}

export function registerPhase2Features(context: vscode.ExtensionContext, dependencies: Phase2Dependencies): void {
	const iocProvider = new IocCustomEditorProvider(dependencies);
	const svdProvider = new SvdRegisterProvider(dependencies);
	const liveExpressionsProvider = new LiveExpressionsProvider();
	const swvChannel = getSwvOutputChannel();
	context.subscriptions.push(swvChannel);

	const pinQuickActions = new QuickActionsProvider([
		{ label: vscode.l10n.t('Open Pin Visualizer'), command: 'stm32ux.openPinVisualizer', icon: 'symbol-color' },
		{ label: vscode.l10n.t('Open IOC Editor'), command: 'stm32.openIocEditor', icon: 'edit' },
	]);
	const commandCenterQuickActions = new QuickActionsProvider([
		{ label: vscode.l10n.t('New STM32 Project'), command: 'stm32.newProject', icon: 'new-file' },
		{ label: vscode.l10n.t('Open Board Config Studio'), command: 'stm32ux.openBoardConfigurator', icon: 'settings-gear' },
		{ label: vscode.l10n.t('Sync MCU Catalog from CubeMX'), command: 'stm32ux.syncMcuCatalogFromCubeMX', icon: 'cloud-download' },
		{ label: vscode.l10n.t('Run Environment Check'), command: 'stm32ux.runEnvironmentCheck', icon: 'check-all' },
		{ label: vscode.l10n.t('Detect CubeCLT Metadata'), command: 'stm32.detectCubeCLT', icon: 'search' },
		{ label: vscode.l10n.t('Build Debug'), command: 'stm32.buildDebug', icon: 'tools' },
		{ label: vscode.l10n.t('Build and Flash'), command: 'stm32.buildAndFlash', icon: 'rocket' },
	]);
	const buildQuickActions = new QuickActionsProvider([
		{ label: vscode.l10n.t('Build (Debug)'), command: 'stm32.buildDebug', icon: 'tools' },
		{ label: vscode.l10n.t('Flash'), command: 'stm32.flash', icon: 'zap' },
		{ label: vscode.l10n.t('Build + Flash'), command: 'stm32.buildAndFlash', icon: 'rocket' },
	]);

	context.subscriptions.push(vscode.window.registerCustomEditorProvider(IOC_EDITOR_VIEW_TYPE, iocProvider, {
		webviewOptions: {
			retainContextWhenHidden: true,
		},
		supportsMultipleEditorsPerDocument: false,
	}));
	context.subscriptions.push(vscode.window.registerTreeDataProvider('stm32-control.center', commandCenterQuickActions));
	context.subscriptions.push(vscode.window.registerTreeDataProvider('stm32-pin.quickActions', pinQuickActions));
	context.subscriptions.push(vscode.window.registerTreeDataProvider('stm32-build.quickActions', buildQuickActions));
	context.subscriptions.push(vscode.window.registerTreeDataProvider('stm32-debug.registers', svdProvider));
	context.subscriptions.push(vscode.window.registerTreeDataProvider('stm32-debug.liveExpressions', liveExpressionsProvider));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.openCommandCenter', async () => {
		await vscode.commands.executeCommand('workbench.view.extension.stm32-control');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.importCubeIDE', () => importCubeIdeProject(dependencies)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.openIocEditor', (uri?: vscode.Uri) => openIocEditor(uri, dependencies)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.regenerateCode', (uri?: vscode.Uri) => regenerateCodeFromIoc(uri, dependencies)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.showCodeSizeAnalysis', () => showCodeSizeAnalysis(dependencies)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.showFaultAnalyzer', () => showFaultAnalyzer()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.swv.start', () => startSwvTrace()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.swv.stop', () => stopSwvTrace()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.swv.showLog', () => showSwvLog()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.ioc.previewDiff', (uri?: vscode.Uri) => previewIocDiff(uri, dependencies)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.liveExpressions.add', () => addLiveExpression(liveExpressionsProvider)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.liveExpressions.refresh', () => refreshLiveExpressions(liveExpressionsProvider)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.liveExpressions.remove', () => removeLiveExpression(liveExpressionsProvider)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.liveExpressions.moveUp', () => moveLiveExpression(liveExpressionsProvider, -1)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.liveExpressions.moveDown', () => moveLiveExpression(liveExpressionsProvider, 1)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.debug.refreshRegisters', () => refreshSvdRegisters(svdProvider)));
	context.subscriptions.push(vscode.debug.onDidStartDebugSession(() => {
		liveExpressionsProvider.refresh();
		svdProvider.refresh().then(undefined, () => undefined);
		if (swvState.lastSessionId.length > 0 && swvState.lastSessionId !== (vscode.debug.activeDebugSession?.id ?? '')) {
			swvState.running = false;
		}
	}));
	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => {
		liveExpressionsProvider.refresh();
		svdProvider.refresh().then(undefined, () => undefined);
		stopSwvTrace({ silent: true }).then(undefined, () => undefined);
	}));
}

function getSwvOutputChannel(): vscode.OutputChannel {
	if (!swvOutputChannel) {
		swvOutputChannel = vscode.window.createOutputChannel('STM32 SWV/ITM');
	}
	return swvOutputChannel;
}

async function startSwvTrace(): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		vscode.window.showErrorMessage(vscode.l10n.t('An active debug session is required to start SWV.'));
		return;
	}

	const commands = vscode.workspace.getConfiguration('stm32').get<string[]>('debug.swv.startCommands', []);
	if (commands.length === 0) {
		vscode.window.showWarningMessage(vscode.l10n.t('No SWV start commands configured. Check setting `stm32.debug.swv.startCommands`.'));
		return;
	}

	const channel = getSwvOutputChannel();
	channel.show(true);
	appendSwvLog(vscode.l10n.t('[SWV] Executing start commands.'));
	for (const command of commands) {
		const result = await executeMonitorCommand(session, command);
		appendSwvLog(formatSwvCommandLog(command, result));
	}

	swvState.running = true;
	swvState.lastSessionId = session.id;
	vscode.window.showInformationMessage(vscode.l10n.t('SWV/ITM trace started.'));
}

async function stopSwvTrace(options?: { silent?: boolean }): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		swvState.running = false;
		swvState.lastSessionId = '';
		if (!options?.silent) {
			vscode.window.showInformationMessage(vscode.l10n.t('No active debug session. SWV state reset to stopped.'));
		}
		return;
	}

	const commands = vscode.workspace.getConfiguration('stm32').get<string[]>('debug.swv.stopCommands', []);
	const channel = getSwvOutputChannel();
	channel.show(true);
	appendSwvLog(vscode.l10n.t('[SWV] Executing stop commands.'));
	for (const command of commands) {
		const result = await executeMonitorCommand(session, command);
		appendSwvLog(formatSwvCommandLog(command, result));
	}

	swvState.running = false;
	swvState.lastSessionId = '';
	if (!options?.silent) {
		vscode.window.showInformationMessage(vscode.l10n.t('SWV/ITM trace stopped.'));
	}
}

async function showSwvLog(): Promise<void> {
	const channel = getSwvOutputChannel();
	channel.show(true);

	const session = vscode.debug.activeDebugSession;
	if (!session) {
		appendSwvLog(vscode.l10n.t('[SWV] No debug session. Showing log only.'));
		return;
	}

	const status = swvState.running ? vscode.l10n.t('Running') : vscode.l10n.t('Stopped');
	appendSwvLog(vscode.l10n.t('[SWV] Status: {0}', status));
	const statusResult = await executeMonitorCommand(session, 'monitor SWV status');
	appendSwvLog(formatSwvCommandLog('monitor SWV status', statusResult));

	const channels = extractSwvChannels(swvState.lines);
	if (channels.length === 0) {
		return;
	}

	const picks = [
		{ label: vscode.l10n.t('All channels'), value: 'all' },
		...channels.map(ch => ({ label: `CH${ch}`, value: ch })),
	];
	const selected = await vscode.window.showQuickPick(picks, {
		placeHolder: vscode.l10n.t('Select SWV log channel to display'),
	});
	if (!selected || selected.value === 'all') {
		return;
	}

	const filtered = filterSwvLinesByChannel(swvState.lines, Number(selected.value));
	if (filtered.length === 0) {
		appendSwvLog(vscode.l10n.t('[SWV] No log entries yet for CH{0}.', selected.value));
		return;
	}
	appendSwvLog(vscode.l10n.t('[SWV] Displaying log for CH{0}', selected.value));
	for (const line of filtered.slice(-200)) {
		channel.appendLine(line);
	}
}

async function executeMonitorCommand(session: vscode.DebugSession, command: string): Promise<string> {
	try {
		const response = await session.customRequest('evaluate', { expression: command, context: 'repl' }) as { result?: string };
		return response.result?.trim() ?? '';
	} catch (error) {
		return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function formatSwvCommandLog(command: string, result: string): string {
	const lines = [
		`> ${command}`,
		result.length > 0 ? result : '(no output)',
	];
	return lines.join('\n');
}

function appendSwvLog(message: string): void {
	const channel = getSwvOutputChannel();
	const timestamp = new Date().toLocaleTimeString();
	const line = `[${timestamp}] ${message}`;
	swvState.lines.push(line);
	if (swvState.lines.length > 4000) {
		swvState.lines.splice(0, swvState.lines.length - 4000);
	}
	channel.appendLine(line);
}

function extractSwvChannels(lines: string[]): number[] {
	const channels = new Set<number>();
	for (const line of lines) {
		for (const value of findChannelNumbers(line)) {
			channels.add(value);
		}
	}
	return Array.from(channels).sort((a, b) => a - b);
}

function filterSwvLinesByChannel(lines: string[], channel: number): string[] {
	const filtered: string[] = [];
	for (const line of lines) {
		const channels = findChannelNumbers(line);
		if (channels.includes(channel)) {
			filtered.push(line);
		}
	}
	return filtered;
}

function findChannelNumbers(line: string): number[] {
	const result: number[] = [];
	for (const match of line.matchAll(/\b(?:ch|itm|port)\s*[:#]?\s*(\d+)\b/ig)) {
		const parsed = Number(match[1]);
		if (!Number.isNaN(parsed)) {
			result.push(parsed);
		}
	}
	return result;
}

async function openIocEditor(uri: vscode.Uri | undefined, dependencies: Phase2Dependencies): Promise<void> {
	const iocUri = await resolveIocUri(uri, dependencies);
	if (!iocUri) {
		vscode.window.showErrorMessage(vscode.l10n.t('IOC file not found. Create or import a project first.'));
		return;
	}

	await vscode.commands.executeCommand('vscode.openWith', iocUri, IOC_EDITOR_VIEW_TYPE);
}

async function importCubeIdeProject(dependencies: Phase2Dependencies): Promise<void> {
	const selected = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: vscode.l10n.t('Select CubeIDE Project Folder'),
	});
	const projectFolderUri = selected?.[0];
	if (!projectFolderUri) {
		return;
	}

	const projectPath = projectFolderUri.fsPath;
	const projectFile = join(projectPath, '.project');
	const cprojectFile = join(projectPath, '.cproject');
	const hasProject = await pathExists(projectFile);
	const hasCproject = await pathExists(cprojectFile);
	if (!hasProject || !hasCproject) {
		vscode.window.showErrorMessage(vscode.l10n.t('Selected folder does not contain .project / .cproject. Please select a CubeIDE project.'));
		return;
	}

	const projectName = await readCubeIdeProjectName(projectFile) ?? basename(projectPath);
	await ensureStm32Scaffold(projectPath);

	const openCurrent = vscode.l10n.t('Open Folder');
	const addWorkspace = vscode.l10n.t('Add to Workspace');
	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t('CubeIDE project "{0}" detected. What would you like to do?', projectName),
		openCurrent,
		addWorkspace,
	);

	if (choice === openCurrent) {
		await vscode.commands.executeCommand('vscode.openFolder', projectFolderUri, false);
		return;
	}

	if (choice === addWorkspace) {
		const insertIndex = vscode.workspace.workspaceFolders?.length ?? 0;
		vscode.workspace.updateWorkspaceFolders(insertIndex, 0, { uri: projectFolderUri, name: projectName });
	}

	vscode.window.showInformationMessage(vscode.l10n.t('CubeIDE project import ready. You can now run STM32: Build (Debug).'));
	dependencies.outputChannel.appendLine(`[STM32] CubeIDE import prepared: ${projectPath}`);
}

async function regenerateCodeFromIoc(uri: vscode.Uri | undefined, dependencies: Phase2Dependencies): Promise<void> {
	const workspaceRoot = dependencies.getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder before running this command.'));
		return;
	}

	const iocUri = await resolveIocUri(uri, dependencies);
	if (!iocUri) {
		vscode.window.showErrorMessage(vscode.l10n.t('IOC file not found.'));
		return;
	}

	const iocPath = iocUri.fsPath;
	const snapshot = await captureUserCodeSnapshot(workspaceRoot);
	const cubeMxExecutable = await getCubeMxExecutable();
	const argsTemplate = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.generateCliArgsTemplate', '-q "{ioc}" -s');

	const generationResult = await runCubeMxGeneration(cubeMxExecutable, argsTemplate, iocPath, workspaceRoot, dependencies);
	if (generationResult.exitCode !== 0) {
		vscode.window.showErrorMessage(vscode.l10n.t('CubeMX code generation failed. Check the output log.'));
		return;
	}

	const restoredSections = await restoreUserCodeSnapshot(workspaceRoot, snapshot);
	vscode.window.showInformationMessage(vscode.l10n.t('Code generation complete. Restored {0} USER CODE section(s).', String(restoredSections)));
	dependencies.outputChannel.appendLine(`[STM32] Code generation completed for ${iocPath}. Restored user sections: ${restoredSections}`);
}

async function runCubeMxGeneration(cubeMxExecutable: string, argsTemplate: string, iocPath: string, workspaceRoot: string, dependencies: Phase2Dependencies): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const directArgs = splitCliArgs(argsTemplate.replace(/\{ioc\}/g, iocPath));
	if (directArgs.length > 0) {
		const directResult = await dependencies.runCli(cubeMxExecutable, directArgs, workspaceRoot, vscode.l10n.t('CubeMX code generation'));
		if (directResult.exitCode === 0) {
			return directResult;
		}
	}

	const scriptPath = join(tmpdir(), `stm32-cubemx-${Date.now()}.script`);
	const scriptContent = [
		`config load "${iocPath}"`,
		'project toolchain Makefile',
		'generate code',
		'exit',
	].join('\n');
	await fs.writeFile(scriptPath, scriptContent, 'utf8');
	try {
		return await dependencies.runCli(cubeMxExecutable, ['-script', scriptPath], workspaceRoot, vscode.l10n.t('CubeMX code regeneration (script)'));
	} finally {
		await fs.unlink(scriptPath).catch(() => undefined);
	}
}

async function showCodeSizeAnalysis(dependencies: Phase2Dependencies): Promise<void> {
	const workspaceRoot = dependencies.getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder before running this command.'));
		return;
	}

	const mapPath = await findFirstMatch(workspaceRoot, filePath => extname(filePath).toLowerCase() === '.map', ['Debug', 'Release']);
	if (!mapPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('MAP file not found. Build the project first.'));
		return;
	}

	const mapText = await fs.readFile(mapPath, 'utf8').catch(() => '');
	if (!mapText) {
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to read MAP file.'));
		return;
	}

	const sectionSummary = parseMapSections(mapText);
	const symbolSummary = parseMapSymbols(mapText).slice(0, 20);
	const panel = vscode.window.createWebviewPanel(
		'stm32.codeSizeAnalysis',
		vscode.l10n.t('STM32 Code Size Analysis'),
		vscode.ViewColumn.Beside,
		{ enableScripts: false }
	);
	panel.webview.html = renderCodeSizeHtml(mapPath, sectionSummary, symbolSummary);

	const totalBytes = sectionSummary.reduce((sum, section) => sum + section.size, 0);
	dependencies.outputChannel.appendLine(`[STM32] Code size analysis: ${mapPath} (total: ${totalBytes} bytes)`);
}

async function showFaultAnalyzer(): Promise<void> {
	const cfsrInput = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Enter CFSR register value in hex (e.g. 0x00008200)'),
		value: '0x00000000',
	});
	if (cfsrInput === undefined) {
		return;
	}

	const hfsrInput = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Enter HFSR register value in hex (e.g. 0x40000000)'),
		value: '0x00000000',
	});
	if (hfsrInput === undefined) {
		return;
	}

	const cfsr = parseHexNumber(cfsrInput);
	const hfsr = parseHexNumber(hfsrInput);
	if (cfsr === undefined || hfsr === undefined) {
		vscode.window.showErrorMessage(vscode.l10n.t('Invalid hex format. Please use 0x notation.'));
		return;
	}

	const cfsrDetails = decodeCfsr(cfsr);
	const hfsrDetails = decodeHfsr(hfsr);
	const markdown = [
		`# ${vscode.l10n.t('STM32 Fault Analyzer')}`,
		'',
		`- CFSR: \`${toHex(cfsr, 8)}\``,
		`- HFSR: \`${toHex(hfsr, 8)}\``,
		'',
		`## ${vscode.l10n.t('CFSR Breakdown')}`,

		...toListLines(cfsrDetails),
		'',
		`## ${vscode.l10n.t('HFSR Breakdown')}`,

		...toListLines(hfsrDetails),
	].join('\n');

	const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
	await vscode.window.showTextDocument(document, { preview: false });
}

async function addLiveExpression(provider: LiveExpressionsProvider): Promise<void> {
	const expression = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Enter an expression to add to Live Expressions.'),
		placeHolder: '*((uint32_t*)0x40021000)',
	});
	if (!expression) {
		return;
	}

	const config = vscode.workspace.getConfiguration('stm32');
	const current = config.get<string[]>('debug.liveExpressions', []);
	const alreadyExists = current.some(item => item === expression);
	if (alreadyExists) {
		vscode.window.showInformationMessage(vscode.l10n.t('This expression is already registered.'));
		return;
	}

	await config.update('debug.liveExpressions', [...current, expression], vscode.ConfigurationTarget.Workspace);
	provider.refresh();
}

async function refreshLiveExpressions(provider: LiveExpressionsProvider): Promise<void> {
	provider.refresh();
	vscode.window.setStatusBarMessage(vscode.l10n.t('Live Expressions refreshed.'), 1500);
}

async function removeLiveExpression(provider: LiveExpressionsProvider): Promise<void> {
	const config = vscode.workspace.getConfiguration('stm32');
	const current = config.get<string[]>('debug.liveExpressions', []);
	if (current.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No Live Expressions to remove.'));
		return;
	}

	const selected = await vscode.window.showQuickPick(current, {
		placeHolder: vscode.l10n.t('Select a Live Expression to remove'),
	});
	if (!selected) {
		return;
	}

	await config.update('debug.liveExpressions', current.filter(item => item !== selected), vscode.ConfigurationTarget.Workspace);
	provider.refresh();
}

async function moveLiveExpression(provider: LiveExpressionsProvider, direction: -1 | 1): Promise<void> {
	const config = vscode.workspace.getConfiguration('stm32');
	const current = config.get<string[]>('debug.liveExpressions', []);
	if (current.length < 2) {
		vscode.window.showInformationMessage(vscode.l10n.t('Need at least 2 Live Expressions to reorder.'));
		return;
	}

	const selected = await vscode.window.showQuickPick(current, {
		placeHolder: vscode.l10n.t('Select a Live Expression to move'),
	});
	if (!selected) {
		return;
	}

	const index = current.findIndex(item => item === selected);
	if (index < 0) {
		return;
	}
	const target = index + direction;
	if (target < 0 || target >= current.length) {
		vscode.window.showInformationMessage(vscode.l10n.t('Cannot move further in that direction.'));
		return;
	}

	const next = [...current];
	const [entry] = next.splice(index, 1);
	next.splice(target, 0, entry);
	await config.update('debug.liveExpressions', next, vscode.ConfigurationTarget.Workspace);
	provider.refresh();
}

async function previewIocDiff(uri: vscode.Uri | undefined, dependencies: Phase2Dependencies): Promise<void> {
	const iocUri = await resolveIocUri(uri, dependencies);
	if (!iocUri) {
		vscode.window.showErrorMessage(vscode.l10n.t('IOC file not found.'));
		return;
	}

	const document = await vscode.workspace.openTextDocument(iocUri);
	const currentText = document.getText();
	const savedText = await fs.readFile(iocUri.fsPath, 'utf8').catch(() => currentText);
	const savedDocument = await vscode.workspace.openTextDocument({
		language: document.languageId,
		content: savedText,
	});

	const title = vscode.l10n.t('IOC Diff Preview: Saved ↔ Edited');
	await vscode.commands.executeCommand('vscode.diff', savedDocument.uri, document.uri, title);
}

async function refreshSvdRegisters(provider: SvdRegisterProvider): Promise<void> {
	await provider.refresh();
	const currentPath = provider.getCurrentSvdPath();
	if (currentPath.length > 0) {
		vscode.window.setStatusBarMessage(vscode.l10n.t('SVD registers refreshed.'), 1500);
	} else {
		vscode.window.showWarningMessage(vscode.l10n.t('SVD file not found. Showing fallback registers. Check setting `stm32.debug.svdPath`.'));
	}
}

async function resolveIocUri(uri: vscode.Uri | undefined, dependencies: Phase2Dependencies): Promise<vscode.Uri | undefined> {
	if (uri && uri.fsPath.toLowerCase().endsWith('.ioc')) {
		return uri;
	}

	const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
	if (activePath && activePath.toLowerCase().endsWith('.ioc')) {
		return vscode.Uri.file(activePath);
	}

	const workspaceRoot = dependencies.getWorkspaceRoot();
	if (!workspaceRoot) {
		return undefined;
	}

	const topLevelIoc = await dependencies.findTopLevelIocFile(workspaceRoot);
	if (!topLevelIoc) {
		return undefined;
	}
	return vscode.Uri.file(topLevelIoc);
}

async function getCubeMxExecutable(): Promise<string> {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	if (configured.length === 0) {
		return 'STM32CubeMX';
	}

	if (await pathExists(configured)) {
		const separator = configured.includes('\\') ? '\\' : '/';
		const trimmed = configured.endsWith(separator) ? configured.slice(0, -1) : configured;
		if (trimmed.toLowerCase().endsWith('.exe') || trimmed.toLowerCase().endsWith('stm32cubemx')) {
			return trimmed;
		}

		const executable = join(trimmed, process.platform === 'win32' ? 'STM32CubeMX.exe' : 'STM32CubeMX');
		if (await pathExists(executable)) {
			return executable;
		}
	}

	return configured;
}

async function ensureStm32Scaffold(projectRoot: string): Promise<void> {
	const vscodeFolder = join(projectRoot, '.vscode');
	await fs.mkdir(vscodeFolder, { recursive: true });

	const tasksPath = join(vscodeFolder, 'tasks.json');
	if (!await pathExists(tasksPath)) {
		const tasksContent = JSON.stringify({
			version: '2.0.0',
			tasks: [
				{
					label: 'STM32 Build (Debug)',
					type: 'shell',
					command: 'make -j8 all -C ./Debug',
					problemMatcher: ['$gcc'],
					group: 'build',
				},
			],
		}, undefined, 2);
		await fs.writeFile(tasksPath, `${tasksContent}\n`, 'utf8');
	}

	const launchPath = join(vscodeFolder, 'launch.json');
	if (!await pathExists(launchPath)) {
		const launchContent = JSON.stringify({
			version: '0.2.0',
			configurations: [
				{
					name: 'STM32 Debug (ST-LINK)',
					type: 'cppdbg',
					request: 'launch',
					program: '${workspaceFolder}/Debug/${workspaceFolderBasename}.elf',
					cwd: '${workspaceFolder}',
					MIMode: 'gdb',
					miDebuggerPath: 'arm-none-eabi-gdb',
					stopAtEntry: true,
					externalConsole: false,
				},
			],
		}, undefined, 2);
		await fs.writeFile(launchPath, `${launchContent}\n`, 'utf8');
	}
}

async function readCubeIdeProjectName(projectFilePath: string): Promise<string | undefined> {
	const raw = await fs.readFile(projectFilePath, 'utf8').catch(() => '');
	const match = raw.match(/<name>([^<]+)<\/name>/i);
	if (!match) {
		return undefined;
	}
	return match[1].trim();
}

async function captureUserCodeSnapshot(workspaceRoot: string): Promise<UserCodeSnapshot> {
	const sectionsByFile = new Map<string, Map<string, string>>();
	const candidates = await collectSourceFiles(workspaceRoot);
	for (const filePath of candidates) {
		const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
		if (raw.length === 0) {
			continue;
		}
		const sections = extractUserCodeSections(raw);
		if (sections.length === 0) {
			continue;
		}
		const sectionMap = new Map<string, string>();
		for (const section of sections) {
			sectionMap.set(section.name, section.content);
		}
		sectionsByFile.set(relative(workspaceRoot, filePath), sectionMap);
	}
	return { sectionsByFile };
}

async function restoreUserCodeSnapshot(workspaceRoot: string, snapshot: UserCodeSnapshot): Promise<number> {
	let restoredCount = 0;
	for (const [relativePath, sectionMap] of snapshot.sectionsByFile) {
		const absolutePath = resolve(workspaceRoot, relativePath);
		const current = await fs.readFile(absolutePath, 'utf8').catch(() => '');
		if (current.length === 0) {
			continue;
		}

		let nextText = current;
		let fileChanged = false;
		for (const [name, preservedContent] of sectionMap) {
			const pattern = new RegExp(`(/\\*\\s*USER CODE BEGIN\\s+${escapeRegExp(name)}\\s*\\*/)([\\s\\S]*?)(/\\*\\s*USER CODE END\\s+${escapeRegExp(name)}\\s*\\*/)`, 'g');
			const replaced = nextText.replace(pattern, (_full, begin: string, _oldContent: string, end: string) => {
				restoredCount += 1;
				fileChanged = true;
				return `${begin}${preservedContent}${end}`;
			});
			nextText = replaced;
		}

		if (fileChanged && nextText !== current) {
			await fs.writeFile(absolutePath, nextText, 'utf8');
		}
	}
	return restoredCount;
}

function extractUserCodeSections(fileText: string): ParsedSection[] {
	const sections: ParsedSection[] = [];
	const regex = /\/\*\s*USER CODE BEGIN\s+([^*]+?)\s*\*\/([\s\S]*?)\/\*\s*USER CODE END\s+\1\s*\*\//g;
	for (const match of fileText.matchAll(regex)) {
		const sectionName = match[1].trim();
		const sectionContent = match[2];
		sections.push({ name: sectionName, content: sectionContent });
	}
	return sections;
}

async function collectSourceFiles(workspaceRoot: string): Promise<string[]> {
	const result: string[] = [];
	const preferredRoots = [join(workspaceRoot, 'Core', 'Inc'), join(workspaceRoot, 'Core', 'Src')];
	let collectedPreferred = false;

	for (const root of preferredRoots) {
		if (await pathExists(root)) {
			await collectFilesRecursive(root, result);
			collectedPreferred = true;
		}
	}

	if (!collectedPreferred) {
		await collectFilesRecursive(workspaceRoot, result);
	}
	return result;
}

async function collectFilesRecursive(folder: string, result: string[]): Promise<void> {
	const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [] as DirentLike[]);
	for (const entry of entries) {
		const fullPath = join(folder, entry.name);
		if (entry.isDirectory()) {
			if (isSkippedDirectory(entry.name)) {
				continue;
			}
			await collectFilesRecursive(fullPath, result);
			continue;
		}
		if (entry.isFile() && isSourceFile(entry.name)) {
			result.push(fullPath);
		}
	}
}

function isSkippedDirectory(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === '.git' || lower === '.vscode' || lower === 'debug' || lower === 'release' || lower === 'build' || lower === 'out';
}

function isSourceFile(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	return lower.endsWith('.c') || lower.endsWith('.h') || lower.endsWith('.cpp') || lower.endsWith('.hpp');
}

function parseIocSummary(iocText: string): IocSummary {
	const lines = iocText.split(/\r?\n/);
	let mcu = '';
	let board = '';
	let projectName = '';
	const usedPeripherals = new Set<string>();
	const clockHints: string[] = [];

	for (const line of lines) {
		if (line.startsWith('Mcu.Name=')) {
			mcu = line.slice('Mcu.Name='.length).trim();
			continue;
		}
		if (line.startsWith('Board=') || line.startsWith('Board.PartNumber=')) {
			const value = line.includes('=') ? line.slice(line.indexOf('=') + 1).trim() : '';
			board = value;
			continue;
		}
		if (line.startsWith('ProjectManager.ProjectName=')) {
			projectName = line.slice('ProjectManager.ProjectName='.length).trim();
			continue;
		}

		const peripheralMatch = line.match(/^([A-Z][A-Za-z0-9_]+)\./);
		if (peripheralMatch) {
			const name = peripheralMatch[1];
			if (name.startsWith('RCC') || name.startsWith('NVIC')) {
				continue;
			}
			usedPeripherals.add(name);
		}

		if (line.includes('Clock') || line.includes('PLL') || line.includes('HCLK') || line.includes('SYSCLK')) {
			clockHints.push(line.trim());
		}
	}

	return {
		mcu,
		board,
		projectName,
		usedPeripherals: Array.from(usedPeripherals).sort().slice(0, 24),
		clockHints: clockHints.slice(0, 12),
	};
}

async function buildFallbackRegisterTree(workspaceRoot: string, dependencies: Phase2Dependencies): Promise<RegisterTreeElement[]> {
	const iocPath = await dependencies.findTopLevelIocFile(workspaceRoot);
	let summary: IocSummary | undefined;
	if (iocPath) {
		const iocText = await fs.readFile(iocPath, 'utf8').catch(() => '');
		if (iocText.length > 0) {
			summary = parseIocSummary(iocText);
		}
	}

	const peripheralNames = summary?.usedPeripherals.length ? summary.usedPeripherals : ['RCC', 'GPIOA', 'USART1', 'SPI1', 'I2C1'];
	const roots: RegisterTreeElement[] = [];
	for (const name of peripheralNames) {
		const template = getFallbackRegisterTemplate(name);
		if (!template) {
			continue;
		}
		roots.push(templateToTreeElement(template));
		if (roots.length >= 24) {
			break;
		}
	}

	if (roots.length > 0) {
		return roots;
	}

	return [templateToTreeElement(createPeripheralTemplate('SYSTEM', 0xE000E000, ['ICSR', 'VTOR', 'AIRCR']))];
}

interface FallbackPeripheralTemplate {
	name: string;
	baseAddress: number;
	registers: string[];
}

function createPeripheralTemplate(name: string, baseAddress: number, registers: string[]): FallbackPeripheralTemplate {
	return { name, baseAddress, registers };
}

function templateToTreeElement(template: FallbackPeripheralTemplate): RegisterTreeElement {
	return {
		kind: 'peripheral',
		label: template.name,
		description: vscode.l10n.t('Fallback display — SVD not found'),
		children: template.registers.map((registerName, index) => {
			const address = template.baseAddress + index * 4;
			const addressHex = toHex(address >>> 0, 8);
			return {
				kind: 'register',
				label: registerName,
				description: 'Fallback',
				addressHex,
				evaluationExpression: `*((volatile unsigned int*)${addressHex})`,
			};
		}),
	};
}

function getFallbackRegisterTemplate(peripheralName: string): FallbackPeripheralTemplate | undefined {
	const normalized = peripheralName.toUpperCase();
	if (normalized.startsWith('GPIO')) {
		const suffix = normalized.charCodeAt(normalized.length - 1) - 65;
		const offset = suffix >= 0 && suffix < 11 ? suffix * 0x400 : 0;
		return createPeripheralTemplate(normalized, 0x48000000 + offset, ['MODER', 'OTYPER', 'OSPEEDR', 'PUPDR', 'IDR', 'ODR', 'BSRR', 'AFRL', 'AFRH']);
	}
	if (normalized.startsWith('USART') || normalized.startsWith('UART') || normalized.startsWith('LPUART')) {
		return createPeripheralTemplate(normalized, 0x40011000, ['CR1', 'CR2', 'CR3', 'BRR', 'ISR', 'RDR', 'TDR']);
	}
	if (normalized.startsWith('SPI')) {
		return createPeripheralTemplate(normalized, 0x40013000, ['CR1', 'CR2', 'SR', 'DR', 'CRCPR', 'RXCRCR', 'TXCRCR']);
	}
	if (normalized.startsWith('I2C')) {
		return createPeripheralTemplate(normalized, 0x40005400, ['CR1', 'CR2', 'OAR1', 'OAR2', 'TIMINGR', 'ISR', 'ICR', 'RXDR', 'TXDR']);
	}
	if (normalized.startsWith('ADC')) {
		return createPeripheralTemplate(normalized, 0x50000000, ['ISR', 'IER', 'CR', 'CFGR', 'SMPR1', 'SMPR2', 'SQR1', 'DR']);
	}
	if (normalized.startsWith('TIM')) {
		return createPeripheralTemplate(normalized, 0x40000000, ['CR1', 'CR2', 'SMCR', 'DIER', 'SR', 'CNT', 'PSC', 'ARR', 'CCR1']);
	}
	if (normalized.startsWith('RCC')) {
		return createPeripheralTemplate('RCC', 0x40021000, ['CR', 'CFGR', 'PLLCKSELR', 'PLLCFGR', 'AHB1ENR', 'APB1ENR1', 'APB2ENR']);
	}
	if (normalized.startsWith('DMA')) {
		return createPeripheralTemplate(normalized, 0x40020000, ['ISR', 'IFCR', 'CCR1', 'CNDTR1', 'CPAR1', 'CMAR1']);
	}
	if (normalized.startsWith('CAN')) {
		return createPeripheralTemplate(normalized, 0x40006400, ['MCR', 'MSR', 'TSR', 'RF0R', 'RF1R', 'IER', 'ESR']);
	}
	if (normalized.startsWith('USB')) {
		return createPeripheralTemplate(normalized, 0x50000000, ['EP0R', 'EP1R', 'CNTR', 'ISTR', 'FNR', 'DADDR', 'BTABLE']);
	}
	return undefined;
}

async function resolveSvdPath(workspaceRoot: string): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('debug.svdPath', '').trim();
	if (configured.length > 0) {
		const absoluteConfigured = isAbsolute(configured) ? configured : resolve(workspaceRoot, configured);
		if (await pathExists(absoluteConfigured)) {
			return absoluteConfigured;
		}
	}

	const topLevel = await fs.readdir(workspaceRoot, { withFileTypes: true }).catch(() => [] as DirentLike[]);
	const svdFile = topLevel.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.svd'));
	if (svdFile) {
		return join(workspaceRoot, svdFile.name);
	}
	return undefined;
}

function parseSvdToTree(rawSvdText: string): RegisterTreeElement[] {
	if (rawSvdText.length === 0) {
		return [];
	}

	const peripherals: PeripheralInfo[] = [];
	const peripheralRegex = /<peripheral\b[^>]*>([\s\S]*?)<\/peripheral>/g;
	for (const peripheralMatch of rawSvdText.matchAll(peripheralRegex)) {
		const block = peripheralMatch[1];
		const name = readXmlTag(block, 'name');
		if (!name) {
			continue;
		}
		const description = readXmlTag(block, 'description');
		const baseAddress = parseHexNumber(readXmlTag(block, 'baseAddress') ?? '0x0', { allowDecimal: true }) ?? 0;
		const registers = parseRegisterEntries(block, baseAddress);
		if (registers.length === 0) {
			continue;
		}
		peripherals.push({ name, description: description ?? '', registers });
		if (peripherals.length >= 48) {
			break;
		}
	}

	return peripherals.map<RegisterTreeElement>(peripheral => ({
		kind: 'peripheral',
		label: peripheral.name,
		description: peripheral.description,
		children: peripheral.registers.map<RegisterTreeElement>(register => ({
			kind: 'register',
			label: register.name,
			description: register.description,
			addressHex: register.addressHex,
			evaluationExpression: register.evaluationExpression,
		})),
	}));
}

function parseRegisterEntries(peripheralBlock: string, baseAddress: number): RegisterInfo[] {
	const registers: RegisterInfo[] = [];
	const registerRegex = /<register\b[^>]*>([\s\S]*?)<\/register>/g;
	for (const registerMatch of peripheralBlock.matchAll(registerRegex)) {
		const registerBlock = registerMatch[1];
		const registerName = readXmlTag(registerBlock, 'name');
		if (!registerName) {
			continue;
		}
		const registerDescription = readXmlTag(registerBlock, 'description') ?? '';
		const offset = parseHexNumber(readXmlTag(registerBlock, 'addressOffset') ?? '0x0', { allowDecimal: true }) ?? 0;
		const absolute = baseAddress + offset;
		const addressHex = toHex(absolute >>> 0, 8);
		registers.push({
			name: registerName,
			description: registerDescription,
			addressHex,
			evaluationExpression: `*((volatile unsigned int*)${addressHex})`,
		});
		if (registers.length >= 96) {
			break;
		}
	}
	return registers;
}

function readXmlTag(xml: string, tag: string): string | undefined {
	const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const match = xml.match(regex);
	if (!match) {
		return undefined;
	}
	return decodeXmlEntities(match[1].trim());
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

async function evaluateExpression(expression: string): Promise<string | undefined> {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		return undefined;
	}

	try {
		const response = await session.customRequest('evaluate', { expression, context: 'watch' }) as { result?: string };
		const value = response.result;
		if (!value || value.length === 0) {
			return undefined;
		}
		return value;
	} catch {
		return undefined;
	}
}

function parseMapSections(mapText: string): MapSectionSummary[] {
	const sectionSizes = new Map<string, number>();
	const sectionRegex = /^\s*\.(text|rodata|data|bss)\s+0x[0-9a-fA-F]+\s+0x([0-9a-fA-F]+)/gm;
	for (const match of mapText.matchAll(sectionRegex)) {
		const name = `.${match[1]}`;
		const size = parseInt(match[2], 16);
		if (Number.isNaN(size)) {
			continue;
		}
		sectionSizes.set(name, (sectionSizes.get(name) ?? 0) + size);
	}

	return Array.from(sectionSizes.entries())
		.map(([name, size]) => ({ name, size }))
		.sort((a, b) => b.size - a.size);
}

function parseMapSymbols(mapText: string): SymbolSummary[] {
	const symbols: SymbolSummary[] = [];
	const symbolRegex = /^\s+0x[0-9a-fA-F]+\s+0x([0-9a-fA-F]+)\s+([^\s]+)$/gm;
	for (const match of mapText.matchAll(symbolRegex)) {
		const size = parseInt(match[1], 16);
		const name = match[2].trim();
		if (!Number.isFinite(size) || size <= 0 || name.length === 0) {
			continue;
		}
		symbols.push({ name, size });
	}
	return symbols.sort((a, b) => b.size - a.size);
}

function renderCodeSizeHtml(mapPath: string, sections: MapSectionSummary[], symbols: SymbolSummary[]): string {
	const total = sections.reduce((sum, section) => sum + section.size, 0);
	const sectionRows = sections.map(section => {
		const ratio = total > 0 ? ((section.size / total) * 100).toFixed(1) : '0.0';
		return `<tr><td>${escapeHtml(section.name)}</td><td>${section.size.toLocaleString()}</td><td>${ratio}%</td></tr>`;
	}).join('');
	const symbolRows = symbols.map(symbol => `<tr><td>${escapeHtml(symbol.name)}</td><td>${symbol.size.toLocaleString()}</td></tr>`).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<title>${escapeHtml(vscode.l10n.t('STM32 Code Size Analysis'))}</title>
	<style>
		body {
			font: 13px/1.5 var(--vscode-font-family);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
		}
		h1 { margin: 0 0 8px; font-size: 18px; }
		p { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
		table {
			width: 100%;
			border-collapse: collapse;
			margin-bottom: 16px;
		}
		th, td {
			border: 1px solid var(--vscode-panel-border);
			padding: 6px 8px;
			text-align: left;
		}
		th { background: var(--vscode-sideBar-background); }
		.small { color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<h1>${escapeHtml(vscode.l10n.t('Code Size Analysis'))}</h1>
	<p>${escapeHtml(vscode.l10n.t('Target: {0}', mapPath))}</p>
	<p class="small">${escapeHtml(vscode.l10n.t('Total: {0} bytes', total.toLocaleString()))}</p>
	<h2>${escapeHtml(vscode.l10n.t('By Section'))}</h2>
	<table>
		<thead><tr><th>${escapeHtml(vscode.l10n.t('Section'))}</th><th>${escapeHtml(vscode.l10n.t('Size (bytes)'))}</th><th>${escapeHtml(vscode.l10n.t('Ratio'))}</th></tr></thead>
		<tbody>${sectionRows || `<tr><td colspan="3">${escapeHtml(vscode.l10n.t('No data'))}</td></tr>`}</tbody>
	</table>
	<h2>${escapeHtml(vscode.l10n.t('Top Symbols'))}</h2>
	<table>
		<thead><tr><th>${escapeHtml(vscode.l10n.t('Symbol'))}</th><th>${escapeHtml(vscode.l10n.t('Size (bytes)'))}</th></tr></thead>
		<tbody>${symbolRows || `<tr><td colspan="2">${escapeHtml(vscode.l10n.t('No data'))}</td></tr>`}</tbody>
	</table>
</body>
</html>`;
}

function decodeCfsr(cfsr: number): string[] {
	const flags: Array<{ bit: number; label: string }> = [
		{ bit: 0, label: vscode.l10n.t('IACCVIOL: Instruction access violation') },
		{ bit: 1, label: vscode.l10n.t('DACCVIOL: Data access violation') },
		{ bit: 3, label: vscode.l10n.t('MUNSTKERR: Memory management fault on exception return') },
		{ bit: 4, label: vscode.l10n.t('MSTKERR: Memory management fault on exception entry') },
		{ bit: 7, label: vscode.l10n.t('MMARVALID: MMFAR holds valid address') },
		{ bit: 8, label: vscode.l10n.t('IBUSERR: Instruction bus error') },
		{ bit: 9, label: vscode.l10n.t('PRECISERR: Precise data bus error') },
		{ bit: 10, label: vscode.l10n.t('IMPRECISERR: Imprecise data bus error') },
		{ bit: 11, label: vscode.l10n.t('UNSTKERR: Bus fault on exception return stack') },
		{ bit: 12, label: vscode.l10n.t('STKERR: Bus fault on exception entry stack') },
		{ bit: 15, label: vscode.l10n.t('BFARVALID: BFAR holds valid address') },
		{ bit: 16, label: vscode.l10n.t('UNDEFINSTR: Undefined instruction') },
		{ bit: 17, label: vscode.l10n.t('INVSTATE: Invalid state transition') },
		{ bit: 18, label: vscode.l10n.t('INVPC: Invalid PC load') },
		{ bit: 19, label: vscode.l10n.t('NOCP: No coprocessor / FPU not enabled') },
		{ bit: 24, label: vscode.l10n.t('UNALIGNED: Unaligned access') },
		{ bit: 25, label: vscode.l10n.t('DIVBYZERO: Divide by zero') },
	];
	const active = flags.filter(flag => (cfsr & (1 << flag.bit)) !== 0).map(flag => flag.label);
	return active.length > 0 ? active : [vscode.l10n.t('No active fault flags.')];
}

function decodeHfsr(hfsr: number): string[] {
	const flags: Array<{ bit: number; label: string }> = [
		{ bit: 1, label: vscode.l10n.t('VECTTBL: Vector table read fault') },
		{ bit: 30, label: vscode.l10n.t('FORCED: Escalated from configurable fault to HardFault') },
		{ bit: 31, label: vscode.l10n.t('DEBUGEVT: Debug event occurred') },
	];
	const active = flags.filter(flag => (hfsr & (1 << flag.bit)) !== 0).map(flag => flag.label);
	return active.length > 0 ? active : [vscode.l10n.t('No active HardFault flags.')];
}

function toListLines(lines: string[]): string[] {
	return lines.map(line => `- ${line}`);
}

function parseHexNumber(raw: string, options?: { allowDecimal?: boolean }): number | undefined {
	const normalized = raw.trim().toLowerCase();
	if (/^0x[0-9a-f]+$/.test(normalized)) {
		const value = Number.parseInt(normalized.slice(2), 16);
		if (Number.isNaN(value)) {
			return undefined;
		}
		return value;
	}
	if (options?.allowDecimal && /^\d+$/.test(normalized)) {
		const value = Number.parseInt(normalized, 10);
		if (Number.isNaN(value)) {
			return undefined;
		}
		return value;
	}
	return undefined;
}

function toHex(value: number, width: number): string {
	const raw = (value >>> 0).toString(16).toUpperCase();
	return `0x${raw.padStart(width, '0')}`;
}

function splitCliArgs(commandLine: string): string[] {
	const args: string[] = [];
	let current = '';
	let quote: '"' | "'" | undefined;

	for (let i = 0; i < commandLine.length; i += 1) {
		const ch = commandLine[i];
		if ((ch === '"' || ch === "'") && !quote) {
			quote = ch;
			continue;
		}
		if (quote && ch === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && /\s/.test(ch)) {
			if (current.length > 0) {
				args.push(current);
				current = '';
			}
			continue;
		}
		current += ch;
	}

	if (current.length > 0) {
		args.push(current);
	}
	return args;
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
	const lastLine = document.lineCount === 0 ? 0 : document.lineCount - 1;
	const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
	return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path, fsModule.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function findFirstMatch(workspaceRoot: string, predicate: (path: string) => boolean, preferredFolders: string[]): Promise<string | undefined> {
	for (const folder of preferredFolders) {
		const full = join(workspaceRoot, folder);
		if (!await pathExists(full)) {
			continue;
		}
		const found = await findFirstMatchRecursive(full, predicate);
		if (found) {
			return found;
		}
	}
	return await findFirstMatchRecursive(workspaceRoot, predicate);
}

async function findFirstMatchRecursive(folder: string, predicate: (path: string) => boolean): Promise<string | undefined> {
	const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [] as DirentLike[]);
	for (const entry of entries) {
		const fullPath = join(folder, entry.name);
		if (entry.isDirectory()) {
			if (isSkippedDirectory(entry.name)) {
				continue;
			}
			const nested = await findFirstMatchRecursive(fullPath, predicate);
			if (nested) {
				return nested;
			}
			continue;
		}
		if (entry.isFile() && predicate(fullPath)) {
			return fullPath;
		}
	}
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
