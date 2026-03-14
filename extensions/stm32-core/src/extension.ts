/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerPhase2Features } from './phase2';

declare const require: (moduleName: string) => any;
declare const process: { platform: string };
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
	promises: {
		readFile: (path: string, encoding: string) => Promise<string>;
		unlink: (path: string) => Promise<void>;
		readdir: (path: string, options?: unknown) => Promise<Array<{ isFile: () => boolean; name: string }>>;
	};
};
const osModule = require('os') as { tmpdir: () => string };
const pathModule = require('path') as { basename: (path: string) => string; join: (...parts: string[]) => string };
const utilModule = require('util') as { promisify: (fn: unknown) => (...args: unknown[]) => Promise<{ stdout: string; stderr: string }> };

const execFile = childProcess.execFile;
const spawn = childProcess.spawn;
const fs = fsModule.promises;
const tmpdir = osModule.tmpdir;
const basename = pathModule.basename;
const join = pathModule.join;
const execFileAsync = utilModule.promisify(execFile);

interface CubeMetadata {
	make_path?: string;
	programmer_path?: string;
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
		vscode.l10n.t('新規STM32プロジェクトは、まず .ioc の作成または既存プロジェクトのインポートから開始します。'),
		vscode.l10n.t('CubeMXを起動'),
		vscode.l10n.t('設定を開く'),
	);

	if (choice === vscode.l10n.t('CubeMXを起動')) {
		await openCubeMx();
	} else if (choice === vscode.l10n.t('設定を開く')) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'stm32.');
	}
}

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
		await execFileAsync(metadataExecutable, ['-j', tempJsonPath], { cwd: workspaceRoot });
		const raw = await fs.readFile(tempJsonPath, 'utf8');
		const parsed = JSON.parse(raw) as CubeMetadata;
		cachedMetadata = parsed;
		outputChannel.appendLine('[STM32] Metadata detected successfully.');
		vscode.window.showInformationMessage(vscode.l10n.t('CubeCLTメタデータを検出しました。'));
		return parsed;
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

	const jobs = vscode.workspace.getConfiguration('stm32').get<number>('build.jobs', 8);
	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const makeExecutable = getMakeExecutable(metadata);

	buildStatusItem.text = '$(loading~spin) STM32: Debugビルド中';
	buildStatusItem.backgroundColor = undefined;

	const result = await runCli(makeExecutable, [`-j${jobs}`, 'all', '-C', './Debug'], workspaceRoot, vscode.l10n.t('Debugビルド'));
	lastBuildOutput = `${result.stdout}\n${result.stderr}`;

	if (result.exitCode === 0) {
		buildStatusItem.text = '$(check) STM32: Debugビルド成功';
		buildStatusItem.backgroundColor = undefined;
		vscode.window.showInformationMessage(vscode.l10n.t('Debugビルドが成功しました。'));
		return true;
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

	const elfPath = await findElfFile(workspaceRoot);
	if (!elfPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('ELFファイルが見つかりません。先にビルドしてください。'));
		return false;
	}

	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const programmerExecutable = getProgrammerExecutable(metadata);
	const frequency = vscode.workspace.getConfiguration('stm32').get<number>('flash.frequencyKHz', 4000);

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('STM32 書込み実行中'), cancellable: false },
		async progress => {
			progress.report({ increment: 5, message: vscode.l10n.t('接続中...') });
			const flashResult = await runCliWithProgress(
				programmerExecutable,
				['-c', 'port=SWD', `freq=${frequency}`, '-w', elfPath, '0x08000000', '-v'],
				workspaceRoot,
				vscode.l10n.t('書込み'),
				increment => progress.report({ increment, message: vscode.l10n.t('進行中...') }),
			);
			progress.report({ increment: 100, message: vscode.l10n.t('完了処理中...') });
			return flashResult;
		},
	);

	if (result.exitCode === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('書込みが完了しました。'));
		return true;
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

	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const programmerExecutable = getProgrammerExecutable(metadata);
	const result = await runCli(programmerExecutable, ['-l', 'usb'], workspaceRoot, vscode.l10n.t('ST-LINK接続確認'));

	const hasLink = /ST-?LINK/i.test(result.stdout + result.stderr);
	if (result.exitCode === 0 && hasLink) {
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

	const configuredPath = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	const cubeMxExecutable = configuredPath.length > 0 ? configuredPath : 'STM32CubeMX';
	const iocPath = await findTopLevelIocFile(workspaceRoot);
	const args = iocPath ? [iocPath] : [];

	try {
		runDetached(cubeMxExecutable, args, workspaceRoot);
		const fileName = iocPath ? basename(iocPath) : vscode.l10n.t('なし');
		vscode.window.showInformationMessage(vscode.l10n.t('CubeMXを起動しました。対象ioc: {0}', fileName));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[STM32] CubeMX launch failed: ${message}`);
		vscode.window.showErrorMessage(vscode.l10n.t('CubeMXの起動に失敗しました。設定を確認してください。'));
	}
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
	gdbServerProcess = spawn(gdbServerExecutable, ['-d', '-v', '-t', '-cp', metadata.programmer_path, '-p', String(port)], { cwd: workspaceRoot, windowsHide: true });

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
	const candidates = ['Debug', 'Release'];
	for (const folder of candidates) {
		const folderPath = join(workspaceRoot, folder);
		const entries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => [] as Array<{ isFile: () => boolean; name: string }>);
		for (const entry of entries) {
			if (entry.isFile() && entry.name.toLowerCase().endsWith('.elf')) {
				return join(folderPath, entry.name);
			}
		}
	}
	return undefined;
}

function runDetached(command: string, args: string[], cwd: string): void {
	const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
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

		const child = spawn(command, args, { cwd, windowsHide: true });
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
		const { stdout, stderr } = await execFileAsync(command, args, { cwd, windowsHide: true });
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
