/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerPhase2Features } from './phase2';

declare const require: (moduleName: string) => any;
declare const process: { platform: string; env: Record<string, string | undefined> };
declare function setInterval(handler: () => void, timeout?: number): number;
declare function clearInterval(id: number): void;

const childProcess = require('child_process') as {
	execFile: (...args: unknown[]) => void;
	spawn: (...args: unknown[]) => {
		stdout?: { on: (event: string, listener: (data: unknown) => void) => void };
		stderr?: { on: (event: string, listener: (data: unknown) => void) => void };
		on: (event: string, listener: (...args: unknown[]) => void) => void;
		kill: () => void;
		unref: () => void;
	};
};
const fsModule = require('fs') as {
	constants: { F_OK: number };
	promises: {
		access: (path: string, mode?: number) => Promise<void>;
		readFile: (path: string, encoding: string) => Promise<string>;
		unlink: (path: string) => Promise<void>;
		stat: (path: string) => Promise<{ mtimeMs: number }>;
		readdir: (path: string, options?: unknown) => Promise<Array<{ isFile: () => boolean; isDirectory: () => boolean; name: string }>>;
	};
};
const osModule = require('os') as { tmpdir: () => string };
const pathModule = require('path') as {
	basename: (path: string) => string;
	join: (...parts: string[]) => string;
	isAbsolute: (path: string) => boolean;
};
const utilModule = require('util') as { promisify: (fn: unknown) => (...args: unknown[]) => Promise<{ stdout: string; stderr: string }> };
const httpModule = require('http') as {
	request: (
		options: { host: string; port: number; path: string; method: string; headers?: Record<string, string | number>; timeout?: number },
		callback: (response: {
			statusCode?: number;
			on: (event: string, listener: (chunk?: unknown) => void) => void;
		}) => void
	) => {
		write: (data: string) => void;
		end: () => void;
		on: (event: string, listener: (error: unknown) => void) => void;
	};
};

const execFile = childProcess.execFile;
const spawn = childProcess.spawn;
const fs = fsModule.promises;
const tmpdir = osModule.tmpdir;
const basename = pathModule.basename;
const join = pathModule.join;
const isAbsolutePath = pathModule.isAbsolute;
const execFileAsync = utilModule.promisify(execFile);
const httpRequest = httpModule.request;

interface CubeMetadata {
	make_path?: string;
	programmer_path?: string;
	GNUToolsForSTM32?: string;
	STM32CubeProgrammer?: string;
	STM32CubeTargetRepo?: string;
	STM32CubeSVDRepo?: string;
	STLinkGDBServer?: string;
	CMake?: string;
	Ninja?: string;
	'st-arm-clang'?: string;
}

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface BuildIssue {
	filePath: string;
	line: number;
	column: number;
	severity: 'error' | 'warning';
	message: string;
}

interface GitRepositoryState {
	HEAD?: { name?: string };
	onDidChange?: vscode.Event<void>;
}

interface GitRepository {
	state: GitRepositoryState;
}

interface GitApi {
	repositories: GitRepository[];
	onDidOpenRepository: vscode.Event<GitRepository>;
	onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
	getAPI(version: 1): GitApi;
}

let outputChannel: vscode.OutputChannel;
let buildStatusItem: vscode.StatusBarItem;
let stLinkStatusItem: vscode.StatusBarItem;
let branchStatusItem: vscode.StatusBarItem;
let cachedMetadata: CubeMetadata | undefined;
let lastBuildOutput = '';
let gdbServerProcess: ReturnType<typeof spawn> | undefined;
let stLinkPollTimer: number | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('STM32 Build/Flash');
	buildStatusItem = vscode.window.createStatusBarItem('status.stm32.build', vscode.StatusBarAlignment.Left, 200);
	stLinkStatusItem = vscode.window.createStatusBarItem('status.stm32.stlink', vscode.StatusBarAlignment.Left, 199);
	branchStatusItem = vscode.window.createStatusBarItem('status.stm32.branch', vscode.StatusBarAlignment.Left, 198);

	buildStatusItem.name = vscode.l10n.t('STM32 Build Status');
	buildStatusItem.text = '$(tools) STM32: 未ビルド';
	buildStatusItem.tooltip = vscode.l10n.t('STM32 build status');
	buildStatusItem.command = 'stm32.buildDebug';

	stLinkStatusItem.name = vscode.l10n.t('STM32 ST-LINK Status');
	stLinkStatusItem.text = '$(debug-disconnect) ST-LINK: 未確認';
	stLinkStatusItem.tooltip = vscode.l10n.t('Run ST-LINK connection check');
	stLinkStatusItem.command = 'stm32.checkStLink';

	branchStatusItem.name = vscode.l10n.t('STM32 Branch Status');
	branchStatusItem.text = '$(git-branch) ブランチ: -';
	branchStatusItem.tooltip = vscode.l10n.t('Current branch from SCM');

	buildStatusItem.show();
	stLinkStatusItem.show();
	branchStatusItem.show();

	context.subscriptions.push(outputChannel, buildStatusItem, stLinkStatusItem, branchStatusItem);
	context.subscriptions.push(vscode.commands.registerCommand('stm32.newProject', () => showNewProjectGuide()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.detectCubeCLT', () => detectCubeCLTMetadata()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.buildDebug', () => buildDebug()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.flash', () => flashLatestBuild()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.buildAndFlash', () => buildAndFlash()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.checkStLink', () => checkStLink()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.openCubeMX', () => openCubeMx()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.jumpToFirstBuildError', () => jumpToFirstBuildError()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.startDebug', () => startDebugSession()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.stopDebug', () => stopDebugSession()));

	registerPhase2Features(context, {
		outputChannel,
		getWorkspaceRoot,
		findTopLevelIocFile,
		openCubeMx,
		runCli
	});

	registerBranchStatus(context);
	startStLinkAutoPolling();
	void autoDetectToolPaths();
}

export function deactivate(): void {
	stopDebugSession().then(undefined, () => undefined);
	if (stLinkPollTimer !== undefined) {
		clearInterval(stLinkPollTimer);
		stLinkPollTimer = undefined;
	}
}

async function showNewProjectGuide(): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t('新規STM32プロジェクトの開始方法を選択してください。'),
		vscode.l10n.t('テンプレートから作成'),
		vscode.l10n.t('CubeMXを起動'),
		vscode.l10n.t('CubeIDEプロジェクトをインポート'),
		vscode.l10n.t('STM32 設定を開く'),
	);

	if (choice === vscode.l10n.t('テンプレートから作成')) {
		await vscode.commands.executeCommand('stm32ux.openTemplateGallery');
	} else if (choice === vscode.l10n.t('CubeMXを起動')) {
		await openCubeMx();
	} else if (choice === vscode.l10n.t('CubeIDEプロジェクトをインポート')) {
		await vscode.commands.executeCommand('stm32.importCubeIDE');
	} else if (choice === vscode.l10n.t('STM32 設定を開く')) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'stm32.');
	}
}

function getWorkspaceRoot(): string | undefined {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('workspacePath', '').trim();
	if (configured.length > 0) {
		const configuredPath = isAbsolutePath(configured) ? configured : join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', configured);
		return configuredPath;
	}

	const fromFolders = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return fromFolders;
}

function getConfiguredMetadataExecutable(): string {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubeclt.metadataPath', '').trim();
	return configured.length > 0 ? configured : 'STM32CubeCLT_metadata';
}

function getMakeExecutable(metadata: CubeMetadata | undefined): string {
	if (metadata?.make_path) {
		return join(metadata.make_path, process.platform === 'win32' ? 'make.exe' : 'make');
	}
	return 'make';
}

function getProgrammerExecutable(metadata: CubeMetadata | undefined): string {
	if (metadata?.programmer_path) {
		return join(metadata.programmer_path, process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI');
	}
	return 'STM32_Programmer_CLI';
}

async function resolveMakeExecutable(metadata: CubeMetadata | undefined): Promise<string> {
	const candidate = getMakeExecutable(metadata);
	if (candidate === 'make') {
		return candidate;
	}
	if (await probeFilePath(candidate)) {
		return candidate;
	}
	outputChannel.appendLine(`[STM32] Configured make not found: ${candidate}. Falling back to PATH make.`);
	return 'make';
}

async function resolveProgrammerExecutable(metadata: CubeMetadata | undefined): Promise<string> {
	const candidate = getProgrammerExecutable(metadata);
	if (candidate === 'STM32_Programmer_CLI') {
		return candidate;
	}
	if (await probeFilePath(candidate)) {
		return candidate;
	}
	outputChannel.appendLine(`[STM32] Configured programmer not found: ${candidate}. Falling back to PATH STM32_Programmer_CLI.`);
	return 'STM32_Programmer_CLI';
}

async function detectCubeCLTMetadata(): Promise<CubeMetadata | undefined> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return undefined;
	}

	const metadataExecutable = getConfiguredMetadataExecutable();
	const tempJsonPath = join(tmpdir(), `stm32-metadata-${Date.now()}.json`);

	try {
		outputChannel.appendLine(`[STM32] Detecting metadata using ${metadataExecutable}`);
		const needsShell = metadataExecutable.endsWith('.bat') || metadataExecutable.endsWith('.sh');
		await execFileAsync(metadataExecutable, ['-j', tempJsonPath], { cwd: workspaceRoot, shell: needsShell });
		let raw = await fs.readFile(tempJsonPath, 'utf8');
		raw = raw.replace(/\\/g, '\\\\');
		const parsed = JSON.parse(raw) as CubeMetadata;
		const metadata: CubeMetadata = {
			make_path: parsed.GNUToolsForSTM32 || parsed.make_path,
			programmer_path: parsed.STM32CubeProgrammer || parsed.programmer_path,
		};
		cachedMetadata = metadata;
		outputChannel.appendLine('[STM32] Metadata detected successfully.');
		outputChannel.appendLine(`[STM32] - GCC: ${metadata.make_path || '(not found)'}`);
		outputChannel.appendLine(`[STM32] - Programmer: ${metadata.programmer_path || '(not found)'}`);

		if (metadata.make_path || metadata.programmer_path) {
			const pathsToAdd: string[] = [];
			if (metadata.make_path) { pathsToAdd.push(metadata.make_path); }
			if (metadata.programmer_path) { pathsToAdd.push(metadata.programmer_path); }

			const currentPath = process.env['PATH'] || '';
			const newPaths = pathsToAdd.filter(p => !currentPath.includes(p));
			if (newPaths.length > 0) {
				process.env['PATH'] = newPaths.join(process.platform === 'win32' ? ';' : ':') + (process.platform === 'win32' ? ';' : ':') + currentPath;
				outputChannel.appendLine(`[STM32] Added to PATH: ${newPaths.join(', ')}`);
			}
		}

		vscode.window.showInformationMessage(vscode.l10n.t('CubeCLTメタデータを検出しました。'));
		return metadata;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[STM32] Metadata detection failed: ${message}`);
		vscode.window.showErrorMessage(vscode.l10n.t('CubeCLTメタデータの検出に失敗しました。設定を確認してください。'));
		return undefined;
	} finally {
		await fs.unlink(tempJsonPath).catch(() => undefined);
	}
}

async function buildDebug(): Promise<boolean> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return false;
	}

	const stm32Config = vscode.workspace.getConfiguration('stm32');
	const jobs = stm32Config.get<number>('build.jobs', 8);
	const backend = (stm32Config.get<string>('build.backend', 'auto') || 'auto').trim().toLowerCase();
	const makeTarget = (stm32Config.get<string>('build.makeTarget', 'all') || 'all').trim();
	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const makeExecutable = await resolveMakeExecutable(metadata);
	const buildDir = await resolveBuildDirectory(workspaceRoot);
	if (!buildDir) {
		buildStatusItem.text = '$(error) STM32: Debugビルド失敗';
		buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		vscode.window.showErrorMessage(vscode.l10n.t('ビルド先を解決できませんでした。`stm32.workspacePath` を確認してください。'));
		return false;
	}

	buildStatusItem.text = '$(loading~spin) STM32: Debugビルド中';
	buildStatusItem.backgroundColor = undefined;
	outputChannel.appendLine(`[STM32] Build backend: ${backend}`);
	outputChannel.appendLine(`[STM32] Using build directory: ${buildDir === workspaceRoot ? '.' : buildDir}`);

	const makefileInBuildDir = await directoryContainsMakefile(buildDir);
	if (backend === 'mcp') {
		return await runMcpBuildAndReport(workspaceRoot, vscode.l10n.t('MCP指定'));
	}

	if (backend === 'auto' && !makefileInBuildDir) {
		outputChannel.appendLine('[STM32] Makefile not found in resolved build directory. Using MCP build backend.');
		return await runMcpBuildAndReport(workspaceRoot, vscode.l10n.t('Makefile未検出'));
	}

	if (backend === 'make' && !makefileInBuildDir) {
		buildStatusItem.text = '$(error) STM32: Debugビルド失敗';
		buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		vscode.window.showErrorMessage(vscode.l10n.t('make backend が指定されていますが Makefile が見つかりません。`stm32.build.backend` を auto または mcp に変更してください。'));
		return false;
	}

	const makeArgs = [`-j${jobs}`];
	if (makeTarget.length > 0) {
		makeArgs.push(makeTarget);
	}
	if (buildDir !== workspaceRoot) {
		makeArgs.push('-C', buildDir);
	}

	let result = await runCli(makeExecutable, makeArgs, workspaceRoot, vscode.l10n.t('Debugビルド'));
	if (result.exitCode !== 0 && makeTarget.length > 0 && shouldRetryMakeWithoutExplicitTarget(result.stdout + '\n' + result.stderr)) {
		outputChannel.appendLine('[STM32] Retrying make without explicit target because requested target was not found.');
		const retryArgs = [`-j${jobs}`];
		if (buildDir !== workspaceRoot) {
			retryArgs.push('-C', buildDir);
		}
		result = await runCli(makeExecutable, retryArgs, workspaceRoot, vscode.l10n.t('Debugビルド (targetなし再試行)'));
	}
	lastBuildOutput = `${result.stdout}\n${result.stderr}`;

	if (result.exitCode === 0) {
		buildStatusItem.text = '$(check) STM32: Debugビルド成功';
		buildStatusItem.backgroundColor = undefined;
		vscode.window.showInformationMessage(vscode.l10n.t('Debugビルドが成功しました。'));
		return true;
	}

	if (backend === 'auto' && shouldTryMcpBuildFallback(lastBuildOutput)) {
		outputChannel.appendLine('[STM32] make build failed. Trying MCP build fallback...');
		const fallbackOk = await runMcpBuildAndReport(workspaceRoot, vscode.l10n.t('make失敗フォールバック'));
		if (fallbackOk) {
			return true;
		}
	}

	buildStatusItem.text = '$(error) STM32: Debugビルド失敗';
	buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	const hint = getJapaneseErrorHint(lastBuildOutput);
	if (hint) {
		outputChannel.appendLine(`[STM32] Hint: ${hint}`);
	}
	const action = await vscode.window.showErrorMessage(vscode.l10n.t('Debugビルドに失敗しました。出力を確認してください。'), vscode.l10n.t('最初のエラーへ移動'));
	if (action === vscode.l10n.t('最初のエラーへ移動')) {
		await jumpToFirstBuildError();
	}
	return false;
}

async function flashLatestBuild(): Promise<boolean> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return false;
	}
	const stLinkConnected = await isStLinkConnected(workspaceRoot);
	if (!stLinkConnected) {
		stLinkStatusItem.text = '$(debug-disconnect) ST-LINK: 未接続';
		stLinkStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		vscode.window.showErrorMessage(vscode.l10n.t('ST-LINKが未接続です。接続状態を確認してください。'));
		return false;
	}

	const elfPath = await findElfFile(workspaceRoot);
	if (!elfPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('ELFファイルが見つかりません。先にビルドしてください。'));
		return false;
	}

	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const programmerExecutable = await resolveProgrammerExecutable(metadata);
	const frequency = vscode.workspace.getConfiguration('stm32').get<number>('flash.frequencyKHz', 4000);

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('STM32 書込み実行中'), cancellable: false },
		async progress => {
			progress.report({ increment: 5, message: vscode.l10n.t('接続中...') });
			const flashResult = await runCliWithProgress(
				programmerExecutable,
				['-c', 'port=SWD', `freq=${frequency}`, '-w', elfPath, '-v', '-rst'],
				workspaceRoot,
				vscode.l10n.t('書込み'),
				increment => progress.report({ increment, message: vscode.l10n.t('進行中...') }),
			);
			progress.report({ increment: 100, message: vscode.l10n.t('完了処理中...') });
			return flashResult;
		},
	);

	if (result.exitCode === 0) {
		const combined = `${result.stdout}\n${result.stderr}`;
		const hasSuccessSignature = /(Download verified successfully|Verification\s*\.\.\.\s*OK|File download complete|Download complete)/i.test(combined);
		const hasFailureSignature = /(Error:|No ST-?LINK detected|STLink not found|Cannot connect|No STM32 target found|failed)/i.test(combined);
		if (hasSuccessSignature && !hasFailureSignature) {
			vscode.window.showInformationMessage(vscode.l10n.t('書込みが完了しました。'));
			return true;
		}
		outputChannel.appendLine('[STM32] Flash command exited with code 0 but verification signature was not detected.');
	}

	vscode.window.showErrorMessage(vscode.l10n.t('書込みに失敗しました。出力を確認してください。'));
	return false;
}

async function buildAndFlash(): Promise<void> {
	const buildOk = await buildDebug();
	if (!buildOk) {
		return;
	}

	const selection = await vscode.window.showInformationMessage(vscode.l10n.t('ビルド成功。続けて書込みを実行しますか？'), vscode.l10n.t('書込みを実行'), vscode.l10n.t('キャンセル'));
	if (selection === vscode.l10n.t('書込みを実行')) {
		await flashLatestBuild();
	}
}

async function checkStLink(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	const hasLink = await isStLinkConnected(workspaceRoot);
	if (hasLink) {
		stLinkStatusItem.text = '$(plug) ST-LINK: 接続中';
		stLinkStatusItem.backgroundColor = undefined;
		return;
	}

	stLinkStatusItem.text = '$(debug-disconnect) ST-LINK: 未接続';
	stLinkStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

async function openCubeMx(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}

	const cubeMxExecutable = await resolveCubeMxExecutable();
	const iocPath = await findTopLevelIocFile(workspaceRoot);
	const args = iocPath ? [iocPath] : [];

	try {
		runDetached(cubeMxExecutable, args, workspaceRoot);
		const fileName = iocPath ? basename(iocPath) : vscode.l10n.t('なし');
		vscode.window.showInformationMessage(vscode.l10n.t('CubeMXを起動しました。対象ioc: {0}', fileName));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[STM32] CubeMX launch failed: ${message}`);
		vscode.window.showErrorMessage(vscode.l10n.t('CubeMXの起動に失敗しました。`stm32.cubemx.path` は実行ファイルまたはインストールフォルダを指定してください。'));
	}
}

async function resolveCubeMxExecutable(): Promise<string> {
	const configuredPath = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	if (configuredPath.length === 0) {
		return 'STM32CubeMX';
	}

	const isExecutablePath = configuredPath.toLowerCase().endsWith('.exe') || configuredPath.toLowerCase().endsWith('stm32cubemx');
	if (isExecutablePath) {
		return configuredPath;
	}

	const candidate = join(configuredPath, process.platform === 'win32' ? 'STM32CubeMX.exe' : 'STM32CubeMX');
	if (await probeFilePath(candidate)) {
		return candidate;
	}

	return configuredPath;
}

async function jumpToFirstBuildError(): Promise<void> {
	const issues = parseBuildIssues(lastBuildOutput);
	const firstError = issues.find(issue => issue.severity === 'error') ?? issues[0];
	if (!firstError) {
		vscode.window.showInformationMessage(vscode.l10n.t('解析可能なビルドエラーが見つかりませんでした。'));
		return;
	}

	const document = await vscode.workspace.openTextDocument(firstError.filePath);
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	const position = new vscode.Position(Math.max(0, firstError.line - 1), Math.max(0, firstError.column - 1));
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function startDebugSession(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('ワークスペースを開いてから実行してください。'));
		return;
	}

	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	if (!metadata?.programmer_path) {
		vscode.window.showErrorMessage(vscode.l10n.t('CubeCLTメタデータからProgrammerパスを取得できません。'));
		return;
	}

	const elfPath = await findElfFile(workspaceRoot);
	if (!elfPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('ELFファイルが見つかりません。先にビルドしてください。'));
		return;
	}

	await stopDebugSession();

	const port = vscode.workspace.getConfiguration('stm32').get<number>('debug.gdbServerPort', 61234);
	const gdbServerExecutable = join(metadata.programmer_path, process.platform === 'win32' ? 'ST-LINK_gdbserver.exe' : 'ST-LINK_gdbserver');
	outputChannel.appendLine(`[STM32] Starting ST-LINK GDB Server on port ${port}`);
	const needsShell = gdbServerExecutable.endsWith('.bat') || gdbServerExecutable.endsWith('.sh');
	gdbServerProcess = spawn(gdbServerExecutable, ['-d', '-v', '-t', '-cp', metadata.programmer_path, '-p', String(port)], { cwd: workspaceRoot, windowsHide: true, shell: needsShell });

	gdbServerProcess.stdout?.on('data', (data: unknown) => outputChannel.appendLine(String(data)));
	gdbServerProcess.stderr?.on('data', (data: unknown) => outputChannel.appendLine(String(data)));
	gdbServerProcess.on('exit', (code: unknown) => {
		outputChannel.appendLine(`[STM32] ST-LINK GDB Server exited (${code ?? -1}).`);
		gdbServerProcess = undefined;
	});

	const debugConfiguration: vscode.DebugConfiguration = {
		name: 'STM32 Debug (ST-LINK)',
		type: 'cppdbg',
		request: 'launch',
		program: elfPath,
		cwd: workspaceRoot,
		MIMode: 'gdb',
		miDebuggerPath: 'arm-none-eabi-gdb',
		miDebuggerServerAddress: `localhost:${port}`,
		stopAtEntry: true,
		externalConsole: false
	};

	const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], debugConfiguration);
	if (!started) {
		await stopDebugSession();
		vscode.window.showErrorMessage(vscode.l10n.t('デバッグセッションを開始できませんでした。'));
		return;
	}

	vscode.window.showInformationMessage(vscode.l10n.t('デバッグセッションを開始しました。F9/F10/F11/F12 を利用できます。'));
}

async function stopDebugSession(): Promise<void> {
	if (vscode.debug.activeDebugSession) {
		await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
	}
	if (gdbServerProcess) {
		gdbServerProcess.kill();
		gdbServerProcess = undefined;
	}
}

async function findTopLevelIocFile(workspaceRoot: string): Promise<string | undefined> {
	const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
	const file = entries.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.ioc'));
	return file ? join(workspaceRoot, file.name) : undefined;
}

async function findElfFile(workspaceRoot: string): Promise<string | undefined> {
	const folderCandidates = await getBuildDirectoryCandidates(workspaceRoot);
	const found: Array<{ path: string; mtimeMs: number }> = [];

	for (const folderPath of folderCandidates) {
		const entries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => [] as Array<{ isFile: () => boolean; name: string }>);
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.elf')) {
				continue;
			}
			const elfPath = join(folderPath, entry.name);
			const stat = await fs.stat(elfPath).catch(() => undefined);
			if (!stat) {
				continue;
			}
			found.push({ path: elfPath, mtimeMs: stat.mtimeMs });
		}
	}

	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found[0]?.path;
}

async function resolveBuildDirectory(workspaceRoot: string): Promise<string | undefined> {
	const configuredBuildDir = vscode.workspace.getConfiguration('stm32').get<string>('build.directory', '').trim();
	let configuredCandidate: string | undefined;
	if (configuredBuildDir.length > 0) {
		configuredCandidate = isAbsolutePath(configuredBuildDir) ? configuredBuildDir : join(workspaceRoot, configuredBuildDir);
		if (await directoryContainsMakefile(configuredCandidate)) {
			return configuredCandidate;
		}
	}

	const candidates = await getBuildDirectoryCandidates(workspaceRoot);
	for (const candidate of candidates) {
		if (await directoryContainsMakefile(candidate)) {
			return candidate;
		}
	}

	if (await directoryContainsMakefile(workspaceRoot)) {
		return workspaceRoot;
	}

	if (configuredCandidate && await isExistingDirectory(configuredCandidate)) {
		// Some generated projects stage artifacts here but keep the top-level Makefile elsewhere.
		return configuredCandidate;
	}

	return workspaceRoot;
}

async function getBuildDirectoryCandidates(workspaceRoot: string): Promise<string[]> {
	const configuredBuildDir = vscode.workspace.getConfiguration('stm32').get<string>('build.directory', '').trim();
	const candidates = new Set<string>();

	if (configuredBuildDir.length > 0) {
		candidates.add(isAbsolutePath(configuredBuildDir) ? configuredBuildDir : join(workspaceRoot, configuredBuildDir));
	}

	candidates.add(join(workspaceRoot, 'Debug'));
	candidates.add(join(workspaceRoot, 'Release'));
	candidates.add(join(workspaceRoot, 'build', 'Debug'));
	candidates.add(join(workspaceRoot, 'build', 'Release'));
	candidates.add(join(workspaceRoot, 'Build', 'Debug'));
	candidates.add(join(workspaceRoot, 'Build', 'Release'));

	const topLevel = await fs.readdir(workspaceRoot, { withFileTypes: true }).catch(() => [] as Array<{ isDirectory: () => boolean; name: string }>);
	for (const entry of topLevel) {
		if (!entry.isDirectory()) {
			continue;
		}
		const name = entry.name.toLowerCase();
		if (name.includes('debug') || name.includes('release')) {
			candidates.add(join(workspaceRoot, entry.name));
		}
	}

	return Array.from(candidates);
}

async function directoryContainsMakefile(dirPath: string): Promise<boolean> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [] as Array<{ isFile: () => boolean; name: string }>);
	return entries.some(entry => entry.isFile() && entry.name.toLowerCase() === 'makefile');
}

async function isExistingDirectory(dirPath: string): Promise<boolean> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => undefined);
	return Array.isArray(entries);
}

async function isStLinkConnected(workspaceRoot: string): Promise<boolean> {
	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const programmerExecutable = await resolveProgrammerExecutable(metadata);
	const commands: string[][] = [
		['-c', 'port=SWD', '-l'],
		['-c', 'port=SWD'],
		['-l'],
	];

	for (const args of commands) {
		const result = await runCli(programmerExecutable, args, workspaceRoot, vscode.l10n.t('ST-LINK接続確認'));
		if (isSuccessfulStLinkOutput(result)) {
			return true;
		}
	}

	return false;
}

function isSuccessfulStLinkOutput(result: CliResult): boolean {
	const text = `${result.stdout}\n${result.stderr}`;
	const hasLink = /ST-?LINK|STLink|ST-LINK SN|ST-LINK\s*Probe|Connected to target|Target connected|Device ID|Chip ID|STM32|Memory map|Read out protection/i.test(text);
	const hasNegative = /No ST-?LINK|0\s*ST-?LINK|not found|cannot find|no debug probe|Error: No STM32|failed to connect|Cannot connect/i.test(text);
	return result.exitCode === 0 && hasLink && !hasNegative;
}

function shouldTryMcpBuildFallback(output: string): boolean {
	return /No rule to make target|no makefile found|can't find .*Makefile|ターゲット .* ルールがありません|makefile も見つかりません/i.test(output);
}

function shouldRetryMakeWithoutExplicitTarget(output: string): boolean {
	return /No rule to make target|ターゲット .* ルールがありません|don't know how to make/i.test(output);
}

async function runMcpBuildAndReport(workspaceRoot: string, reason: string): Promise<boolean> {
	const fallback = await tryMcpBuildFallback(workspaceRoot);
	if (fallback.success) {
		buildStatusItem.text = '$(check) STM32: Debugビルド成功 (MCP)';
		buildStatusItem.backgroundColor = undefined;
		vscode.window.showInformationMessage(vscode.l10n.t('Debugビルドが成功しました。(MCP: {0})', reason));
		return true;
	}

	buildStatusItem.text = '$(error) STM32: Debugビルド失敗';
	buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	outputChannel.appendLine(`[STM32] MCP build failed (${reason}): ${fallback.message}`);
	return false;
}

async function tryMcpBuildFallback(workspaceRoot: string): Promise<{ success: boolean; message: string }> {
	const config = vscode.workspace.getConfiguration();
	const host = config.get<string>('stm32ux.mcp.host', '127.0.0.1');
	const configuredPort = config.get<number>('stm32ux.mcp.port', 8754);
	const ports = Array.from(new Set([configuredPort, 8754, 3737]));

	const payload = JSON.stringify({
		jsonrpc: '2.0',
		id: Date.now(),
		method: 'stm32.build',
		params: {
			workspacePath: workspaceRoot
		}
	});

	let lastError = 'MCP request was not attempted';
	for (const port of ports) {
		try {
			outputChannel.appendLine(`[STM32] Trying MCP build on ${host}:${port}`);
			const responseText = await postJson(host, port, '/mcp', payload);
			const parsed = JSON.parse(responseText) as { result?: { success?: boolean; stdout?: string; stderr?: string; error?: string }; error?: { message?: string } };
			if (parsed.result?.stdout) {
				outputChannel.appendLine(parsed.result.stdout);
			}
			if (parsed.result?.stderr) {
				outputChannel.appendLine(parsed.result.stderr);
			}
			if (parsed.result?.success) {
				return { success: true, message: 'ok' };
			}
			lastError = parsed.result?.error ?? parsed.error?.message ?? `MCP responded with failure on port ${port}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	return { success: false, message: lastError };
}

async function postJson(host: string, port: number, path: string, body: string): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const request = httpRequest(
			{
				host,
				port,
				path,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body)
				},
				timeout: 20000
			},
			response => {
				let raw = '';
				response.on('data', chunk => {
					raw += String(chunk);
				});
				response.on('end', () => {
					if ((response.statusCode ?? 500) >= 400) {
						reject(new Error(`HTTP ${response.statusCode ?? 500}: ${raw}`));
						return;
					}
					resolve(raw);
				});
			}
		);
		request.on('error', error => {
			reject(error instanceof Error ? error : new Error(String(error)));
		});
		request.write(body);
		request.end();
	});
}

function runDetached(command: string, args: string[], cwd: string): void {
	const needsShell = command.endsWith('.bat') || command.endsWith('.sh');
	const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: needsShell });
	child.unref();
}

async function runCliWithProgress(command: string, args: string[], cwd: string, title: string, onProgress: (increment: number) => void): Promise<CliResult> {
	outputChannel.show(true);
	outputChannel.appendLine(`\n[STM32] ${title}`);
	outputChannel.appendLine(`[STM32] Command: ${command} ${args.join(' ')}`);

	return await new Promise<CliResult>(resolve => {
		let stdout = '';
		let stderr = '';
		let lastProgress = 0;

		const needsShell = command.endsWith('.bat') || command.endsWith('.sh');
		const child = spawn(command, args, { cwd, windowsHide: true, shell: needsShell });
		const updateProgress = (text: string) => {
			const match = text.match(/(\d{1,3})\s*%/);
			if (match) {
				const percent = Math.min(100, Number(match[1]));
				const increment = Math.max(0, percent - lastProgress);
				if (increment > 0) {
					onProgress(increment);
					lastProgress = percent;
				}
			} else if (lastProgress < 90) {
				lastProgress += 5;
				onProgress(5);
			}
		};

		child.stdout?.on('data', (data: unknown) => {
			const text = String(data);
			stdout += text;
			outputChannel.append(text);
			updateProgress(text);
		});

		child.stderr?.on('data', (data: unknown) => {
			const text = String(data);
			stderr += text;
			outputChannel.append(text);
			updateProgress(text);
		});

		child.on('error', (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			stderr += message;
			outputChannel.appendLine(message);
			resolve({ exitCode: 1, stdout, stderr });
		});

		child.on('close', (code: unknown) => {
			if (lastProgress < 100) {
				onProgress(100 - lastProgress);
			}
			resolve({ exitCode: typeof code === 'number' ? code : 1, stdout, stderr });
		});
	});
}

async function runCli(command: string, args: string[], cwd: string, title: string): Promise<CliResult> {
	outputChannel.show(true);
	outputChannel.appendLine(`\n[STM32] ${title}`);
	outputChannel.appendLine(`[STM32] Command: ${command} ${args.join(' ')}`);

	try {
		const needsShell = command.endsWith('.bat') || command.endsWith('.sh');
		const { stdout, stderr } = await execFileAsync(command, args, { cwd, windowsHide: true, shell: needsShell });
		if (stdout.length > 0) {
			outputChannel.appendLine(stdout);
		}
		if (stderr.length > 0) {
			outputChannel.appendLine(stderr);
		}
		outputChannel.appendLine(`[STM32] ${title} completed.`);
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
		const stdout = err.stdout ?? '';
		const stderr = err.stderr ?? err.message ?? '';
		if (stdout.length > 0) {
			outputChannel.appendLine(stdout);
		}
		if (stderr.length > 0) {
			outputChannel.appendLine(stderr);
		}
		const exitCode = typeof err.code === 'number' ? err.code : 1;
		outputChannel.appendLine(`[STM32] ${title} failed (exit code: ${exitCode}).`);
		return { exitCode, stdout, stderr };
	}
}

function parseBuildIssues(output: string): BuildIssue[] {
	const issues: BuildIssue[] = [];
	const issueRegex = /^(.+?):(\d+):(\d+):\s*(warning|error):\s*(.+)$/gm;
	for (const match of output.matchAll(issueRegex)) {
		issues.push({
			filePath: match[1],
			line: Number(match[2]),
			column: Number(match[3]),
			severity: match[4] === 'error' ? 'error' : 'warning',
			message: match[5]
		});
	}
	return issues;
}

function getJapaneseErrorHint(output: string): string | undefined {
	const hints: Array<{ pattern: RegExp; hint: string }> = [
		{ pattern: /undeclared/i, hint: '未宣言の識別子です。ioc設定で対象ペリフェラルが有効か確認してください。' },
		{ pattern: /No such file or directory/i, hint: 'ヘッダまたはソースが見つかりません。インクルードパスと生成コードを確認してください。' },
		{ pattern: /undefined reference/i, hint: 'リンカエラーです。ソース未追加、または関数シグネチャ不一致の可能性があります。' },
		{ pattern: /multiple definition/i, hint: '同一シンボルが複数定義されています。重複実装や重複リンクを確認してください。' },
		{ pattern: /collect2: error/i, hint: 'リンク工程で失敗しました。直前のエラー行を確認してください。' },
		{ pattern: /region .* overflowed/i, hint: 'メモリ領域を超過しました。不要機能の削減や最適化を検討してください。' }
	];

	for (const { pattern, hint } of hints) {
		if (pattern.test(output)) {
			return hint;
		}
	}

	return undefined;
}

function registerBranchStatus(context: vscode.ExtensionContext): void {
	const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
	if (!gitExtension) {
		return;
	}

	gitExtension.activate().then(exports => {
		const gitApi = exports.getAPI(1);
		const update = () => {
			const activeRepo = gitApi.repositories[0];
			const branchName = activeRepo?.state.HEAD?.name ?? '-';
			branchStatusItem.text = `$(git-branch) ${branchName}`;
		};

		for (const repository of gitApi.repositories) {
			if (repository.state.onDidChange) {
				context.subscriptions.push(repository.state.onDidChange(update));
			}
		}
		context.subscriptions.push(gitApi.onDidOpenRepository(update));
		context.subscriptions.push(gitApi.onDidCloseRepository(update));
		update();
	}).then(undefined, () => undefined);
}

async function autoDetectToolPaths(): Promise<void> {
	const config = vscode.workspace.getConfiguration('stm32');
	const isWin = process.platform === 'win32';
	const localApp = process.env['LOCALAPPDATA'] ?? (isWin ? 'C:\\Users\\Public' : '');
	const programFiles = process.env['ProgramFiles'] ?? (isWin ? 'C:\\Program Files' : '');
	const programFilesX86 = process.env['ProgramFiles(x86)'] ?? (isWin ? 'C:\\Program Files (x86)' : '');

	if (!config.get<string>('cubemx.path', '').trim()) {
		const cubeMxCandidates = isWin ? [
			join(localApp, 'Programs', 'STM32CubeMX', 'STM32CubeMX.exe'),
			join(programFiles, 'STMicroelectronics', 'STM32Cube', 'STM32CubeMX', 'STM32CubeMX.exe'),
			join(programFilesX86, 'STMicroelectronics', 'STM32Cube', 'STM32CubeMX', 'STM32CubeMX.exe'),
			'C:\\ST\\STM32CubeMX\\STM32CubeMX.exe',
		] : [
			'/opt/STM32CubeMX/STM32CubeMX',
			'/usr/local/STMicroelectronics/STM32Cube/STM32CubeMX/STM32CubeMX',
		];
		for (const candidate of cubeMxCandidates) {
			const found = await probeFilePath(candidate);
			if (found) {
				await config.update('cubemx.path', candidate, vscode.ConfigurationTarget.Global);
				outputChannel.appendLine(`[STM32] Auto-detected CubeMX at: ${candidate}`);
				break;
			}
		}
	}

	if (!config.get<string>('cubeclt.metadataPath', '').trim()) {
		const cltRoots = isWin ? [
			'E:\\installs\\cubeCLT',
			'C:\\ST',
			join(programFiles, 'STMicroelectronics'),
			join(programFilesX86, 'STMicroelectronics'),
		] : [
			'/opt/st',
			'/usr/local/STMicroelectronics',
		];
		const metadataNames = isWin ? ['STM32CubeCLT_metadata.bat', 'STM32CubeCLT_metadata.exe'] : ['STM32CubeCLT_metadata.sh', 'STM32CubeCLT_metadata'];
		for (const root of cltRoots) {
			const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Array<{ isFile: () => boolean; isDirectory: () => boolean; name: string }>);
			const cltDir = dirs.find(d => d.isDirectory() && d.name.startsWith('STM32CubeCLT'));
			if (cltDir) {
				for (const metadataName of metadataNames) {
					const exePath = join(root, cltDir.name, metadataName);
					const found = await probeFilePath(exePath);
					if (found) {
						await config.update('cubeclt.metadataPath', exePath, vscode.ConfigurationTarget.Global);
						outputChannel.appendLine(`[STM32] Auto-detected CubeCLT at: ${exePath}`);
						break;
					}
				}
			}
		}
	}
}

async function probeFilePath(filePath: string): Promise<boolean> {
	try {
		await fsModule.promises.access(filePath, fsModule.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function startStLinkAutoPolling(): void {
	if (!vscode.workspace.getConfiguration('stm32').get<boolean>('status.autoCheckStLink', true)) {
		return;
	}
	if (stLinkPollTimer !== undefined) {
		clearInterval(stLinkPollTimer);
	}
	stLinkPollTimer = setInterval(() => {
		checkStLink().then(undefined, () => undefined);
	}, 15000);
}
