/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerPhase2Features } from './phase2';
import { autoCheckProjectHealth, diagnoseAndFixProject, healthCheckCommand } from './extension-diagnostics';

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
	existsSync: (path: string) => boolean;
	readdirSync: (path: string, options: { withFileTypes: true }) => Array<{ isDirectory: () => boolean; name: string }>;
	readFileSync: (path: string, encoding: string) => string;
	writeFileSync: (path: string, data: string, encoding: string) => void;
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
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionContext = context;
	outputChannel = vscode.window.createOutputChannel('STM32', { log: true });
	outputChannel.appendLine('[STM32] Extension activated.');

	buildStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	buildStatusItem.command = 'stm32.buildDebug';
	buildStatusItem.text = vscode.l10n.t('$(tools) STM32: Build');
	buildStatusItem.show();
	context.subscriptions.push(buildStatusItem);

	stLinkStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	stLinkStatusItem.command = 'stm32.checkStLink';
	stLinkStatusItem.text = vscode.l10n.t('$(plug) ST-LINK: Checking...');
	stLinkStatusItem.show();
	context.subscriptions.push(stLinkStatusItem);

	// Auto-diagnose project health on startup (skip if recently regenerated)
	setTimeout(() => {
		const lastRegenTime = context.globalState.get<number>('lastRegenerateTime', 0);
		const now = Date.now();
		if (now - lastRegenTime > 10000) { // Skip if regenerated within last 10 seconds
			autoCheckProjectHealth(getWorkspaceRoot(), outputChannel);
		}
	}, 2000);
	buildStatusItem.command = 'stm32.buildDebug';

	stLinkStatusItem.name = vscode.l10n.t('STM32 ST-LINK Status');
	stLinkStatusItem.text = vscode.l10n.t('$(debug-disconnect) ST-LINK: Unknown');
	stLinkStatusItem.tooltip = vscode.l10n.t('Run ST-LINK connection check');

	branchStatusItem = vscode.window.createStatusBarItem('status.stm32.branch', vscode.StatusBarAlignment.Left, 198);
	branchStatusItem.name = vscode.l10n.t('STM32 Branch Status');
	branchStatusItem.text = vscode.l10n.t('$(git-branch) Branch: -');
	branchStatusItem.tooltip = vscode.l10n.t('Current branch from SCM');
	branchStatusItem.show();

	context.subscriptions.push(outputChannel, buildStatusItem, stLinkStatusItem, branchStatusItem);
	context.subscriptions.push(vscode.commands.registerCommand('stm32.newProject', () => showNewProjectGuide()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.detectCubeCLT', () => detectCubeCLTMetadata()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.buildDebug', buildDebug));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.flashLatestBuild', flashLatestBuild));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.buildAndFlash', buildAndFlash));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.checkStLink', checkStLink));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.detectCubeCLTMetadata', detectCubeCLTMetadata));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.diagnoseAndFixProject', () => diagnoseAndFixProject(getWorkspaceRoot(), outputChannel)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.healthCheck', () => healthCheckCommand(getWorkspaceRoot(), outputChannel)));
	context.subscriptions.push(vscode.commands.registerCommand('stm32.regenerateWithCubeMX', regenerateWithCubeMX));
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
		vscode.l10n.t('Choose how to start a new STM32 project.'),
		vscode.l10n.t('Create from Template'),
		vscode.l10n.t('Launch CubeMX'),
		vscode.l10n.t('Import CubeIDE Project'),
		vscode.l10n.t('Open STM32 Settings'),
	);

	if (choice === vscode.l10n.t('Create from Template')) {
		await vscode.commands.executeCommand('stm32ux.openTemplateGallery');
	} else if (choice === vscode.l10n.t('Launch CubeMX')) {
		await openCubeMx();
	} else if (choice === vscode.l10n.t('Import CubeIDE Project')) {
		await vscode.commands.executeCommand('stm32.importCubeIDE');
	} else if (choice === vscode.l10n.t('Open STM32 Settings')) {
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
	if (candidate !== 'STM32_Programmer_CLI') {
		if (await probeFilePath(candidate)) {
			return candidate;
		}
		outputChannel.appendLine(`[STM32] Configured programmer not found: ${candidate}.`);
	}
	// Well-known fallback locations
	const fallbackDirs = process.platform === 'win32' ? [
		'E:\\installs\\CubeProg\\bin',
		'C:\\ST\\STM32CubeProgrammer\\bin',
		join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin'),
	] : [
		'/opt/st/stm32cubeprogrammer/bin',
		'/usr/local/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin',
	];
	const cliName = process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI';
	for (const dir of fallbackDirs) {
		const fullPath = join(dir, cliName);
		if (await probeFilePath(fullPath)) {
			outputChannel.appendLine(`[STM32] Using fallback programmer: ${fullPath}`);
			return fullPath;
		}
	}
	return 'STM32_Programmer_CLI';
}

async function detectCubeCLTMetadata(): Promise<CubeMetadata | undefined> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace before running this command.'));
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

		vscode.window.showInformationMessage(vscode.l10n.t('CubeCLT metadata detected successfully.'));
		return metadata;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[STM32] Metadata detection failed: ${message}`);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to detect CubeCLT metadata. Check your settings.'));
		return undefined;
	} finally {
		await fs.unlink(tempJsonPath).catch(() => undefined);
	}
}

async function buildDebug(): Promise<boolean> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace before running this command.'));
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
		buildStatusItem.text = vscode.l10n.t('$(error) STM32: Build Failed');
		buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		vscode.window.showErrorMessage(vscode.l10n.t('Could not resolve build directory. Check `stm32.workspacePath`.'));
		return false;
	}

	buildStatusItem.text = vscode.l10n.t('$(loading~spin) STM32: Building...');
	buildStatusItem.backgroundColor = undefined;
	outputChannel.appendLine(`[STM32] Build backend: ${backend}`);
	outputChannel.appendLine(`[STM32] Using build directory: ${buildDir === workspaceRoot ? '.' : buildDir}`);

	const makefileInBuildDir = await directoryContainsMakefile(buildDir);
	if (makefileInBuildDir) {
		healMakefileIncludes(buildDir, workspaceRoot);
	}
	if (backend === 'mcp') {
		return await runMcpBuildAndReport(workspaceRoot, vscode.l10n.t('MCP backend specified'));
	}

	if (backend === 'auto' && !makefileInBuildDir) {
		outputChannel.appendLine('[STM32] Makefile not found in resolved build directory. Using MCP build backend.');
		return await runMcpBuildAndReport(workspaceRoot, vscode.l10n.t('Makefile not found'));
	}

	if (backend === 'make' && !makefileInBuildDir) {
		buildStatusItem.text = vscode.l10n.t('$(error) STM32: Build Failed');
		buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		vscode.window.showErrorMessage(vscode.l10n.t('make backend is specified but no Makefile was found. Change `stm32.build.backend` to auto or mcp.'));
		return false;
	}

	const makeArgs = [`-j${jobs}`];
	if (makeTarget.length > 0) {
		makeArgs.push(makeTarget);
	}
	if (buildDir !== workspaceRoot) {
		makeArgs.push('-C', buildDir);
	}

	let result = await runCli(makeExecutable, makeArgs, workspaceRoot, vscode.l10n.t('Debug Build'));
	if (result.exitCode !== 0 && makeTarget.length > 0 && shouldRetryMakeWithoutExplicitTarget(result.stdout + '\n' + result.stderr)) {
		outputChannel.appendLine('[STM32] Retrying make without explicit target because requested target was not found.');
		const retryArgs = [`-j${jobs}`];
		if (buildDir !== workspaceRoot) {
			retryArgs.push('-C', buildDir);
		}
		result = await runCli(makeExecutable, retryArgs, workspaceRoot, vscode.l10n.t('Debug Build (retry without target)'));
	}
	lastBuildOutput = `${result.stdout}\n${result.stderr}`;

	if (result.exitCode === 0) {
		buildStatusItem.text = vscode.l10n.t('$(check) STM32: Build OK');
		buildStatusItem.backgroundColor = undefined;

		// CRITICAL: Verify ELF file was actually generated
		const elfPath = await findElfFile(workspaceRoot);
		if (!elfPath) {
			outputChannel.appendLine('[TovaIDE] WARNING: Build succeeded but no ELF file found!');
			vscode.window.showWarningMessage(
				vscode.l10n.t('Build succeeded but no ELF file found. Check your Makefile settings.'),
				vscode.l10n.t('Run Diagnostics')
			).then(choice => {
				if (choice === vscode.l10n.t('Run Diagnostics')) {
					vscode.commands.executeCommand('stm32.healthCheck');
				}
			});
		} else {
			outputChannel.appendLine(`[TovaIDE] Build succeeded. ELF: ${elfPath}`);
			vscode.window.showInformationMessage(vscode.l10n.t('Debug build succeeded.'));
		}
		return true;
	}

	if (backend === 'auto' && shouldTryMcpBuildFallback(lastBuildOutput)) {
		outputChannel.appendLine('[STM32] make build failed. Trying MCP build fallback...');
		const fallbackOk = await runMcpBuildAndReport(workspaceRoot, vscode.l10n.t('make failed fallback'));
		if (fallbackOk) {
			return true;
		}
	}

	buildStatusItem.text = vscode.l10n.t('$(error) STM32: Build Failed');
	buildStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	const hint = getJapaneseErrorHint(lastBuildOutput);
	if (hint) {
		outputChannel.appendLine(`[STM32] Hint: ${hint}`);
	}
	const action = await vscode.window.showErrorMessage(vscode.l10n.t('Debug build failed. Check the output panel.'), vscode.l10n.t('Jump to First Error'));
	if (action === vscode.l10n.t('Jump to First Error')) {
		await jumpToFirstBuildError();
	}
	return false;
}

async function flashLatestBuild(): Promise<boolean> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace before running this command.'));
		return false;
	}
	const stLinkConnected = await isStLinkConnected(workspaceRoot);
	if (!stLinkConnected) {
		stLinkStatusItem.text = vscode.l10n.t('$(debug-disconnect) ST-LINK: Disconnected');
		stLinkStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		vscode.window.showErrorMessage(vscode.l10n.t('ST-LINK not connected. Check your connection.'));
		return false;
	}

	const elfPath = await findElfFile(workspaceRoot);
	if (!elfPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('ELF file not found. Build the project first.'));
		return false;
	}

	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const programmerExecutable = await resolveProgrammerExecutable(metadata);
	const frequency = vscode.workspace.getConfiguration('stm32').get<number>('flash.frequencyKHz', 4000);

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('STM32 Flashing'), cancellable: false },
		async progress => {
			progress.report({ increment: 5, message: vscode.l10n.t('Connecting...') });
			const flashResult = await runCliWithProgress(
				programmerExecutable,
				['-c', 'port=SWD', `freq=${frequency}`, '-w', elfPath, '-v', '-rst'],
				workspaceRoot,
				vscode.l10n.t('Flash'),
				increment => progress.report({ increment, message: vscode.l10n.t('In progress...') }),
			);
			progress.report({ increment: 100, message: vscode.l10n.t('Finishing...') });
			return flashResult;
		},
	);

	if (result.exitCode === 0) {
		const combined = `${result.stdout}\n${result.stderr}`;
		const hasSuccessSignature = /(Download verified successfully|Verification\s*\.\.\.\s*OK|File download complete|Download complete)/i.test(combined);
		const hasFailureSignature = /(Error:|No ST-?LINK detected|STLink not found|Cannot connect|No STM32 target found|failed)/i.test(combined);
		if (hasSuccessSignature && !hasFailureSignature) {
			vscode.window.showInformationMessage(vscode.l10n.t('Flash completed successfully.'));
			return true;
		}
		outputChannel.appendLine('[STM32] Flash command exited with code 0 but verification signature was not detected.');
	}

	vscode.window.showErrorMessage(vscode.l10n.t('Flash failed. Check the output panel.'));
	return false;
}

async function buildAndFlash(): Promise<void> {
	const buildOk = await buildDebug();
	if (!buildOk) {
		return;
	}

	const selection = await vscode.window.showInformationMessage(vscode.l10n.t('Build succeeded. Flash now?'), vscode.l10n.t('Flash'), vscode.l10n.t('Cancel'));
	if (selection === vscode.l10n.t('Flash')) {
		await flashLatestBuild();
	}
}

async function checkStLink(silent = false): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	const hasLink = await isStLinkConnected(workspaceRoot, silent);
	if (hasLink) {
		stLinkStatusItem.text = vscode.l10n.t('$(plug) ST-LINK: Connected');
		stLinkStatusItem.backgroundColor = undefined;
		return;
	}

	stLinkStatusItem.text = vscode.l10n.t('$(debug-disconnect) ST-LINK: Disconnected');
	stLinkStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

async function openCubeMx(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace before running this command.'));
		return;
	}

	const cubeMxExecutable = await resolveCubeMxExecutable();
	const iocPath = await findTopLevelIocFile(workspaceRoot);
	const args = iocPath ? [iocPath] : [];

	try {
		runDetached(cubeMxExecutable, args, workspaceRoot);
		const fileName = iocPath ? basename(iocPath) : vscode.l10n.t('none');
		vscode.window.showInformationMessage(vscode.l10n.t('CubeMX launched. Target ioc: {0}', fileName));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[STM32] CubeMX launch failed: ${message}`);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to launch CubeMX. Set `stm32.cubemx.path` to the executable or installation folder.'));
	}
}

async function regenerateWithCubeMX(): Promise<void> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace before running this command.'));
		return;
	}

	const iocPath = await findTopLevelIocFile(workspaceRoot);
	if (!iocPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('.ioc file not found. Create a new project with STM32CubeMX.'));
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Regenerate project with STM32CubeMX.\n\nIMPORTANT: Set Toolchain/IDE to "Makefile" in Project Manager before generating code.'),
		{ modal: true },
		vscode.l10n.t('Launch CubeMX'),
		vscode.l10n.t('Show Steps'),
		vscode.l10n.t('Cancel')
	);

	if (choice === vscode.l10n.t('Launch CubeMX')) {
		// Record regeneration time to skip auto-diagnosis
		await extensionContext?.globalState.update('lastRegenerateTime', Date.now());

		await openCubeMx();
		vscode.window.showInformationMessage(
			vscode.l10n.t('After generating code in CubeMX, run a build.'),
			vscode.l10n.t('Build Now')
		).then(async buildChoice => {
			if (buildChoice === vscode.l10n.t('Build Now')) {
				await vscode.commands.executeCommand('stm32.buildDebug');
			}
		});
	} else if (choice === vscode.l10n.t('Show Steps')) {
		const docPath = join(workspaceRoot, 'REGENERATE_PROJECT.md');
		if (await probeFilePath(docPath)) {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(docPath));
			await vscode.window.showTextDocument(doc);
		} else {
			vscode.window.showInformationMessage(
				vscode.l10n.t('1. Open .ioc in CubeMX\n2. Set Toolchain to "Makefile" in Project Manager\n3. Run Generate Code\n4. Build in TovaIDE')
			);
		}
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
		vscode.window.showInformationMessage(vscode.l10n.t('No parseable build errors found.'));
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
		vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace before running this command.'));
		return;
	}

	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	if (!metadata?.programmer_path) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot resolve Programmer path from CubeCLT metadata.'));
		return;
	}

	const elfPath = await findElfFile(workspaceRoot);
	if (!elfPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('ELF file not found. Build the project first.'));
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
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to start debug session.'));
		return;
	}

	vscode.window.showInformationMessage(vscode.l10n.t('Debug session started. Use F9/F10/F11/F12.'));
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
	// CRITICAL: Also search workspace root directly
	if (!folderCandidates.includes(workspaceRoot)) {
		folderCandidates.push(workspaceRoot);
	}

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

	// If no ELF found in standard locations, do recursive search (max depth 3)
	if (found.length === 0) {
		outputChannel.appendLine('[TovaIDE] ELF not found in standard locations. Performing recursive search...');
		await recursiveElfSearch(workspaceRoot, found, 0, 3);
	}

	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (found[0]) {
		outputChannel.appendLine(`[TovaIDE] Found ELF: ${found[0].path}`);
	} else {
		outputChannel.appendLine('[TovaIDE] No ELF file found in workspace.');
	}
	return found[0]?.path;
}

async function recursiveElfSearch(
	dirPath: string,
	found: Array<{ path: string; mtimeMs: number }>,
	depth: number,
	maxDepth: number
): Promise<void> {
	if (depth >= maxDepth) {
		return;
	}

	const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [] as Array<{ isFile: () => boolean; isDirectory: () => boolean; name: string }>);

	for (const entry of entries) {
		// Skip common non-build directories
		if (entry.isDirectory()) {
			const skipDirs = ['node_modules', '.git', '.vscode', 'Drivers', 'Middlewares', 'Core'];
			if (skipDirs.includes(entry.name)) {
				continue;
			}
			await recursiveElfSearch(join(dirPath, entry.name), found, depth + 1, maxDepth);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.elf')) {
			const elfPath = join(dirPath, entry.name);
			const stat = await fs.stat(elfPath).catch(() => undefined);
			if (stat) {
				found.push({ path: elfPath, mtimeMs: stat.mtimeMs });
			}
		}
	}
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
	candidates.add(join(workspaceRoot, 'build'));
	candidates.add(join(workspaceRoot, 'Build'));
	candidates.add(join(workspaceRoot, 'build', 'Debug'));
	candidates.add(join(workspaceRoot, 'build', 'Release'));
	candidates.add(join(workspaceRoot, 'Build', 'Debug'));
	candidates.add(join(workspaceRoot, 'Build', 'Release'));

	// Parse BUILD_DIR from Makefile if present
	try {
		const makefileContent = fsModule.readFileSync(join(workspaceRoot, 'Makefile'), 'utf8');
		const buildDirMatch = makefileContent.match(/^BUILD_DIR\s*=\s*(\S+)/m);
		if (buildDirMatch) {
			const parsedBuildDir = buildDirMatch[1].trim();
			if (parsedBuildDir.length > 0) {
				candidates.add(isAbsolutePath(parsedBuildDir) ? parsedBuildDir : join(workspaceRoot, parsedBuildDir));
			}
		}
	} catch { /* ignore */ }

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

async function isStLinkConnected(workspaceRoot: string, silent = false): Promise<boolean> {
	const metadata = cachedMetadata ?? await detectCubeCLTMetadata();
	const programmerExecutable = await resolveProgrammerExecutable(metadata);
	// Use ONLY -l to avoid resetting the MCU during connection checks
	const commands: string[][] = [
		['-l'],
	];

	for (const args of commands) {
		const result = silent
			? await runCliSilent(programmerExecutable, args, workspaceRoot)
			: await runCli(programmerExecutable, args, workspaceRoot, vscode.l10n.t('ST-LINK check'));
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

/**
 * Patch a CubeMX-generated Makefile that is missing include paths for headers
 * that physically exist inside the project's Drivers/ tree.
 *
 * CubeMX commonly omits:
 *   -IDrivers/CMSIS/Device/ST/STM32Fxxx/Include   (system_stm32fXxx.h lives here)
 *
 * Strategy:
 *   1. Read the Makefile and collect every -I<dir> flag already listed.
 *   2. Walk the project's Drivers/ subtree and collect every "Inc", "Inc/Legacy",
 *      "Include" directory that exists.
 *   3. For each missing one, append it to the C_INCLUDES block, respecting the
 *      line-continuation style CubeMX uses.
 *
 * This runs synchronously before `make` is invoked so there is no race condition.
 */
function healMakefileIncludes(buildDir: string, wsRoot: string): void {
	const makefilePath = join(buildDir, 'Makefile');
	if (!fsModule.existsSync(makefilePath)) {
		return;
	}

	let content: string;
	try {
		content = fsModule.readFileSync(makefilePath, 'utf8');
	} catch {
		return;
	}

	// Collect all -I flags already present in the Makefile (normalised to forward-slashes)
	const existingIncludes = new Set<string>();
	for (const m of content.matchAll(/-I([^\s\\]+)/g)) {
		existingIncludes.add(m[1].replace(/\\/g, '/'));
	}

	// Walk Drivers/ in the workspace and collect include dirs to add
	const driversRoot = join(wsRoot, 'Drivers');
	if (!fsModule.existsSync(driversRoot)) {
		return;
	}

	const toAdd: string[] = [];

	function scanDir(absDir: string, relDir: string): void {
		let entries: Array<{ isDirectory: () => boolean; name: string }>;
		try {
			entries = fsModule.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			const childRel = `${relDir}/${entry.name}`;
			const childAbs = join(absDir, entry.name);
			// These names are the conventional include directories in STM32Cube packages
			if (entry.name === 'Inc' || entry.name === 'Include' || entry.name === 'Legacy') {
				const relForward = childRel.replace(/\\/g, '/');
				if (!existingIncludes.has(relForward)) {
					toAdd.push(relForward);
					existingIncludes.add(relForward); // avoid duplicates in multi-pass
				}
			}
			// Recurse, but stop at source-only dirs to avoid huge walks
			if (entry.name !== 'Src' && entry.name !== 'src') {
				scanDir(childAbs, childRel);
			}
		}
	}

	scanDir(driversRoot, 'Drivers');

	if (toAdd.length === 0) {
		return;
	}

	outputChannel.appendLine(`[STM32] healMakefileIncludes: adding ${toAdd.length} missing include(s): ${toAdd.join(', ')}`);

	// Inject into the Makefile's C_INCLUDES block.
	// Strategy: find the C_INCLUDES block (a run of lines starting with -I or containing \),
	// collect ALL existing -I flags in that block, append missing ones, and rewrite the block.
	const lineBreak = content.includes('\r\n') ? '\r\n' : '\n';

	// Match the entire C_INCLUDES = ... block (multiline with \ continuation)
	const blockRe = /^(C_INCLUDES\s*=\s*\\?\s*\n)((?:[ \t]*-I[^\n]*\n?)*)/m;
	const blockMatch = blockRe.exec(content);
	if (!blockMatch) {
		// Fallback: find the C_INCLUDES = line and append after it
		const singleLineRe = /^(C_INCLUDES\s*=\s*)(.*)$/m;
		const singleMatch = singleLineRe.exec(content);
		if (!singleMatch) {
			return;
		}
		const extra = toAdd.map(d => ` -I${d}`).join('');
		const patched = content.slice(0, singleMatch.index + singleMatch[0].length) +
			extra + content.slice(singleMatch.index + singleMatch[0].length);
		try {
			fsModule.writeFileSync(makefilePath, patched, 'utf8');
		} catch (err) {
			outputChannel.appendLine(`[STM32] healMakefileIncludes: failed to write Makefile: ${err}`);
		}
		return;
	}

	// Rebuild the block: existing lines + new ones, all as "-IPath \" except the last
	const existingLines = blockMatch[2].split('\n')
		.map(l => l.trim())
		.filter(l => l.startsWith('-I'));
	const allIncludes = [...existingLines, ...toAdd.map(d => `-I${d}`)];
	const newBlock = allIncludes.map((inc, i) =>
		i < allIncludes.length - 1 ? `${inc} \\${lineBreak}` : `${inc}${lineBreak}`
	).join('');

	const patched = content.slice(0, blockMatch.index) +
		blockMatch[1] + newBlock +
		content.slice(blockMatch.index + blockMatch[0].length);

	try {
		fsModule.writeFileSync(makefilePath, patched, 'utf8');
	} catch (err) {
		outputChannel.appendLine(`[STM32] healMakefileIncludes: failed to write Makefile: ${err}`);
	}
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
		buildStatusItem.text = vscode.l10n.t('$(check) STM32: Build OK (MCP)');
		buildStatusItem.backgroundColor = undefined;
		vscode.window.showInformationMessage(vscode.l10n.t('Debug build succeeded. (MCP: {0})', reason));
		return true;
	}

	buildStatusItem.text = vscode.l10n.t('$(error) STM32: Build Failed');
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

async function runCliSilent(command: string, args: string[], cwd: string): Promise<CliResult> {
	try {
		const needsShell = command.endsWith('.bat') || command.endsWith('.sh');
		const { stdout, stderr } = await execFileAsync(command, args, { cwd, windowsHide: true, shell: needsShell });
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
		const exitCode = typeof err.code === 'number' ? err.code : 1;
		return { exitCode, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
	}
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
		{ pattern: /undeclared/i, hint: vscode.l10n.t('Undeclared identifier. Check that the peripheral is enabled in the .ioc configuration.') },
		{ pattern: /No such file or directory/i, hint: vscode.l10n.t('Header or source file not found. Check include paths and generated code.') },
		{ pattern: /undefined reference/i, hint: vscode.l10n.t('Linker error. Source file may be missing or function signature mismatch.') },
		{ pattern: /multiple definition/i, hint: vscode.l10n.t('Symbol defined multiple times. Check for duplicate implementations or duplicate linking.') },
		{ pattern: /collect2: error/i, hint: vscode.l10n.t('Link stage failed. Check the error line above.') },
		{ pattern: /region .* overflowed/i, hint: vscode.l10n.t('Memory region overflow. Consider removing unused features or enabling optimization.') }
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
		checkStLink(true).then(undefined, () => undefined);
	}, 15000);
}
