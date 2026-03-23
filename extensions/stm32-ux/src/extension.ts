/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;
declare const process: {
	platform: string;
	env: Record<string, string | undefined>;
	on?: (event: 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void) => void;
};

const childProcess = require('child_process') as {
	execFile: (command: string, args: string[], options: { cwd?: string; shell?: boolean }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
	spawn: (command: string, args: string[], options: { cwd?: string; detached?: boolean; stdio?: unknown; shell?: boolean; env?: Record<string, string | undefined> }) => { pid?: number; unref: () => void; on: (event: string, listener: (...args: unknown[]) => void) => void };
};
const pathModule = require('path') as {
	dirname: (path: string) => string;
	join: (...parts: string[]) => string;
	resolve: (...parts: string[]) => string;
};
const httpModule = require('http') as {
	get: (options: { host: string; port: number; path: string; timeout?: number }, callback: (res: { statusCode?: number; on: (event: string, handler: (...args: unknown[]) => void) => void; resume: () => void }) => void) => { on: (event: string, handler: (...args: unknown[]) => void) => void; destroy: () => void };
	request: (options: { host: string; port: number; path: string; method: string; timeout?: number; headers?: Record<string, string | number> }, callback: (res: { statusCode?: number; on: (event: string, handler: (...args: unknown[]) => void) => void; resume: () => void }) => void) => { on: (event: string, handler: (...args: unknown[]) => void) => void; write: (chunk: string) => void; end: () => void; destroy: () => void };
};

const CUBEMX_MCU_CATALOG_KEY = 'stm32ux.cubemxMcuCatalog';
const CUBEMX_BOARD_CATALOG_KEY = 'stm32ux.cubemxBoardCatalog';
let extensionContextRef: vscode.ExtensionContext;

interface ExecFileResult {
	stdout: string;
	stderr: string;
}

interface McpHealthStatus {
	running: boolean;
	endpoint?: string;
	detail: string;
}

interface ManagedMcpStartResult {
	ok: boolean;
	detail: string;
}

interface BoardProfile {
	id: string;
	name: string;
	mcu: string;
	description: string;
	defaultPins: Array<{ pin: string; mode: string }>;
}

interface CubeMxBoardCatalogItem {
	id: string;
	name: string;
	mcu: string;
	description: string;
}

interface BoardRoleMetadata {
	roleByPin: Record<string, string>;
	fixedByPin: Record<string, boolean>;
	source: string;
}

const boardRoleMetadataCache = new Map<string, BoardRoleMetadata>();

interface BoardConfiguratorPayload {
	selectionMode: 'board' | 'mcu';
	boardId: string;
	mcuName: string;
	projectName: string;
	openPinGui: boolean;
}

const PREFERRED_BOARD_PROFILES: BoardProfile[] = [
	{
		id: 'nucleo-f446re',
		name: 'Nucleo-F446RE',
		mcu: 'STM32F446RETx',
		description: vscode.l10n.t('General-purpose evaluation board. Suitable for beginners.'),
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PA2', mode: 'USART2_TX' }, { pin: 'PA3', mode: 'USART2_RX' }]
	},
	{
		id: 'nucleo-l476rg',
		name: 'Nucleo-L476RG',
		mcu: 'STM32L476RGTx',
		description: vscode.l10n.t('For low-power applications.'),
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PB6', mode: 'I2C1_SCL' }, { pin: 'PB7', mode: 'I2C1_SDA' }]
	},
	{
		id: 'nucleo-g071rb',
		name: 'Nucleo-G071RB',
		mcu: 'STM32G071RBTx',
		description: vscode.l10n.t('Cost-optimized for mass production.'),
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PA9', mode: 'USART1_TX' }, { pin: 'PA10', mode: 'USART1_RX' }]
	},
	{
		id: 'bluepill-f103c8',
		name: 'BluePill-F103C8',
		mcu: 'STM32F103C8Tx',
		description: vscode.l10n.t('Easy-to-use F1-series evaluation board.'),
		defaultPins: [{ pin: 'PC13', mode: 'GPIO_Output' }, { pin: 'PA9', mode: 'USART1_TX' }, { pin: 'PA10', mode: 'USART1_RX' }]
	},
	{
		id: 'nucleo-h743zi',
		name: 'Nucleo-H743ZI',
		mcu: 'STM32H743ZITx',
		description: vscode.l10n.t('High-performance H7-series board.'),
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PB13', mode: 'SPI2_SCK' }, { pin: 'PB14', mode: 'SPI2_MISO' }, { pin: 'PB15', mode: 'SPI2_MOSI' }]
	}
];



const PIN_MODE_GROUPS: Record<string, string[]> = {
	'GPIO': ['GPIO_Output', 'GPIO_Input', 'GPIO_Analog', 'Reset_State'],
	'UART/USART': ['USART1_TX', 'USART1_RX', 'USART2_TX', 'USART2_RX', 'USART3_TX', 'USART3_RX', 'UART4_TX', 'UART4_RX', 'LPUART1_TX', 'LPUART1_RX'],
	'I2C': ['I2C1_SCL', 'I2C1_SDA', 'I2C2_SCL', 'I2C2_SDA', 'I2C3_SCL', 'I2C3_SDA'],
	'SPI': ['SPI1_SCK', 'SPI1_MISO', 'SPI1_MOSI', 'SPI1_NSS', 'SPI2_SCK', 'SPI2_MISO', 'SPI2_MOSI', 'SPI2_NSS', 'SPI3_SCK', 'SPI3_MISO', 'SPI3_MOSI', 'SPI3_NSS'],
	'ADC': ['ADC1_IN0', 'ADC1_IN1', 'ADC1_IN2', 'ADC1_IN3', 'ADC1_IN4', 'ADC1_IN5', 'ADC1_IN6', 'ADC1_IN7', 'ADC2_IN0', 'ADC2_IN1'],
	'TIM/PWM': ['TIM1_CH1', 'TIM1_CH2', 'TIM1_CH3', 'TIM1_CH4', 'TIM2_CH1', 'TIM2_CH2', 'TIM2_CH3', 'TIM2_CH4', 'TIM3_CH1', 'TIM3_CH2', 'TIM3_CH3', 'TIM3_CH4', 'TIM4_CH1', 'TIM4_CH2', 'TIM4_CH3', 'TIM4_CH4'],
	[vscode.l10n.t('Other')]: ['CAN1_TX', 'CAN1_RX', 'USB_DM', 'USB_DP', 'ETH_MDC', 'ETH_MDIO', 'SDIO_D0', 'SDIO_CLK', 'SDIO_CMD'],
};

const COMMON_PIN_ALIASES: Record<string, string[]> = {
	PA5: ['LD2', 'LED', 'USER_LED'],
	PA15: ['LD2', 'LED', 'USER_LED'],
	PB0: ['LD1', 'LED1'],
	PB7: ['LD3', 'LED3'],
	PC13: ['B1', 'USER_BUTTON'],
	PA13: ['SWDIO', 'DEBUG'],
	PA14: ['SWCLK', 'DEBUG']
};

let outputChannel: vscode.OutputChannel;
let extensionUri: vscode.Uri;
let managedMcpPid: number | undefined;
let globalErrorGuardInstalled = false;

function logUxError(scope: string, error: unknown): void {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	outputChannel.appendLine(`[STM32 UX] ${scope} failed: ${message}`);
}

function installGlobalErrorGuard(): void {
	if (globalErrorGuardInstalled) {
		return;
	}
	globalErrorGuardInstalled = true;
	process.on?.('uncaughtException', error => {
		logUxError('uncaughtException', error);
	});
	process.on?.('unhandledRejection', reason => {
		logUxError('unhandledRejection', reason);
	});
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('STM32 UX');
	extensionUri = context.extensionUri;
	extensionContextRef = context;
	context.subscriptions.push(outputChannel);
	installGlobalErrorGuard();

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('stm32-ux.onboardingView', new OnboardingViewProvider()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openWelcomeWizard', () => openWelcomeWizard()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openMcpOperationDesk', () => openMcpOperationDesk()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.syncMcuCatalogFromCubeMX', () => syncMcuCatalogFromCubeMX()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openBoardConfigurator', () => openBoardConfigurator()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.runEnvironmentCheck', () => runEnvironmentCheck()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.explainLatestError', () => explainLatestError()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openPinVisualizer', () => openPinVisualizer()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.configureGlobalWallpaper', () => configureGlobalWallpaper()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.generateMcpConfigJson', () => generateMcpConfigJson()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.composeMcpRequestJson', () => composeMcpRequestJson()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openEnvironmentSettings', () => openEnvironmentSettingsDialog()));

	const shouldOpenWelcome = vscode.workspace.getConfiguration('stm32ux').get<boolean>('autoOpenWelcome', true);
	if (shouldOpenWelcome) {
		void openWelcomeWizard().catch(error => {
			logUxError('autoOpenWelcome', error);
		});
	}

	const shouldAutoStartMcp = vscode.workspace.getConfiguration('stm32ux').get<boolean>('mcp.autoStart', true);
	if (shouldAutoStartMcp) {
		setTimeout(() => {
			void ensureMcpServerReady().then(status => {
				if (!status.running) {
					outputChannel.appendLine(`[STM32 UX] MCP auto-start failed: ${status.detail}`);
				}
			}).catch(error => {
				logUxError('mcp.autoStart', error);
			});
		}, 800);
	}
}

async function openEnvironmentSettingsDialog(): Promise<void> {
	const config = vscode.workspace.getConfiguration('stm32');

	// Read current values from settings
	const makePath = config.get<string>('makePath', '');
	const cubemxPath = config.get<string>('cubemxPath', '');
	const cubectlPath = config.get<string>('cubectlPath', '');

	const selectAction = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Set make command path'), value: 'makePath' },
		{ label: vscode.l10n.t('Set STM32CubeMX path'), value: 'cubemxPath' },
		{ label: vscode.l10n.t('Set STM32 Programmer CLI path'), value: 'cubectlPath' },
		{ label: vscode.l10n.t('Reset all path settings'), value: 'reset' },
		{ label: vscode.l10n.t('Check / debug current settings'), value: 'debug' },
	], { placeHolder: vscode.l10n.t('Select item to configure.'), title: vscode.l10n.t('STM32 Environment Path Settings') });

	if (!selectAction) {
		return;
	}

	const { value } = selectAction;

	if (value === 'makePath') {
		const newPath = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Enter the path to the make command.'),
			value: makePath,
			placeHolder: 'e.g. C:\\ST\\STM32CubeCLT\\GNU_tools_for_STM32\\bin\\make.exe',
		});
		if (newPath !== undefined) {
			await config.update('makePath', newPath, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(newPath ? vscode.l10n.t('✅ make path set: {0}', newPath) : vscode.l10n.t('✅ make path cleared.'));
		}
	} else if (value === 'cubemxPath') {
		const newPath = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Enter the path to the STM32CubeMX executable.'),
			value: cubemxPath,
			placeHolder: 'e.g. C:\\ST\\STM32CubeMX\\STM32CubeMX.exe',
		});
		if (newPath !== undefined) {
			await config.update('cubemxPath', newPath, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(newPath ? vscode.l10n.t('✅ CubeMX path set: {0}', newPath) : vscode.l10n.t('✅ CubeMX path cleared.'));
		}
	} else if (value === 'cubectlPath') {
		const newPath = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Enter the path to STM32 Programmer CLI.'),
			value: cubectlPath,
			placeHolder: 'e.g. C:\\ST\\STM32CubeCLT\\STM32_Programmer_CLI.exe',
		});
		if (newPath !== undefined) {
			await config.update('cubectlPath', newPath, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(newPath ? vscode.l10n.t('✅ Programmer CLI path set: {0}', newPath) : vscode.l10n.t('✅ Programmer CLI path cleared.'));
		}
	} else if (value === 'reset') {
		const resetLabel = vscode.l10n.t('Delete');
		const confirm = await vscode.window.showWarningMessage(
			vscode.l10n.t('Delete all environment path settings (make, CubeMX, Programmer CLI)?'),
			{ modal: true },
			resetLabel
		);
		if (confirm === resetLabel) {
			await config.update('makePath', undefined, vscode.ConfigurationTarget.Workspace);
			await config.update('cubemxPath', undefined, vscode.ConfigurationTarget.Workspace);
			await config.update('cubectlPath', undefined, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(vscode.l10n.t('✅ All environment path settings reset.'));
		}
	} else if (value === 'debug') {
		const notSet = vscode.l10n.t('(not set)');
		const debugInfo = [
			vscode.l10n.t('[STM32 Environment Paths - Debug Info]'),
			'',
			vscode.l10n.t('Make path (configured):'),
			`  ${makePath || notSet}`,
			``,
			vscode.l10n.t('CubeMX path (configured):'),
			`  ${cubemxPath || notSet}`,
			``,
			vscode.l10n.t('Programmer CLI path (configured):'),
			`  ${cubectlPath || notSet}`,
		].join('\n');
		await vscode.window.showInformationMessage(debugInfo, { modal: true });
	}
}

export function deactivate(): void {
}

async function configureGlobalWallpaper(): Promise<void> {
	const action = await vscode.window.showQuickPick([
		{ label: vscode.l10n.t('Select image file and apply'), value: 'file' },
		{ label: vscode.l10n.t('Enter image URL and apply'), value: 'url' },
		{ label: vscode.l10n.t('Clear wallpaper'), value: 'clear' },
	], { placeHolder: vscode.l10n.t('Select IDE wallpaper setting') });

	if (!action) {
		return;
	}

	const config = vscode.workspace.getConfiguration();

	if (action.value === 'clear') {
		await config.update('workbench.wallpaper.enabled', false, vscode.ConfigurationTarget.Global);
		await config.update('workbench.wallpaper.image', '', vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(vscode.l10n.t('IDE wallpaper cleared.'));
		return;
	}

	let imageSource = '';
	if (action.value === 'file') {
		const pick = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: vscode.l10n.t('Use as wallpaper'),
			filters: {
				Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']
			}
		});
		if (!pick || pick.length === 0) {
			return;
		}
		imageSource = pick[0].toString();
	} else {
		const raw = await vscode.window.showInputBox({
			title: vscode.l10n.t('Wallpaper URL'),
			prompt: vscode.l10n.t('https://... / file:///... / data:image/... / absolute local path'),
			placeHolder: 'https://example.com/wallpaper.jpg',
			ignoreFocusOut: true,
		});
		if (!raw?.trim()) {
			return;
		}
		imageSource = normalizeWallpaperInput(raw.trim());
	}

	const currentOpacity = config.get<number>('workbench.wallpaper.opacity', 0.2);
	const opacityRaw = await vscode.window.showInputBox({
		title: vscode.l10n.t('Wallpaper Opacity'),
		prompt: vscode.l10n.t('Enter 0–1 or 0–100(%)'),
		value: String(currentOpacity),
		ignoreFocusOut: true,
	});
	if (!opacityRaw?.trim()) {
		return;
	}

	let opacity = Number(opacityRaw.trim());
	if (!Number.isFinite(opacity)) {
		vscode.window.showErrorMessage(vscode.l10n.t('Invalid opacity value.'));
		return;
	}
	if (opacity > 1) {
		opacity = opacity / 100;
	}
	opacity = Math.min(1, Math.max(0, opacity));

	await config.update('workbench.wallpaper.image', imageSource, vscode.ConfigurationTarget.Global);
	await config.update('workbench.wallpaper.opacity', opacity, vscode.ConfigurationTarget.Global);
	await config.update('workbench.wallpaper.enabled', true, vscode.ConfigurationTarget.Global);

	vscode.window.showInformationMessage(vscode.l10n.t('IDE wallpaper updated.'));
}

function normalizeWallpaperInput(value: string): string {
	if (/^(https?:|file:|data:image\/|vscode-file:|vscode-remote:)/i.test(value)) {
		return value;
	}

	if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
		return vscode.Uri.file(value).toString();
	}

	if (value.startsWith('/')) {
		return vscode.Uri.file(value).toString();
	}

	return value;
}

class OnboardingViewProvider implements vscode.WebviewViewProvider {
	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getOnboardingHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async message => {
			try {
				if (!isRecord(message) || typeof message.type !== 'string') {
					return;
				}
				switch (message.type) {
					case 'mcp':
						await openMcpOperationDesk();
						break;
					case 'svd':
						await vscode.commands.executeCommand('workbench.view.extension.stm32-debug');
						await vscode.commands.executeCommand('stm32.debug.refreshRegisters');
						break;
					case 'build':
						await vscode.commands.executeCommand('stm32.buildDebug');
						break;
					case 'flash':
						await vscode.commands.executeCommand('stm32.flash');
						break;
					case 'debug':
						await vscode.commands.executeCommand('stm32.startDebug');
						break;
					case 'syncCatalog':
						await syncMcuCatalogFromCubeMX();
						break;
					case 'board':
						await openBoardConfigurator();
						break;
					case 'env':
						await runEnvironmentCheck();
						break;
					case 'pin':
						await openPinVisualizer();
						break;
					case 'error':
						await explainLatestError();
						break;
					case 'envSettings':
						await openEnvironmentSettingsDialog();
						break;
				}
			} catch (error) {
				logUxError('onboarding message handler', error);
			}
		});
	}
}




async function openMcpOperationDesk(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.mcpDesk', 'STM32 MCP Operation Desk', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getMcpOperationDeskHtml(panel.webview);
	const publishStatus = async (): Promise<void> => {
		const status = await checkMcpHealth();
		await panel.webview.postMessage({ type: 'mcpStatus', ...status });
	};
	const timer = setInterval(() => {
		void publishStatus().catch(error => {
			logUxError('mcp status polling', error);
		});
	}, 3000);
	panel.onDidDispose(() => {
		clearInterval(timer);
	});
	await publishStatus();

	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}

		const run = async (method: string, params?: Record<string, unknown>): Promise<void> => {
			const status = await ensureMcpServerReady();
			await publishStatus();
			if (!status.running) {
				throw new Error(status.detail || 'MCP server is not ready');
			}
			const payload = params
				? JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
				: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method });
			const result = await vscode.window.showInputBox({
				title: vscode.l10n.t('MCP Call JSON (executed)'),
				value: payload,
				prompt: vscode.l10n.t('The JSON below can be sent identically from an MCP client.')
			});
			if (typeof result === 'string') {
				void result;
			}
		};

		switch (message.type) {
			case 'checkMcpStatus':
				await publishStatus();
				break;
			case 'startMcp':
				{
					const status = await ensureMcpServerReady();
					await panel.webview.postMessage({
						type: 'status', message: status.running
							? vscode.l10n.t('MCP server started: {0}', status.endpoint ?? '')
							: vscode.l10n.t('MCP failed to start: {0}', status.detail)
					});
					if (!status.running) {
						vscode.window.showErrorMessage(vscode.l10n.t('MCP failed to start: {0}', status.detail));
					}
					await publishStatus();
				}
				break;
			case 'startSseMcp':
				{
					const status = await ensureMcpServerReady();
					if (!status.running) {
						vscode.window.showErrorMessage(vscode.l10n.t('SSE MCP failed to start: {0}', status.detail));
						await publishStatus();
						break;
					}

					const sseEndpoint = status.endpoint ? status.endpoint.replace(/\/mcp$/u, '/sse') : '';
					const message = sseEndpoint
						? vscode.l10n.t('SSE MCP server started: {0}', sseEndpoint)
						: vscode.l10n.t('SSE MCP server started.');
					vscode.window.showInformationMessage(message);
					await panel.webview.postMessage({ type: 'status', message });
					await publishStatus();
				}
				break;
			case 'stopMcp':
				{
					const result = await stopMcpServerCompletely();
					await panel.webview.postMessage({
						type: 'status', message: result.ok
							? vscode.l10n.t('MCP server stopped.')
							: vscode.l10n.t('MCP failed to stop: {0}', result.detail)
					});
					if (!result.ok) {
						vscode.window.showErrorMessage(vscode.l10n.t('MCP failed to stop: {0}', result.detail));
					}
					await publishStatus();
				}
				break;
			case 'envSettings':
				await openEnvironmentSettingsDialog();
				break;
			case 'exportConfig':
				await generateMcpConfigJson();
				break;
			case 'composeRpc':
				await composeMcpRequestJson();
				break;
			case 'build':
				await run('stm32.build');
				await vscode.commands.executeCommand('stm32.buildDebug');
				break;
			case 'flash':
				await run('stm32.flash');
				await vscode.commands.executeCommand('stm32.flash');
				break;
			case 'regen':
				await run('stm32.regenerateCode');
				await vscode.commands.executeCommand('stm32.regenerateCode');
				break;
			case 'board':
				await run('stm32.openBoardConfigurator');
				await openBoardConfigurator();
				break;
			case 'svd':
				await run('stm32.refreshRegisters');
				await vscode.commands.executeCommand('stm32.debug.refreshRegisters');
				break;
		}
	});
}

function getMcpProbeTargets(): Array<{ host: string; port: number }> {
	const config = vscode.workspace.getConfiguration('stm32ux');
	const host = config.get<string>('mcp.host', '127.0.0.1');
	const configuredPort = config.get<number>('mcp.port', 3737);
	const ports = Array.from(new Set([configuredPort, 3737]));
	return ports.map(port => ({ host, port }));
}

async function pingMcpHealth(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const req = httpModule.get({ host, port, path: '/health', timeout: timeoutMs }, res => {
			res.resume();
			// Some MCP servers do not expose /health as 2xx. Any HTTP response means process is reachable.
			resolve(typeof res.statusCode === 'number' && res.statusCode > 0);
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			try { req.destroy(); } catch { /* ignore */ }
			resolve(false);
		});
		setTimeout(() => {
			try { req.destroy(); } catch { /* ignore */ }
			resolve(false);
		}, timeoutMs + 100);
	});
}

async function postJsonToMcp(host: string, port: number, path: string, payload: unknown, timeoutMs = 1800): Promise<{ statusCode: number; raw: string; json?: unknown }> {
	return await new Promise<{ statusCode: number; raw: string; json?: unknown }>((resolve, reject) => {
		const body = JSON.stringify(payload);
		let settled = false;
		const finish = (value: { statusCode: number; raw: string; json?: unknown }, isError = false): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (isError) {
				reject(new Error(value.raw));
				return;
			}
			resolve(value);
		};

		const req = httpModule.request({
			host,
			port,
			path,
			method: 'POST',
			timeout: timeoutMs,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
			}
		}, res => {
			let raw = '';
			res.on('data', chunk => {
				raw += String(chunk);
			});
			res.on('end', () => {
				let json: unknown;
				try {
					json = raw ? JSON.parse(raw) : undefined;
				} catch {
					json = undefined;
				}
				finish({ statusCode: res.statusCode ?? 0, raw, json });
			});
		});

		req.on('error', error => finish({ statusCode: 0, raw: error instanceof Error ? error.message : String(error) }, true));
		req.on('timeout', () => {
			try { req.destroy(); } catch { /* ignore */ }
			finish({ statusCode: 0, raw: 'request timeout' }, true);
		});
		setTimeout(() => {
			try { req.destroy(); } catch { /* ignore */ }
			finish({ statusCode: 0, raw: 'request timeout' }, true);
		}, timeoutMs + 150);
		req.write(body);
		req.end();
	});
}

function getConfiguredMcpEndpoint(): { host: string; port: number } {
	const config = vscode.workspace.getConfiguration('stm32ux');
	return {
		host: config.get<string>('mcp.host', '127.0.0.1'),
		port: config.get<number>('mcp.port', 3737),
	};
}

async function trySwitchWorkspaceOnRunningMcp(workspacePath: string): Promise<boolean> {
	for (const target of getMcpProbeTargets()) {
		const reachable = await pingMcpHealth(target.host, target.port, 1000);
		if (!reachable) {
			continue;
		}

		const payload = {
			jsonrpc: '2.0',
			id: Date.now(),
			method: 'stm32.operationDesk',
			params: { action: 'setWorkspace', workspacePath }
		};

		try {
			const response = await postJsonToMcp(target.host, target.port, '/mcp', payload, 2000);
			if (response.statusCode !== 200 || !isRecord(response.json)) {
				continue;
			}
			if (isRecord(response.json.result)) {
				outputChannel.appendLine(`[STM32 UX] Existing MCP workspace switched on ${target.host}:${target.port}`);
				return true;
			}
		} catch {
			// Try next endpoint
		}
	}

	return false;
}

async function getListeningPidsOnPort(port: number, cwd: string | undefined): Promise<number[]> {
	if (process.platform === 'win32') {
		try {
			const result = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], cwd);
			const lines = result.stdout.split(/\r?\n/u);
			const pids = new Set<number>();
			for (const line of lines) {
				if (!line.includes('LISTENING')) {
					continue;
				}
				if (!line.includes(`:${String(port)}`)) {
					continue;
				}
				const parts = line.trim().split(/\s+/u);
				const maybePid = Number(parts[parts.length - 1]);
				if (Number.isFinite(maybePid) && maybePid > 0) {
					pids.add(maybePid);
				}
			}
			return Array.from(pids);
		} catch {
			return [];
		}
	}

	try {
		const result = await execFileAsync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], cwd);
		return result.stdout
			.split(/\r?\n/u)
			.map(line => Number(line.trim()))
			.filter(pid => Number.isFinite(pid) && pid > 0);
	} catch {
		return [];
	}
}

async function killPids(pids: number[], cwd: string | undefined): Promise<void> {
	for (const pid of pids) {
		if (managedMcpPid && pid === managedMcpPid) {
			continue;
		}
		try {
			if (process.platform === 'win32') {
				await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], cwd);
			} else {
				await execFileAsync('kill', ['-9', String(pid)], cwd);
			}
			outputChannel.appendLine(`[STM32 UX] Killed process on MCP port: pid=${String(pid)}`);
		} catch {
			// Ignore and continue
		}
	}
}

async function fetchJsonFromMcp(host: string, port: number, path: string, timeoutMs = 1500): Promise<unknown | undefined> {
	return new Promise<unknown | undefined>(resolve => {
		let settled = false;
		const finish = (value: unknown | undefined): void => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};

		const req = httpModule.get({ host, port, path, timeout: timeoutMs }, res => {
			let body = '';
			res.on('data', chunk => {
				body += String(chunk);
			});
			res.on('end', () => {
				try {
					finish(JSON.parse(body));
				} catch {
					finish(undefined);
				}
			});
		});

		req.on('error', () => finish(undefined));
		req.on('timeout', () => {
			try { req.destroy(); } catch { /* ignore */ }
			finish(undefined);
		});
		setTimeout(() => {
			try { req.destroy(); } catch { /* ignore */ }
			finish(undefined);
		}, timeoutMs + 100);
	});
}

function hasCubeForgeMcpTools(payload: unknown): boolean {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) {
		return false;
	}
	return payload.tools.some(tool => isRecord(tool)
		&& typeof tool.name === 'string'
		&& (tool.name === 'stm32.listWorkspaceFiles' || tool.name === 'stm32.autoWorkflow'));
}

async function checkMcpHealth(): Promise<McpHealthStatus> {
	const incompatibleEndpoints: string[] = [];
	for (const target of getMcpProbeTargets()) {
		const ok = await pingMcpHealth(target.host, target.port);
		if (ok) {
			const toolsPayload = await fetchJsonFromMcp(target.host, target.port, '/tools');
			if (hasCubeForgeMcpTools(toolsPayload)) {
				return {
					running: true,
					endpoint: `http://${target.host}:${target.port}/mcp`,
					detail: `connected OK (${target.host}:${target.port})`,
				};
			}

			incompatibleEndpoints.push(`${target.host}:${target.port}`);
		}
	}

	if (incompatibleEndpoints.length > 0) {
		return { running: false, detail: `MCP is responding but compatible tools are missing (${incompatibleEndpoints.join(', ')})` };
	}

	return { running: false, detail: 'MCP server not started or no /health response' };
}

async function waitMs(ms: number): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function tryStartMcpTask(): Promise<void> {
	const tasks = await vscode.tasks.fetchTasks();
	const candidate = tasks.find(task => task.name === 'CubeForge: Start MCP Server')
		?? tasks.find(task => task.name === 'Launch MCP Server');
	if (candidate) {
		await vscode.tasks.executeTask(candidate);
	}
}

function getPrimaryWorkspacePath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function tryStartManagedMcpProcess(): Promise<ManagedMcpStartResult> {
	const workspacePath = getPrimaryWorkspacePath();
	if (!workspacePath) {
		return { ok: false, detail: 'no workspace found, skipping managed start' };
	}
	try {
		await ensureMcpServerInWorkspace(vscode.Uri.file(workspacePath));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `managed start preparation failed: ${message}` };
	}
	const config = vscode.workspace.getConfiguration('stm32ux');
	const host = config.get<string>('mcp.host', '127.0.0.1');
	const port = config.get<number>('mcp.port', 3737);
	const serverEntryPath = pathModule.join(workspacePath, 'mcp-server', 'index.js');
	if (!(await fileExists(serverEntryPath))) {
		return { ok: false, detail: `managed start target not found: ${serverEntryPath}` };
	}

	return await new Promise<ManagedMcpStartResult>(resolve => {
		let settled = false;
		const finish = (result: ManagedMcpStartResult): void => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};

		try {
			const child = childProcess.spawn('node', [serverEntryPath, '--host', host, '--port', String(port), '--workspace', workspacePath, '--no-auth'], {
				cwd: workspacePath,
				detached: true,
				stdio: 'ignore',
				shell: false,
				env: {
					...process.env,
					MCP_NO_AUTH: '1',
				},
			});

			if (!child.pid) {
				finish({ ok: false, detail: 'managed start failed: could not get node process PID' });
				return;
			}

			managedMcpPid = child.pid;
			child.on('error', error => {
				const message = error instanceof Error ? error.message : String(error);
				finish({ ok: false, detail: `managed start error: ${message}` });
			});
			child.on('exit', (code: unknown) => {
				if (typeof code === 'number' && code !== 0) {
					finish({ ok: false, detail: `managed process exited immediately (exit=${code})` });
				}
			});

			child.unref();
			setTimeout(() => {
				finish({ ok: true, detail: `managed start launched: node PID ${String(managedMcpPid ?? '')}` });
			}, 300);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			finish({ ok: false, detail: `managed start exception: ${message}` });
		}
	});
}

async function tryStopManagedMcpProcess(): Promise<void> {
	const workspacePath = getPrimaryWorkspacePath();
	if (!workspacePath) {
		return;
	}

	if (managedMcpPid) {
		try {
			if (process.platform === 'win32') {
				await execFileAsync('taskkill', ['/PID', String(managedMcpPid), '/T', '/F'], workspacePath);
			} else {
				await execFileAsync('kill', ['-9', String(managedMcpPid)], workspacePath);
			}
		} catch {
			// ignore and continue with command-line based cleanup
		}
		managedMcpPid = undefined;
	}

	if (process.platform === 'win32') {
		const apostrophe = String.fromCharCode(39);
		const escapedWorkspace = workspacePath.split(apostrophe).join(apostrophe + apostrophe);
		const script = `$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*mcp-server\\index.js*' -and $_.CommandLine -like '*--workspace*${escapedWorkspace}*' }; foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`;
		try {
			await execFileAsync('powershell', ['-NoProfile', '-Command', script], workspacePath);
		} catch {
			// ignore
		}
	}
}

async function stopMcpServerCompletely(): Promise<{ ok: boolean; detail: string }> {
	const detailNotes: string[] = [];
	try {
		await vscode.commands.executeCommand('stm32ai.stopMcpServer');
		detailNotes.push('stm32ai.stopMcpServer executed');
	} catch {
		detailNotes.push('stm32ai.stopMcpServer failed');
	}

	await tryStopManagedMcpProcess();
	await waitMs(300);

	const workspacePath = getPrimaryWorkspacePath();
	const endpoint = getConfiguredMcpEndpoint();
	const pids = await getListeningPidsOnPort(endpoint.port, workspacePath);
	if (pids.length > 0) {
		await killPids(pids, workspacePath);
		detailNotes.push(`stopped PID(s) occupying port ${String(endpoint.port)}: ${pids.join(', ')}`);
		await waitMs(300);
	}

	const status = await checkMcpHealth();
	if (status.running) {
		return { ok: false, detail: `MCP still responding after stop: ${status.detail} | ${detailNotes.join(' / ')}` };
	}
	return { ok: true, detail: detailNotes.join(' / ') };
}

async function ensureMcpServerReady(): Promise<McpHealthStatus> {
	const attempts: string[] = [];
	const forceTakeover = vscode.workspace.getConfiguration('stm32ux').get<boolean>('mcp.forceTakeoverPort', true);
	let status = await checkMcpHealth();
	if (status.running) {
		const workspacePath = getPrimaryWorkspacePath();
		if (workspacePath) {
			await trySwitchWorkspaceOnRunningMcp(workspacePath);
		}
		return status;
	}
	attempts.push(`initial check: ${status.detail}`);

	if (status.detail.includes('incompatible tools missing')) {
		try {
			await vscode.commands.executeCommand('stm32ai.stopMcpServer');
			attempts.push('stopped incompatible MCP (stm32ai.stopMcpServer)');
		} catch {
			attempts.push('failed to stop incompatible MCP');
		}
	}

	const workspacePath = getPrimaryWorkspacePath();
	if (workspacePath) {
		const switched = await trySwitchWorkspaceOnRunningMcp(workspacePath);
		if (switched) {
			status = await checkMcpHealth();
			if (status.running) {
				attempts.push('reconnected to existing MCP with workspace override');
				return status;
			}
		}
	}

	if (!forceTakeover) {
		try {
			await tryStartMcpTask();
			attempts.push('task start executed');
		} catch {
			attempts.push('task start failed');
		}

		for (let i = 0; i < 6; i++) {
			await waitMs(500);
			status = await checkMcpHealth();
			if (status.running) {
				if (workspacePath) {
					await trySwitchWorkspaceOnRunningMcp(workspacePath);
				}
				return status;
			}
		}
		attempts.push('post-task /health: NG');
	} else {
		attempts.push('skipped task start because forceTakeoverPort=true');
	}

	if (forceTakeover) {
		const endpoint = getConfiguredMcpEndpoint();
		const listeningPids = await getListeningPidsOnPort(endpoint.port, workspacePath);
		if (listeningPids.length > 0) {
			await killPids(listeningPids, workspacePath);
			attempts.push(`killed process(es) holding port ${String(endpoint.port)}: ${listeningPids.join(',')}`);
			await waitMs(350);
		}
	}

	const managed = await tryStartManagedMcpProcess();
	attempts.push(managed.detail);
	if (!managed.ok) {
		return { running: false, detail: attempts.join(' | ') };
	}

	for (let i = 0; i < 8; i++) {
		await waitMs(500);
		status = await checkMcpHealth();
		if (status.running) {
			if (workspacePath) {
				await trySwitchWorkspaceOnRunningMcp(workspacePath);
			}
			return status;
		}
	}

	attempts.push('post-managed-start /health: NG');
	return { running: false, detail: attempts.join(' | ') };
}

function getMcpMethodCatalog(): Array<{ method: string; description: string; command?: string }> {
	return [
		{ method: 'stm32.build', description: 'Run Debug build', command: 'stm32.buildDebug' },
		{ method: 'stm32.flash', description: 'Flash firmware', command: 'stm32.flash' },
		{ method: 'stm32.regenerateCode', description: 'Regenerate code from .ioc', command: 'stm32.regenerateCode' },
		{ method: 'stm32.openBoardConfigurator', description: 'Open board config screen', command: 'stm32ux.openBoardConfigurator' },
		{ method: 'stm32.refreshRegisters', description: 'Refresh SVD register view', command: 'stm32.debug.refreshRegisters' },
		{ method: 'stm32.openPinVisualizer', description: 'Open pin visualizer', command: 'stm32ux.openPinVisualizer' },
		{ method: 'stm32.syncCatalog', description: 'Sync CubeMX catalog', command: 'stm32ux.syncMcuCatalogFromCubeMX' },
		{ method: 'stm32.runEnvironmentCheck', description: 'Run environment check', command: 'stm32ux.runEnvironmentCheck' },
	];
}

async function composeMcpRequestJson(): Promise<void> {
	const selected = await vscode.window.showQuickPick(
		getMcpMethodCatalog().map(item => ({ label: item.method, description: item.description })),
		{ placeHolder: vscode.l10n.t('Select MCP method to compose') }
	);
	if (!selected) {
		return;
	}

	const paramsRaw = await vscode.window.showInputBox({
		title: vscode.l10n.t('MCP params JSON (optional)'),
		prompt: vscode.l10n.t('Leave empty for no params. Otherwise enter a JSON object string.'),
		placeHolder: '{"target":"nucleo-f446re"}',
		ignoreFocusOut: true,
	});

	let paramsObject: Record<string, unknown> | undefined;
	if (paramsRaw && paramsRaw.trim().length > 0) {
		try {
			const parsed = JSON.parse(paramsRaw);
			if (!isRecord(parsed)) {
				vscode.window.showErrorMessage(vscode.l10n.t('params must be a JSON object.'));
				return;
			}
			paramsObject = parsed;
		} catch {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to parse params JSON.'));
			return;
		}
	}

	const requestPayload = paramsObject
		? { jsonrpc: '2.0', id: Date.now(), method: selected.label, params: paramsObject }
		: { jsonrpc: '2.0', id: Date.now(), method: selected.label };

	const requestJson = JSON.stringify(requestPayload, null, 2);
	const doc = await vscode.workspace.openTextDocument({ language: 'json', content: requestJson });
	await vscode.window.showTextDocument(doc, { preview: false });
	await vscode.env.clipboard.writeText(requestJson);
	vscode.window.showInformationMessage(vscode.l10n.t('MCP JSON-RPC generated and copied to clipboard.'));
}

async function generateMcpConfigJson(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	const defaultWorkspacePath = workspaceFolder?.uri.fsPath ?? '';
	const targetWorkspacePathInput = await vscode.window.showInputBox({
		title: vscode.l10n.t('MCP Target Workspace Path'),
		prompt: vscode.l10n.t('Enter the absolute path of the project to start the MCP server for.'),
		value: defaultWorkspacePath,
		ignoreFocusOut: true,
	});
	if (!targetWorkspacePathInput?.trim()) {
		return;
	}

	const targetWorkspacePath = targetWorkspacePathInput.trim();
	const targetWorkspaceUri = vscode.Uri.file(targetWorkspacePath);
	try {
		const stat = await vscode.workspace.fs.stat(targetWorkspaceUri);
		if (stat.type !== vscode.FileType.Directory) {
			vscode.window.showErrorMessage(vscode.l10n.t('Specified path is not a folder: {0}', targetWorkspacePath));
			return;
		}
	} catch {
		vscode.window.showErrorMessage(vscode.l10n.t('Specified path does not exist: {0}', targetWorkspacePath));
		return;
	}

	const serverEntryPath = await ensureMcpServerInWorkspace(targetWorkspaceUri);
	if (!serverEntryPath) {
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to deploy mcp-server. Cannot generate config JSON.'));
		return;
	}

	const config = vscode.workspace.getConfiguration('stm32ux');
	const autoStart = config.get<boolean>('mcp.autoStart', true);
	const transport = (config.get<string>('mcp.transport', 'http') || 'http').toLowerCase();
	const host = config.get<string>('mcp.host', '127.0.0.1');
	const port = config.get<number>('mcp.port', 3737);
	const timeoutMs = config.get<number>('mcp.requestTimeoutMs', 20000);

	const workspacePath = targetWorkspacePath;
	const isHttp = transport === 'http';
	const remoteUrl = `http://${host}:${port}/mcp`;
	let bearerToken = '<MCP_TOKEN>';
	if (workspacePath) {
		try {
			const tokenUri = vscode.Uri.joinPath(targetWorkspaceUri, '.mcp-token');
			const tokenBytes = await vscode.workspace.fs.readFile(tokenUri);
			const token = Buffer.from(tokenBytes).toString('utf8').trim();
			if (token.length > 0) {
				bearerToken = token;
			}
		} catch {
			// Token file may not exist yet. Keep placeholder so user can fill it.
		}
	}
	const hasBearerToken = bearerToken !== '<MCP_TOKEN>';
	// VS Code mcp.json format uses "servers" key with type:stdio
	const vscodeServerEntry = isHttp
		? {
			type: 'http' as const,
			url: remoteUrl,
			...(hasBearerToken ? {
				headers: {
					'Authorization': `Bearer ${bearerToken}`,
				},
			} : {}),
		}
		: {
			type: 'stdio' as const,
			command: 'node',
			args: [serverEntryPath, '--stdio', '--workspace', workspacePath],
			env: {
				MCP_REQUEST_TIMEOUT_MS: String(timeoutMs),
				MCP_AUTO_START: autoStart ? '1' : '0',
				NODE_NO_WARNINGS: '1',
				FORCE_COLOR: '0',
				NO_COLOR: '1',
			},
		};

	// Qwen Desktop: template-compatible outputs for SSE / StreamableHTTP / stdio command.
	const qwenSseServerEntry = {
		url: `http://${host}:${port}/sse`,
		...(hasBearerToken ? {
			headers: {
				'Authorization': `Bearer ${bearerToken}`,
			},
		} : {}),
	};
	const qwenStreamableHttpServerEntry = {
		type: 'streamable-http',
		url: remoteUrl,
		...(hasBearerToken ? {
			headers: {
				'Authorization': `Bearer ${bearerToken}`,
			},
		} : {}),
	};
	const qwenStdioServerEntry = {
		command: 'npx',
		args: ['-y', 'tsx', serverEntryPath, '--stdio', '--workspace', workspacePath],
		env: {
			MCP_REQUEST_TIMEOUT_MS: String(timeoutMs),
			MCP_AUTO_START: autoStart ? '1' : '0',
			NODE_NO_WARNINGS: '1',
			FORCE_COLOR: '0',
			NO_COLOR: '1',
			TSX_DISABLE_CACHE: '1',
		},
	};

	const editorPayload = {
		servers: {
			'tova-stm32': vscodeServerEntry,
		},
	};

	const qwenPayload = {
		mcpServers: {
			'tova-stm32-sse': qwenSseServerEntry,
			'tova-stm32-http': qwenStreamableHttpServerEntry,
			'tova-stm32-stdio': qwenStdioServerEntry,
		},
	};

	const lmStudioPayload = {
		mcpServers: {
			'tova-stm32': {
				command: 'python',
				args: [
					pathModule.join(pathModule.dirname(serverEntryPath), 'stdio_python_host.py'),
					'--server',
					serverEntryPath,
					'--workspace',
					workspacePath,
				],
				env: {
					MCP_REQUEST_TIMEOUT_MS: String(timeoutMs),
					MCP_AUTO_START: autoStart ? '1' : '0',
					PYTHONUNBUFFERED: '1',
					NODE_NO_WARNINGS: '1',
					FORCE_COLOR: '0',
					NO_COLOR: '1',
				},
			},
		},
	};

	const editorContent = JSON.stringify(editorPayload, null, 2) + '\n';
	const qwenContent = JSON.stringify(qwenPayload, null, 2) + '\n';
	const lmStudioContent = JSON.stringify(lmStudioPayload, null, 2) + '\n';

	let targetUri: vscode.Uri | undefined;
	let qwenTargetUri: vscode.Uri | undefined;
	let lmStudioTargetUri: vscode.Uri | undefined;
	if (workspacePath) {
		targetUri = vscode.Uri.joinPath(targetWorkspaceUri, '.vscode', 'stm32-mcp.editor.json');
		qwenTargetUri = vscode.Uri.joinPath(targetWorkspaceUri, '.vscode', 'stm32-mcp.qwen-desktop.json');
		lmStudioTargetUri = vscode.Uri.joinPath(targetWorkspaceUri, '.vscode', 'stm32-mcp.lmstudio.json');
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetWorkspaceUri, '.vscode'));
		} catch {
			// ignore directory creation errors; write below will surface issues if any.
		}
	} else {
		targetUri = await vscode.window.showSaveDialog({
			saveLabel: vscode.l10n.t('Save MCP config JSON for Editor'),
			filters: { JSON: ['json'] },
		});
		qwenTargetUri = await vscode.window.showSaveDialog({
			saveLabel: vscode.l10n.t('Save MCP config JSON for Qwen Desktop'),
			filters: { JSON: ['json'] },
		});
		lmStudioTargetUri = await vscode.window.showSaveDialog({
			saveLabel: vscode.l10n.t('Save MCP config JSON for LM Studio'),
			filters: { JSON: ['json'] },
		});
	}

	if (!targetUri || !qwenTargetUri || !lmStudioTargetUri) {
		return;
	}

	await writeTextFile(targetUri, editorContent);
	await writeTextFile(qwenTargetUri, qwenContent);
	await writeTextFile(lmStudioTargetUri, lmStudioContent);
	await writeQwenUserConfig(qwenPayload.mcpServers as Record<string, unknown>);
	const doc = await vscode.workspace.openTextDocument(targetUri);
	await vscode.window.showTextDocument(doc, { preview: false });

	const selfCheck = isHttp
		? await runMcpHttpSelfCheck(host, port, timeoutMs)
		: await runMcpStdioSelfCheck(serverEntryPath, targetWorkspacePath);
	if (selfCheck.ok) {
		vscode.window.showInformationMessage(vscode.l10n.t('Exported 3 MCP config JSON files and self-check passed: {0} / {1} / {2}', targetUri.fsPath, qwenTargetUri.fsPath, lmStudioTargetUri.fsPath));
	} else {
		vscode.window.showErrorMessage(vscode.l10n.t('MCP config JSON exported but self-check failed: {0}', selfCheck.detail));
	}
}

async function writeQwenUserConfig(serverEntries: Record<string, unknown>): Promise<void> {
	const userProfile = process.env.USERPROFILE;
	if (!userProfile) {
		return;
	}
	const qwenDir = vscode.Uri.file(pathModule.join(userProfile, '.qwen'));
	const settingsUri = vscode.Uri.joinPath(qwenDir, 'settings.json');
	const mcpUri = vscode.Uri.joinPath(qwenDir, 'mcp.json');
	try {
		await vscode.workspace.fs.createDirectory(qwenDir);
	} catch {
		return;
	}

	await upsertQwenServerEntries(settingsUri, serverEntries, true);
	await upsertQwenServerEntries(mcpUri, serverEntries, false);
}

async function upsertQwenServerEntries(uri: vscode.Uri, serverEntries: Record<string, unknown>, preserveSettingsRoot: boolean): Promise<void> {
	let root: Record<string, unknown> = {};
	try {
		const text = await readTextFile(uri);
		const parsed = JSON.parse(text);
		if (isRecord(parsed)) {
			root = parsed as Record<string, unknown>;
		}
	} catch {
		root = {};
	}

	if (!isRecord(root.mcpServers)) {
		root.mcpServers = {};
	}
	const servers = root.mcpServers as Record<string, unknown>;
	for (const name of Object.keys(servers)) {
		if (name === 'tova-stm32' || name.startsWith('tova-stm32-')) {
			delete servers[name];
		}
	}
	for (const [name, entry] of Object.entries(serverEntries)) {
		servers[name] = entry;
	}

	if (!preserveSettingsRoot) {
		root = { mcpServers: root.mcpServers };
	}

	await writeTextFile(uri, `${JSON.stringify(root, null, 2)}\n`);
}

async function runMcpHttpSelfCheck(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
	return new Promise(resolve => {
		const request = httpModule.get({ host, port, path: '/health', timeout: Math.max(1000, timeoutMs) }, response => {
			const status = response.statusCode ?? 0;
			response.resume();
			if (status >= 200 && status < 300) {
				resolve({ ok: true, detail: `HTTP /health ${status}` });
			} else {
				resolve({ ok: false, detail: `HTTP /health ${status}` });
			}
		});
		request.on('error', error => {
			const message = error instanceof Error ? error.message : String(error);
			resolve({ ok: false, detail: message });
		});
		request.on('timeout', () => {
			request.destroy();
			resolve({ ok: false, detail: 'HTTP /health timeout' });
		});
	});
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function copyDirectoryRecursive(source: vscode.Uri, target: vscode.Uri): Promise<void> {
	await vscode.workspace.fs.createDirectory(target);
	const entries = await vscode.workspace.fs.readDirectory(source);
	for (const [name, type] of entries) {
		const srcChild = vscode.Uri.joinPath(source, name);
		const dstChild = vscode.Uri.joinPath(target, name);
		if (type === vscode.FileType.Directory) {
			await copyDirectoryRecursive(srcChild, dstChild);
			continue;
		}
		const bytes = await vscode.workspace.fs.readFile(srcChild);
		await vscode.workspace.fs.writeFile(dstChild, bytes);
	}
}

async function ensureMcpServerInWorkspace(targetWorkspaceUri: vscode.Uri): Promise<string | undefined> {
	const targetServerEntry = vscode.Uri.joinPath(targetWorkspaceUri, 'mcp-server', 'index.js');
	const sourceCandidates: vscode.Uri[] = [];
	const rootWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (rootWorkspace) {
		sourceCandidates.push(vscode.Uri.joinPath(rootWorkspace, 'mcp-server'));
	}
	sourceCandidates.push(vscode.Uri.joinPath(extensionUri, '..', '..', 'mcp-server'));

	for (const candidate of sourceCandidates) {
		const candidateEntry = vscode.Uri.joinPath(candidate, 'index.js');
		if (!(await uriExists(candidateEntry))) {
			continue;
		}
		const targetDir = vscode.Uri.joinPath(targetWorkspaceUri, 'mcp-server');
		try {
			if (await uriExists(targetDir)) {
				await vscode.workspace.fs.delete(targetDir, { recursive: true, useTrash: false });
			}
		} catch {
			// Best effort delete. Copy below will report failure if it cannot proceed.
		}
		await copyDirectoryRecursive(candidate, targetDir);
		if (await uriExists(targetServerEntry)) {
			return targetServerEntry.fsPath;
		}
	}

	return undefined;
}

async function runMcpStdioSelfCheck(serverEntryPath: string, workspacePath: string): Promise<{ ok: boolean; detail: string }> {
	const rootWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const bundledDiagnosticPath = pathModule.join(pathModule.dirname(serverEntryPath), 'mcp_stdio_check.py');
	const fallbackDiagnosticPath = rootWorkspace ? pathModule.join(rootWorkspace, 'mcp_stdio_check.py') : '';
	const diagnosticScriptPath = await fileExists(bundledDiagnosticPath)
		? bundledDiagnosticPath
		: (fallbackDiagnosticPath && await fileExists(fallbackDiagnosticPath) ? fallbackDiagnosticPath : '');

	if (!diagnosticScriptPath) {
		return { ok: false, detail: 'mcp_stdio_check.py not found' };
	}

	const pythonCandidates = [
		await resolveCommandPath('python', workspacePath),
		await resolveCommandPath('py', workspacePath),
		'python',
		'py',
	].filter((candidate): candidate is string => Boolean(candidate));

	let lastError = 'Python not found';
	for (const command of pythonCandidates) {
		const isPyLauncher = /(^|[\\/])py(\.exe)?$/i.test(command);
		const args = isPyLauncher
			? ['-3', diagnosticScriptPath, '--workspace', workspacePath, '--server', serverEntryPath]
			: [diagnosticScriptPath, '--workspace', workspacePath, '--server', serverEntryPath];

		try {
			const result = await execFileAsync(command, args, workspacePath);
			const combined = `${result.stdout}\n${result.stderr}`;
			const tail = combined.split(/\r?\n/).filter(line => line.trim().length > 0).slice(-3).join(' | ');
			return { ok: true, detail: tail || 'python-diagnostic-ok' };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	return { ok: false, detail: lastError };
}

async function openWelcomeWizard(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.welcome', 'TovaIDE-STM Welcome', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getWelcomeHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'syncCatalog':
				await syncMcuCatalogFromCubeMX();
				break;
			case 'board':
				await openBoardConfigurator();
				break;
			case 'import':
				await vscode.commands.executeCommand('stm32.importCubeIDE');
				break;
			case 'env':
				await runEnvironmentCheck();
				break;
			case 'envSettings':
				await openEnvironmentSettingsDialog();
				break;
			case 'pin':
				await openPinVisualizer();
				break;
			case 'error':
				await explainLatestError();
				break;
		}
	});
}



async function openBoardConfigurator(): Promise<void> {
	const profiles = await getBoardProfilesFromCatalog();
	const mcuNames = await getMcuSelectorNamesFromCatalog(profiles);
	if (profiles.length === 0 && mcuNames.length === 0) {
		vscode.window.showErrorMessage(vscode.l10n.t('No available MCU definitions found. Check resources/stm32/mcu.'));
		return;
	}

	const panel = vscode.window.createWebviewPanel('stm32ux.boardConfigurator', 'TovaIDE-STM Board Config Studio', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getBoardConfiguratorHtml(panel.webview, profiles, mcuNames);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || message.type !== 'create' || !isRecord(message.payload)) {
			return;
		}

		const payload = message.payload as Record<string, unknown>;
		const selectionMode = payload.selectionMode === 'mcu' ? 'mcu' : 'board';
		const boardId = typeof payload.boardId === 'string' ? payload.boardId : '';
		const mcuName = typeof payload.mcuName === 'string' ? payload.mcuName.trim() : '';
		const projectName = typeof payload.projectName === 'string' ? payload.projectName.trim() : '';

		let profile: BoardProfile | undefined;
		if (selectionMode === 'board') {
			profile = profiles.find(item => item.id === boardId);
			if (!profile) {
				vscode.window.showErrorMessage(vscode.l10n.t('Please select a Board.'));
				return;
			}
		} else {
			if (mcuName.length === 0) {
				vscode.window.showErrorMessage(vscode.l10n.t('Please select a Commercial Part Number from the MCU/MPU Selector.'));
				return;
			}
			const matched = profiles.find(item => normalizeMcuKey(item.mcu) === normalizeMcuKey(mcuName));
			profile = matched ?? {
				id: `mcu-${mcuName.toLowerCase()}`,
				name: `MCU/MPU Selector (${mcuName})`,
				mcu: mcuName,
				description: 'Generated from CPN selected in MCU/MPU Selector',
				defaultPins: []
			};
		}

		if (projectName.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t('Please enter a project name.'));
			return;
		}

		const config: BoardConfiguratorPayload = {
			selectionMode,
			boardId,
			mcuName: profile.mcu,
			projectName,
			openPinGui: payload.openPinGui !== false,
		};

		await createProjectFromBoardConfigurator(profile, config);
	});
}

async function runEnvironmentCheck(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const configuredCubeMx = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	const configuredMetadata = vscode.workspace.getConfiguration('stm32').get<string>('cubeclt.metadataPath', '').trim();
	const inferredToolPaths = configuredMetadata ? await inferToolPathsFromMetadataPath(configuredMetadata) : {};

	const rows: string[] = [];

	if (configuredCubeMx) {
		outputChannel.appendLine(`[STM32-UX] Checking CubeMX path: ${configuredCubeMx}`);
		const exists = await vscode.workspace.fs.stat(vscode.Uri.file(configuredCubeMx)).then(() => {
			outputChannel.appendLine(`[STM32-UX] CubeMX path exists: ${configuredCubeMx}`);
			return true;
		}, (err) => {
			outputChannel.appendLine(`[STM32-UX] CubeMX path check failed: ${err}`);
			return false;
		});
		rows.push(`- STM32CubeMX: ${exists ? `✅ ${configuredCubeMx}` : `❌ configured path is invalid: ${configuredCubeMx}`}`);
	} else {
		const foundPath = await resolveCommandPath('STM32CubeMX', workspaceRoot);
		rows.push(`- STM32CubeMX: ${foundPath ? `✅ ${foundPath}` : '❌ not found'}`);
	}

	if (configuredMetadata) {
		outputChannel.appendLine(`[STM32-UX] Checking CubeCLT metadata path: ${configuredMetadata}`);
		const exists = await vscode.workspace.fs.stat(vscode.Uri.file(configuredMetadata)).then(() => {
			outputChannel.appendLine(`[STM32-UX] CubeCLT metadata path exists: ${configuredMetadata}`);
			return true;
		}, (err) => {
			outputChannel.appendLine(`[STM32-UX] CubeCLT metadata path check failed: ${err}`);
			return false;
		});
		rows.push(`- STM32CubeCLT_metadata: ${exists ? `✅ ${configuredMetadata}` : `❌ configured path is invalid: ${configuredMetadata}`}`);
	} else {
		const foundPath = await resolveCommandPath('STM32CubeCLT_metadata', workspaceRoot);
		rows.push(`- STM32CubeCLT_metadata: ${foundPath ? `✅ ${foundPath}` : '❌ not found'}`);
	}

	const tools = [
		{ id: 'STM32_Programmer_CLI', command: 'STM32_Programmer_CLI' },
		{ id: 'arm-none-eabi-gcc', command: 'arm-none-eabi-gcc' },
		{ id: 'git', command: 'git' }
	];
	for (const tool of tools) {
		const foundPath = await resolveCommandPath(tool.command, workspaceRoot);
		if (foundPath) {
			rows.push(`- ${tool.id}: ✅ ${foundPath}`);
			continue;
		}

		if (tool.id === 'STM32_Programmer_CLI' && inferredToolPaths.programmerCliPath) {
			rows.push(`- ${tool.id}: ✅ ${inferredToolPaths.programmerCliPath} (inferred from CubeCLT metadata)`);
			continue;
		}

		if (tool.id === 'arm-none-eabi-gcc' && inferredToolPaths.gccPath) {
			rows.push(`- ${tool.id}: ✅ ${inferredToolPaths.gccPath} (inferred from CubeCLT metadata)`);
			continue;
		}

		rows.push(`- ${tool.id}: ❌ not found (not in PATH)`);
	}

	const report = [
		'# STM32 Environment Check',
		'',
		'## Tool Detection',
		...rows,
		'',
		'## Configuration',
		`- stm32.cubemx.path: ${configuredCubeMx.length > 0 ? configuredCubeMx : '(not set)'}`,
		`- stm32.cubeclt.metadataPath: ${configuredMetadata.length > 0 ? configuredMetadata : '(not set)'}`,
		'',
		'## Hints',
		'- STM32_Programmer_CLI / arm-none-eabi-gcc can be auto-detected from CubeCLT metadata path even if not in PATH',
		'- Adding them to PATH allows the same executables to be used in external terminals and build tasks',
		'- Command Palette: `STM32: Detect CubeCLT Metadata`',
	].join('\n');

	outputChannel.appendLine('[STM32-UX] Environment check completed.');
	const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
	await vscode.window.showTextDocument(document, { preview: false });
}

async function explainLatestError(): Promise<void> {
	const diagnostics = vscode.languages.getDiagnostics();
	const firstError = diagnostics
		.flatMap(([uri, items]) => items
			.filter(item => item.severity === vscode.DiagnosticSeverity.Error)
			.map(item => ({ uri, item })))
		.at(0);

	if (!firstError) {
		vscode.window.showInformationMessage(vscode.l10n.t('No errors currently detected.'));
		return;
	}

	const message = firstError.item.message;
	const hint = getErrorHint(message);
	const doc = await vscode.workspace.openTextDocument({
		language: 'markdown',
		content: [
			'# Build Error Explanation',
			'',
			`- File: ${firstError.uri.fsPath}`,
			`- Line: ${firstError.item.range.start.line + 1}`,
			`- Error: ${message}`,
			'',
			`## Explanation`,
			hint,
		].join('\n')
	});
	await vscode.window.showTextDocument(doc, { preview: false });
}

function detectMcuFromIocText(iocText: string): string {
	const directName = iocText.match(/^Mcu\.Name\s*=\s*([^\r\n]+)/mi)?.[1]?.trim();
	if (directName && directName.toUpperCase().startsWith('STM32')) {
		return directName;
	}

	const userName = iocText.match(/^Mcu\.UserName\s*=\s*([^\r\n]+)/mi)?.[1]?.trim();
	if (userName && userName.toUpperCase().startsWith('STM32')) {
		return userName;
	}

	const cpnName = iocText.match(/^Mcu\.CPN\s*=\s*([^\r\n]+)/mi)?.[1]?.trim();
	if (cpnName && cpnName.toUpperCase().startsWith('STM32')) {
		return cpnName;
	}

	return 'STM32F446RETx';
}

function normalizeMcuKey(mcuKey: string): string {
	return mcuKey
		.trim()
		.replace(/\.json$/i, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

async function resolveMcuJsonName(mcuKey: string): Promise<string | undefined> {
	const map: Record<string, string> = {
		'STM32H743ZI': 'STM32H743ZI',
		'STM32H743': 'STM32H743ZI',
		'STM32L476RG': 'STM32L476RG',
		'STM32L476': 'STM32L476RG',
		'STM32WB55RG': 'STM32WB55RG',
		'STM32WB55': 'STM32WB55RG',
		'STM32F446RE': 'STM32F446RE',
		'STM32F446': 'STM32F446RE',
		'STM32F103C8': 'STM32F103C8',
		'STM32F103': 'STM32F103C8',
		'STM32G071RB': 'STM32G071RB',
		'STM32G071': 'STM32G071RB',
		'STM32U575RI': 'STM32U575RI',
		'STM32U575': 'STM32U575RI',
		'STM32C031C6': 'STM32C031C6',
		'STM32C031': 'STM32C031C6',
		'STM32F303K8': 'STM32F303K8',
		'STM32F303': 'STM32F303K8',
	};

	// Expand CubeMX-style parenthesized MCU names: STM32F303K(6-8)Tx → [STM32F303K6Tx, STM32F303K8Tx]
	const expandedVariants: string[] = [];
	const parenMatch = mcuKey.match(/^([^(]+)\(([A-Z0-9](?:-[A-Z0-9])*)\)(.*)$/i);
	if (parenMatch) {
		const prefix = parenMatch[1];
		const chars = parenMatch[2].split('-');
		const suffix = parenMatch[3];
		for (const c of chars) {
			expandedVariants.push(`${prefix}${c}${suffix}`);
		}
	}

	const raw = normalizeMcuKey(mcuKey);
	const trimmedVariant = raw.replace(/TX$/, '').replace(/X$/, '');
	const candidates = [
		raw,
		trimmedVariant,
		...expandedVariants.map(v => normalizeMcuKey(v)),
		...expandedVariants.map(v => normalizeMcuKey(v).replace(/TX$/, '').replace(/X$/, '')),
		map[raw],
		map[trimmedVariant],
		...expandedVariants.flatMap(v => {
			const k = normalizeMcuKey(v);
			const kt = k.replace(/TX$/, '').replace(/X$/, '');
			return [map[k], map[kt]].filter(Boolean);
		}),
	].filter((candidate): candidate is string => Boolean(candidate));

	const mcuCatalogUri = vscode.Uri.joinPath(extensionUri, '..', '..', 'resources', 'stm32', 'mcu');
	for (const candidate of Array.from(new Set(candidates))) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(mcuCatalogUri, `${candidate}.json`));
			return candidate;
		} catch {
			// Try next candidate.
		}
	}

	return undefined;
}

async function loadMcuPackagePins(mcuName?: string): Promise<Array<{ pin: string; mode: string }>> {
	if (mcuName) {
		const xmlPins = await loadMcuPinsFromCubeMxXml(mcuName);
		if (xmlPins.length > 0) {
			return xmlPins;
		}
	}

	const fallbackMcu = mcuName ?? 'STM32F446RE';
	const fileName = await resolveMcuJsonName(fallbackMcu);
	if (!fileName) {
		return [];
	}

	try {
		const jsonUri = vscode.Uri.joinPath(extensionUri, '..', '..', 'resources', 'stm32', 'mcu', `${fileName}.json`);
		const bytes = await vscode.workspace.fs.readFile(jsonUri);
		let text = '';
		for (const value of bytes) { text += String.fromCharCode(value); }
		const data = JSON.parse(text) as { pins?: Array<{ pin: string; mode: string }> };
		return data.pins ?? [];
	} catch {
		return [];
	}
}

async function getBoardProfilesFromCatalog(): Promise<BoardProfile[]> {
	const profiles: BoardProfile[] = [];
	const seen = new Set<string>();
	const addProfile = (profile: BoardProfile): void => {
		if (seen.has(profile.id)) {
			return;
		}
		seen.add(profile.id);
		profiles.push(profile);
	};

	for (const profile of PREFERRED_BOARD_PROFILES) {
		addProfile(profile);
	}

	let boardCatalog = extensionContextRef.globalState.get<CubeMxBoardCatalogItem[]>(CUBEMX_BOARD_CATALOG_KEY, []);
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	for (const candidate of buildCubeMxBoardDbCandidates(configured)) {
		if (await fileExists(candidate)) {
			const scannedBoardCatalog = await scanCubeMxBoardProfiles(vscode.Uri.file(candidate));
			const shouldUpdate = scannedBoardCatalog.length > boardCatalog.length
				|| (boardCatalog.length < 180 && scannedBoardCatalog.length > 0);
			if (shouldUpdate) {
				boardCatalog = scannedBoardCatalog;
				await extensionContextRef.globalState.update(CUBEMX_BOARD_CATALOG_KEY, boardCatalog);
			}
			break;
		}
	}
	for (const item of boardCatalog) {
		addProfile({
			id: item.id,
			name: item.name,
			mcu: item.mcu,
			description: item.description,
			defaultPins: []
		});
	}

	profiles.sort((a, b) => a.name.localeCompare(b.name));
	return profiles;
}

async function getMcuSelectorNamesFromCatalog(profiles: BoardProfile[]): Promise<string[]> {
	const names = new Set<string>();

	for (const profile of profiles) {
		if (profile.mcu) {
			names.add(profile.mcu.toUpperCase());
		}
	}

	const mcuCatalogUri = vscode.Uri.joinPath(extensionUri, '..', '..', 'resources', 'stm32', 'mcu');
	try {
		const entries = await vscode.workspace.fs.readDirectory(mcuCatalogUri);
		for (const [name, type] of entries) {
			if (type === vscode.FileType.File && name.toLowerCase().endsWith('.json')) {
				names.add(name.slice(0, -5).toUpperCase());
			}
		}
	} catch {
		// ignore resource catalog read errors
	}

	let syncedMcu = extensionContextRef.globalState.get<string[]>(CUBEMX_MCU_CATALOG_KEY, []);
	if (syncedMcu.length < 4500) {
		const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
		for (const candidate of buildCubeMxMcuDbCandidates(configured)) {
			if (await fileExists(candidate)) {
				syncedMcu = await scanCubeMxMcuNames(vscode.Uri.file(candidate));
				await extensionContextRef.globalState.update(CUBEMX_MCU_CATALOG_KEY, syncedMcu);
				break;
			}
		}
	}

	for (const mcu of syncedMcu) {
		names.add(mcu.toUpperCase());
	}

	return Array.from(names).sort();
}

async function syncMcuCatalogFromCubeMX(): Promise<void> {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	const mcuCandidates = buildCubeMxMcuDbCandidates(configured);
	const boardCandidates = buildCubeMxBoardDbCandidates(configured);

	let selectedMcuRoot: string | undefined;
	for (const candidate of mcuCandidates) {
		if (await fileExists(candidate)) {
			selectedMcuRoot = candidate;
			break;
		}
	}
	let selectedBoardRoot: string | undefined;
	for (const candidate of boardCandidates) {
		if (await fileExists(candidate)) {
			selectedBoardRoot = candidate;
			break;
		}
	}

	if (!selectedMcuRoot) {
		vscode.window.showErrorMessage(vscode.l10n.t('CubeMX MCU DB not found. Set stm32.cubemx.path and try again.'));
		return;
	}

	const mcuNames = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: vscode.l10n.t('Syncing CubeMX MCU catalog...'),
		cancellable: false,
	}, async progress => {
		progress.report({ message: vscode.l10n.t('Scanning MCU definitions') });
		return scanCubeMxMcuNames(vscode.Uri.file(selectedMcuRoot));
	});

	const boardItems = selectedBoardRoot
		? await scanCubeMxBoardProfiles(vscode.Uri.file(selectedBoardRoot))
		: [];

	await extensionContextRef.globalState.update(CUBEMX_MCU_CATALOG_KEY, mcuNames);
	await extensionContextRef.globalState.update(CUBEMX_BOARD_CATALOG_KEY, boardItems);
	outputChannel.appendLine(`[STM32-UX] Synced MCU catalog: ${mcuNames.length} entries (${selectedMcuRoot})`);
	if (selectedBoardRoot) {
		outputChannel.appendLine(`[STM32-UX] Synced Board catalog: ${boardItems.length} entries (${selectedBoardRoot})`);
	}
	vscode.window.showInformationMessage(vscode.l10n.t('CubeMX sync complete: {0} MCUs / {1} Boards', mcuNames.length, boardItems.length));
}

function buildCubeMxMcuDbCandidates(configuredPath: string): string[] {
	const candidates: string[] = [];
	const add = (path: string): void => {
		const resolved = pathModule.resolve(path);
		if (!candidates.includes(resolved)) {
			candidates.push(resolved);
		}
	};

	if (configuredPath.length > 0) {
		const base = configuredPath.toLowerCase().endsWith('.exe') ? pathModule.dirname(configuredPath) : configuredPath;
		add(pathModule.join(base, 'db', 'mcu'));
		add(pathModule.join(pathModule.dirname(base), 'db', 'mcu'));
		add(pathModule.join(base, 'STM32CubeMX', 'db', 'mcu'));
	}

	if (process.platform === 'win32') {
		add('C:/ST/STM32CubeMX/db/mcu');
		add('C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db/mcu');
	}

	return candidates;
}

function buildCubeMxBoardDbCandidates(configuredPath: string): string[] {
	const candidates: string[] = [];
	const add = (value: string): void => {
		const resolved = pathModule.resolve(value);
		if (!candidates.includes(resolved)) {
			candidates.push(resolved);
		}
	};

	if (configuredPath.length > 0) {
		const base = configuredPath.toLowerCase().endsWith('.exe') ? pathModule.dirname(configuredPath) : configuredPath;
		add(pathModule.join(base, 'db', 'board'));
		add(pathModule.join(base, 'db', 'plugins', 'boardmanager', 'boards'));
		add(pathModule.join(pathModule.dirname(base), 'db', 'board'));
		add(pathModule.join(pathModule.dirname(base), 'db', 'plugins', 'boardmanager', 'boards'));
		add(pathModule.join(base, 'STM32CubeMX', 'db', 'board'));
		add(pathModule.join(base, 'STM32CubeMX', 'db', 'plugins', 'boardmanager', 'boards'));
	}

	if (process.platform === 'win32') {
		add('C:/ST/STM32CubeMX/db/board');
		add('C:/ST/STM32CubeMX/db/plugins/boardmanager/boards');
		add('C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db/board');
		add('C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db/plugins/boardmanager/boards');
	}

	return candidates;
}

/** STM32C011F(4-6)Px → ['STM32C011F4PX', 'STM32C011F6PX'] */
function expandMcuVariantName(name: string): string[] {
	const parenRe = /\(([A-Z0-9][A-Z0-9,-]*)\)/i;
	const m = name.match(parenRe);
	if (!m) { return [name.toUpperCase()]; }
	const chars = m[1]
		.split(/[,-]/)
		.map(part => part.trim())
		.filter(part => part.length > 0);
	const results: string[] = [];
	for (const ch of chars) {
		results.push(...expandMcuVariantName(name.replace(m[0], ch)));
	}
	return results;
}

async function scanCubeMxMcuNames(root: vscode.Uri): Promise<string[]> {
	const names = new Set<string>();

	// 1) Parse families.xml and collect Name/RefName/RPN.
	// CubeMX UI count is closer to this union than Name-only parsing.
	const familiesUri = vscode.Uri.joinPath(root, 'families.xml');
	try {
		const familiesBytes = await vscode.workspace.fs.readFile(familiesUri);
		let familiesText = '';
		for (const v of familiesBytes) { familiesText += String.fromCharCode(v); }
		const mcuTagRe = /<Mcu\b[^>]*>/gi;
		let tagMatch: RegExpExecArray | null;
		while ((tagMatch = mcuTagRe.exec(familiesText)) !== null) {
			const tag = tagMatch[0];
			const nameAttr = tag.match(/\bName="([^"]+)"/i)?.[1];
			if (nameAttr) {
				for (const expanded of expandMcuVariantName(nameAttr)) {
					names.add(expanded.toUpperCase());
				}
			}

			const refNameAttr = tag.match(/\bRefName="([^"]+)"/i)?.[1];
			if (refNameAttr && refNameAttr.toUpperCase().startsWith('STM32')) {
				names.add(refNameAttr.toUpperCase());
			}

			const rpnAttr = tag.match(/\bRPN="([^"]+)"/i)?.[1];
			if (rpnAttr && rpnAttr.toUpperCase().startsWith('STM32')) {
				names.add(rpnAttr.toUpperCase());
			}
		}
	} catch {
		// families.xml not found — fall through to file scan
	}

	// 2) Also scan XML filenames (expands multi-variant file names)
	let entries: [string, vscode.FileType][] = [];
	try { entries = await vscode.workspace.fs.readDirectory(root); } catch { /* ignore */ }
	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.xml')) { continue; }
		const stem = name.slice(0, -4);
		if (!stem.toUpperCase().startsWith('STM32')) { continue; }
		for (const expanded of expandMcuVariantName(stem)) {
			names.add(expanded);
		}
	}

	return Array.from(names).sort();
}

async function scanCubeMxBoardProfiles(root: vscode.Uri): Promise<CubeMxBoardCatalogItem[]> {
	const results: CubeMxBoardCatalogItem[] = [];
	const seen = new Set<string>();
	const queue: vscode.Uri[] = [root];
	let scannedFiles = 0;

	while (queue.length > 0 && scannedFiles < 40000) {
		const current = queue.shift();
		if (!current) {
			break;
		}

		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(current);
		} catch {
			entries = [];
		}

		for (const [name, type] of entries) {
			if (type === vscode.FileType.Directory) {
				queue.push(vscode.Uri.joinPath(current, name));
				continue;
			}
			const lowerName = name.toLowerCase();
			if (type !== vscode.FileType.File || (!lowerName.endsWith('.xml') && !lowerName.endsWith('.ioc'))) {
				continue;
			}

			scannedFiles += 1;
			const fileUri = vscode.Uri.joinPath(current, name);
			let content = '';
			try {
				const bytes = await vscode.workspace.fs.readFile(fileUri);
				for (const value of bytes) {
					content += String.fromCharCode(value);
				}
			} catch {
				continue;
			}

			const fileStem = name.slice(0, -4);

			// A) Prefer *_Board.ioc (the richest board source; includes much more than *_Configs.xml)
			if (lowerName.endsWith('.ioc') && /_board(?:_allconfig)?$/i.test(fileStem)) {
				const normalizedStem = fileStem
					.replace(/_trustzoneenabled/ig, '')
					.replace(/_allconfig/ig, '');
				const id = `cubemx-board-${normalizedStem.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
				if (seen.has(id)) {
					continue;
				}

				const mcuNameMatch = content.match(/^Mcu\.Name\s*=\s*(STM32[A-Z0-9()_-]+)/mi);
				const genericMcuMatch = content.match(/\bSTM32[A-Z0-9()_-]+\b/i);
				const mcu = (mcuNameMatch?.[1] ?? genericMcuMatch?.[0] ?? '').toUpperCase();
				if (!mcu) {
					continue;
				}

				const displayName = normalizedStem
					.replace(/^[A-Z0-9]+_/, '')
					.replace(/_STM32[A-Z0-9()_-]+_Board$/i, '')
					.replace(/_Board$/i, '')
					.replace(/_/g, ' ')
					.trim();

				seen.add(id);
				results.push({
					id,
					name: displayName || normalizedStem,
					mcu,
					description: 'CubeMX Board DB (.ioc)'
				});
				continue;
			}

			// B) Fallback: *_Configs.xml / *_Modes.xml
			if (!/_(Configs|Modes)_?$/i.test(fileStem)) {
				continue;
			}
			const boardStem = fileStem.replace(/_(Configs|Modes)_?$/i, '');
			const titleMatch = content.match(/Name="([^"]+)"/i);
			const boardName = (titleMatch?.[1] ?? boardStem).trim();
			const mcuMatch = content.match(/STM32[A-Z0-9]+/i);
			const guessedFromBoard = boardStem.match(/([A-Z]\d{3}[A-Z]{1,3}\d?[A-Z]?)/i);
			const mcu = (mcuMatch?.[0] ?? (guessedFromBoard ? `STM32${guessedFromBoard[1].toUpperCase()}TX` : '')).toUpperCase();
			if (!mcu) {
				continue;
			}
			const id = `cubemx-board-${boardStem.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
			if (seen.has(id)) {
				continue;
			}
			seen.add(id);
			results.push({
				id,
				name: boardStem,
				mcu,
				description: `From CubeMX Board DB (${boardName})`
			});
		}
	}

	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}

async function loadMcuPinDefinitions(mcuName?: string): Promise<Array<{ pin: string; mode?: string; altFunctions?: string[] }>> {
	const fileName = await resolveMcuJsonName(mcuName ?? 'STM32F446RE');
	if (!fileName) {
		return [];
	}
	try {
		const jsonUri = vscode.Uri.joinPath(extensionUri, '..', '..', 'resources', 'stm32', 'mcu', `${fileName}.json`);
		const bytes = await vscode.workspace.fs.readFile(jsonUri);
		let text = '';
		for (const value of bytes) { text += String.fromCharCode(value); }
		const data = JSON.parse(text) as { pins?: Array<{ pin: string; mode?: string; altFunctions?: string[] }> };
		return data.pins ?? [];
	} catch {
		return [];
	}
}

/** Search the db/mcu folder of CubeMX MCU DB for the XML file matching the target MCU */
async function findCubeMxMcuXmlFile(mcuName: string): Promise<vscode.Uri | undefined> {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	for (const candidate of buildCubeMxMcuDbCandidates(configured)) {
		if (!(await fileExists(candidate))) { continue; }
		const rootUri = vscode.Uri.file(candidate);
		let entries: [string, vscode.FileType][] = [];
		try { entries = await vscode.workspace.fs.readDirectory(rootUri); } catch { continue; }
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.xml')) { continue; }
			const stem = name.slice(0, -4);
			if (!stem.toUpperCase().startsWith('STM32')) { continue; }
			if (cubeMxFileNameMatchesMcu(stem, mcuName)) {
				return vscode.Uri.joinPath(rootUri, name);
			}
		}
	}
	return undefined;
}

/** Check whether a CubeMX filename pattern like "STM32F446R(C-E)Tx" matches the given MCU name */
function cubeMxFileNameMatchesMcu(fileName: string, mcuName: string): boolean {
	const pattern = fileName.replace(/\(([A-Z0-9](?:-[A-Z0-9])+)\)/gi, (_, chars: string) =>
		'[' + chars.replace(/-/g, '') + ']'
	);
	try {
		return new RegExp('^' + pattern + '$', 'i').test(mcuName);
	} catch {
		return false;
	}
}

function normalizeCubeMxPinName(rawPinName: string): string {
	const normalized = rawPinName.trim().toUpperCase();
	const gpio = normalized.match(/P[A-K][0-9]{1,2}/);
	if (gpio) {
		return gpio[0];
	}
	return normalized.split('/')[0].trim();
}

function inferDefaultModeFromCubeMxSignals(pinName: string, signals: string[]): string {
	const upperPin = pinName.toUpperCase();
	const upperSignals = signals.map(s => s.toUpperCase());

	if (upperPin === 'PA13') { return 'SYS_SWDIO'; }
	if (upperPin === 'PA14') { return 'SYS_SWCLK'; }
	if (upperSignals.some(s => s.includes('RCC_OSC32_IN') || s.includes('OSC32_IN'))) { return 'RCC_OSC32_IN'; }
	if (upperSignals.some(s => s.includes('RCC_OSC32_OUT') || s.includes('OSC32_OUT'))) { return 'RCC_OSC32_OUT'; }
	if (upperSignals.some(s => s.includes('RCC_OSC_IN') || s === 'OSC_IN')) { return 'RCC_OSC_IN'; }
	if (upperSignals.some(s => s.includes('RCC_OSC_OUT') || s === 'OSC_OUT')) { return 'RCC_OSC_OUT'; }

	const preferred = signals.find(s => {
		const u = s.toUpperCase();
		return u.startsWith('SYS') || u.startsWith('RCC') || u.startsWith('RTC');
	});
	if (preferred) {
		if (preferred.toUpperCase() === 'SWDIO') { return 'SYS_SWDIO'; }
		if (preferred.toUpperCase() === 'SWCLK') { return 'SYS_SWCLK'; }
		return preferred;
	}

	if (/^P[A-K][0-9]{1,2}$/.test(upperPin)) {
		return 'GPIO_Input';
	}

	return 'Unused';
}

async function loadMcuPinsFromCubeMxXml(mcuName: string): Promise<Array<{ pin: string; mode: string }>> {
	const xmlUri = await findCubeMxMcuXmlFile(mcuName);
	if (!xmlUri) {
		return [];
	}

	let text = '';
	try {
		const bytes = await vscode.workspace.fs.readFile(xmlUri);
		for (const value of bytes) { text += String.fromCharCode(value); }
	} catch {
		return [];
	}

	const entries: Array<{ pin: string; mode: string; pos: number; idx: number }> = [];
	const pinRe = /<Pin\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Pin>)/gi;
	let match: RegExpExecArray | null;
	let fallbackPos = 0;
	while ((match = pinRe.exec(text)) !== null) {
		const attrs = match[1] ?? '';
		const body = match[2] ?? '';
		const nameMatch = attrs.match(/\bName="([^"]+)"/i);
		if (!nameMatch) { continue; }

		const pinName = normalizeCubeMxPinName(nameMatch[1]);
		if (!pinName) { continue; }

		const posMatch = attrs.match(/\bPosition="(\d+)"/i);
		const pos = posMatch ? parseInt(posMatch[1], 10) : (fallbackPos + 1);
		fallbackPos = Math.max(fallbackPos + 1, pos);

		const signals: string[] = [];
		const signalRe = /<Signal\b[^>]*\bName="([^"]+)"/gi;
		let signalMatch: RegExpExecArray | null;
		while ((signalMatch = signalRe.exec(body)) !== null) {
			signals.push(signalMatch[1].trim());
		}

		entries.push({
			pin: pinName,
			mode: inferDefaultModeFromCubeMxSignals(pinName, signals),
			pos,
			idx: entries.length,
		});
	}

	entries.sort((a, b) => a.pos === b.pos ? a.idx - b.idx : a.pos - b.pos);
	return entries.map(e => ({ pin: e.pin, mode: e.mode }));
}

/** Load Pin → Signal name list from CubeMX MCU XML */
async function loadPinSignalsFromCubeMxXml(xmlUri: vscode.Uri): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	let text = '';
	try {
		const bytes = await vscode.workspace.fs.readFile(xmlUri);
		for (const v of bytes) { text += String.fromCharCode(v); }
	} catch {
		return result;
	}

	// Match <Pin Name="PA0" ...>...</Pin> blocks (including self-closing)
	const pinBlockRe = /<Pin\b([^>]*)>([\s\S]*?)<\/Pin>/gi;
	let pinMatch: RegExpExecArray | null;
	while ((pinMatch = pinBlockRe.exec(text)) !== null) {
		const attrs = pinMatch[1];
		const body = pinMatch[2];
		const nameAttr = attrs.match(/\bName="([^"]+)"/i);
		if (!nameAttr) { continue; }
		const rawPinName = nameAttr[1];
		// Normalize: "PC14-OSC32_IN" → use only "PC14"
		const pinBaseName = rawPinName.split('-')[0].split('/')[0].trim().toUpperCase();
		if (!/^P[A-K][0-9]{1,2}$/.test(pinBaseName)) { continue; }
		const signals: string[] = [];
		const sigRe = /<Signal\b[^>]*\bName="([^"]+)"/gi;
		let sm: RegExpExecArray | null;
		while ((sm = sigRe.exec(body)) !== null) {
			signals.push(sm[1]);
		}
		if (!result.has(pinBaseName) && signals.length > 0) {
			result.set(pinBaseName, signals);
		}
	}
	return result;
}

interface IocFullSettings {
	pinAssignments: Record<string, string>;
	pinSignals: Record<string, string[]>;
	pinLocks: Record<string, boolean>;
	pinGpioConfigs: Record<string, Record<string, string>>;
	nvicSettings: Record<string, Record<string, string>>;
	dmaLines: Array<{ key: string; value: string }>;
	paramSettings: Record<string, Record<string, string>>;
	userConstants: Array<{ name: string; value: string }>;
	systemSettings: Record<string, string>;
}

function parseFullIocSettings(text: string): IocFullSettings {
	const s: IocFullSettings = {
		pinAssignments: {},
		pinSignals: {},
		pinLocks: {},
		pinGpioConfigs: {},
		nvicSettings: {},
		dmaLines: [],
		paramSettings: {},
		userConstants: [],
		systemSettings: {}
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) { continue; }
		const eqIdx = line.indexOf('=');
		if (eqIdx < 0) { continue; }
		const key = line.slice(0, eqIdx).trim();
		const value = line.slice(eqIdx + 1).trim();

		// Pin assignment: PA5=GPIO_Output
		if (/^P[A-K][0-9]{1,2}$/.test(key)) {
			s.pinAssignments[key] = value;
			if (!s.pinSignals[key]) { s.pinSignals[key] = []; }
			if (value && !s.pinSignals[key].includes(value)) {
				s.pinSignals[key].push(value);
			}
			continue;
		}

		// Pin signal assignment: PA9.Signal=USART1_TX / PA13-SYS_JTMS.Signal=SYS_JTMS-SWDIO
		const pinSignalM = key.match(/^(P[A-K][0-9]{1,2})(?:[-_][^.=]+)?\.Signal$/);
		if (pinSignalM) {
			const pin = pinSignalM[1];
			if (!s.pinSignals[pin]) { s.pinSignals[pin] = []; }
			if (value && !s.pinSignals[pin].includes(value)) {
				s.pinSignals[pin].push(value);
			}
			continue;
		}

		const pinLockedM = key.match(/^(P[A-K][0-9]{1,2})(?:[-_][^.=]+)?\.(Locked|Lock)$/i);
		if (pinLockedM) {
			const pin = pinLockedM[1];
			const v = value.toUpperCase();
			s.pinLocks[pin] = v === '1' || v === 'TRUE' || v === 'ENABLE' || v === 'LOCKED' || v === 'YES';
			continue;
		}

		// Pin GPIO config: PA5-GPIO_Output.GPIO_Speed=HIGH / PA5.GPIO_Label=LD3[Red]
		const pinCfgM = key.match(/^(P[A-K][0-9]{1,2})(?:-[^.]+)?\.(.+)$/);
		if (pinCfgM) {
			if (!s.pinGpioConfigs[pinCfgM[1]]) { s.pinGpioConfigs[pinCfgM[1]] = {}; }
			s.pinGpioConfigs[pinCfgM[1]][pinCfgM[2]] = value;
			continue;
		}

		// NVIC: NVIC.USART2_IRQn_IRQChannelState=ENABLE
		if (key.startsWith('NVIC.')) {
			const nvicKey = key.slice(5);
			const nvicM = nvicKey.match(/^(.+?)_(IRQChannelState|IRQChannelPreemptionPriority|IRQChannelSubPriority|IRQForcedDisabled)$/);
			if (nvicM) {
				if (!s.nvicSettings[nvicM[1]]) { s.nvicSettings[nvicM[1]] = {}; }
				s.nvicSettings[nvicM[1]][nvicM[2]] = value;
			}
			continue;
		}

		// DMA: DMA.Request1=USART2_TX
		if (key.startsWith('DMA.')) {
			s.dmaLines.push({ key, value });
			continue;
		}

		// User constants: ProjectManager.UserConstants=NAME1:VAL1,NAME2:VAL2
		if (key === 'ProjectManager.UserConstants') {
			if (value.trim()) {
				for (const part of value.split(',')) {
					const ci = part.indexOf(':');
					if (ci >= 0) {
						s.userConstants.push({ name: part.slice(0, ci).trim(), value: part.slice(ci + 1).trim() });
					}
				}
			}
			continue;
		}

		// System settings
		if (key === 'board' || key.startsWith('ProjectManager.') || key.startsWith('Mcu.') || key.startsWith('File.') || key.startsWith('KeepUserPlacement')) {
			s.systemSettings[key] = value;
			continue;
		}

		// Parameter settings: ADC1.Resolution=ADC_RESOLUTION_12B
		const paramM = key.match(/^([A-Za-z][A-Za-z0-9_]*)\.(.+)$/);
		if (paramM) {
			if (!s.paramSettings[paramM[1]]) { s.paramSettings[paramM[1]] = {}; }
			s.paramSettings[paramM[1]][paramM[2]] = value;
		}
	}
	return s;
}

function isLikelyPeripheralSignal(signal: string): boolean {
	const upper = signal.toUpperCase();
	return upper.startsWith('GPIO')
		|| upper.startsWith('USART')
		|| upper.startsWith('UART')
		|| upper.startsWith('I2C')
		|| upper.startsWith('SPI')
		|| upper.startsWith('I2S')
		|| upper.startsWith('ADC')
		|| upper.startsWith('DAC')
		|| upper.startsWith('TIM')
		|| upper.startsWith('LPTIM')
		|| upper.startsWith('CAN')
		|| upper.startsWith('FDCAN')
		|| upper.startsWith('SDIO')
		|| upper.startsWith('SDMMC')
		|| upper.startsWith('FMC')
		|| upper.startsWith('QUADSPI')
		|| upper.startsWith('OCTOSPI');
}

function looksLikeBoardRole(label: string): boolean {
	const value = label.trim();
	if (!value) { return false; }
	const upper = value.toUpperCase();
	if (isLikelyPeripheralSignal(upper)) { return false; }
	if (upper === 'UNUSED' || upper === 'NOT_CONNECTED' || upper === 'NC') { return false; }
	return /\[.+\]/.test(value)
		|| /^(LD\d+|LED\d*|B\d+|STLK_|USB_|RMII_|MII_|ETH_|ARD_|PMOD_|JP\d+|CN\d+|TMS|TCK|TDI|TDO|NTRST|BOOT\d*)/i.test(value)
		|| /(OVERCURRENT|POWERSWITCHON|FAULT|BUTTON|SWITCH|VCP|DEBUG)/i.test(value);
}

function extractBoardRolesFromSettings(settings: IocFullSettings): BoardRoleMetadata {
	const roleByPin: Record<string, string> = {};
	const fixedByPin: Record<string, boolean> = {};

	const pinCandidates = new Set<string>([
		...Object.keys(settings.pinAssignments),
		...Object.keys(settings.pinSignals),
		...Object.keys(settings.pinGpioConfigs),
		...Object.keys(settings.pinLocks),
	]);

	for (const pin of pinCandidates) {
		const cfg = settings.pinGpioConfigs[pin] ?? {};
		const label = (cfg['GPIO_Label'] ?? '').trim();
		let role = '';

		if (label && looksLikeBoardRole(label)) {
			role = trimUsageLabel(label);
		}

		if (!role) {
			const signal = (settings.pinSignals[pin] ?? []).map(v => normalizeSignalUsageLabel(v)).find(v => looksLikeBoardRole(v));
			if (signal) {
				role = trimUsageLabel(signal);
			}
		}

		if (role) {
			roleByPin[pin.toUpperCase()] = role;
			fixedByPin[pin.toUpperCase()] = true;
		}

		if (settings.pinLocks[pin]) {
			fixedByPin[pin.toUpperCase()] = true;
		}
	}

	return { roleByPin, fixedByPin, source: 'ioc' };
}

function scoreBoardIocMatch(content: string, mcuName: string, packageName?: string, boardHint?: string): number {
	let score = 0;
	const mcuValue = content.match(/^Mcu\.Name\s*=\s*([^\r\n]+)/mi)?.[1]?.trim();
	if (mcuValue) {
		if (mcuValue.toUpperCase() === mcuName.toUpperCase()) { score += 6; }
		else if (normalizeMcuKey(mcuValue) === normalizeMcuKey(mcuName)) { score += 5; }
		else if (normalizeMcuKey(mcuValue).startsWith(normalizeMcuKey(mcuName).slice(0, 8))) { score += 2; }
	}

	if (packageName) {
		const pkgValue = content.match(/^Mcu\.Package\s*=\s*([^\r\n]+)/mi)?.[1]?.trim();
		if (pkgValue && pkgValue.toUpperCase() === packageName.toUpperCase()) {
			score += 3;
		}
	}

	if (boardHint) {
		const hint = boardHint.toLowerCase();
		if (content.toLowerCase().includes(hint)) {
			score += 4;
		}
	}

	return score;
}

async function loadBoardRoleMetadataFromCubeMx(mcuName: string, packageName?: string, boardHint?: string): Promise<BoardRoleMetadata | undefined> {
	const configured = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	const roots = buildCubeMxBoardDbCandidates(configured);
	let best: { score: number; metadata: BoardRoleMetadata } | undefined;

	for (const root of roots) {
		if (!(await fileExists(root))) { continue; }
		const queue: vscode.Uri[] = [vscode.Uri.file(root)];
		let scanned = 0;
		while (queue.length > 0 && scanned < 8000) {
			const current = queue.shift();
			if (!current) { break; }
			let entries: [string, vscode.FileType][] = [];
			try { entries = await vscode.workspace.fs.readDirectory(current); } catch { entries = []; }
			for (const [name, type] of entries) {
				if (type === vscode.FileType.Directory) {
					queue.push(vscode.Uri.joinPath(current, name));
					continue;
				}
				if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.ioc') || !/_board(?:_allconfig)?\.ioc$/i.test(name)) {
					continue;
				}
				scanned += 1;
				let content = '';
				try {
					const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(current, name));
					for (const value of bytes) { content += String.fromCharCode(value); }
				} catch {
					continue;
				}
				const score = scoreBoardIocMatch(content, mcuName, packageName, boardHint);
				if (score < 3) { continue; }
				const parsed = parseFullIocSettings(content);
				const extracted = extractBoardRolesFromSettings(parsed);
				const roleCount = Object.keys(extracted.roleByPin).length;
				if (roleCount === 0) { continue; }
				const totalScore = score + Math.min(roleCount, 6);
				if (!best || totalScore > best.score) {
					best = {
						score: totalScore,
						metadata: {
							roleByPin: extracted.roleByPin,
							fixedByPin: extracted.fixedByPin,
							source: `cubemx-board:${name}`,
						}
					};
				}
			}
		}
	}

	return best?.metadata;
}

async function resolveBoardRoleMetadata(
	mcuName: string | undefined,
	packageName: string | undefined,
	iocSettings: IocFullSettings
): Promise<BoardRoleMetadata> {
	const fromIoc = extractBoardRolesFromSettings(iocSettings);
	const boardHint = iocSettings.systemSettings.board;
	if (!mcuName) {
		return fromIoc;
	}

	const cacheKey = `${normalizeMcuKey(mcuName)}|${(packageName ?? '').toUpperCase()}|${(boardHint ?? '').toLowerCase()}`;
	const cached = boardRoleMetadataCache.get(cacheKey);
	if (cached) {
		const mergedRoleByPin = { ...cached.roleByPin, ...fromIoc.roleByPin };
		const mergedFixedByPin = { ...cached.fixedByPin, ...fromIoc.fixedByPin };
		return { roleByPin: mergedRoleByPin, fixedByPin: mergedFixedByPin, source: `${cached.source}+ioc` };
	}

	const fromBoard = await loadBoardRoleMetadataFromCubeMx(mcuName, packageName, boardHint);
	if (!fromBoard) {
		boardRoleMetadataCache.set(cacheKey, fromIoc);
		return fromIoc;
	}

	const merged: BoardRoleMetadata = {
		roleByPin: { ...fromBoard.roleByPin, ...fromIoc.roleByPin },
		fixedByPin: { ...fromBoard.fixedByPin, ...fromIoc.fixedByPin },
		source: `${fromBoard.source}+ioc`,
	};
	boardRoleMetadataCache.set(cacheKey, merged);
	return merged;
}

async function getPinModeGroupsForPin(mcuName: string | undefined, pinName: string, currentMode: string): Promise<Record<string, string[]>> {
	const values = new Set<string>();
	values.add('GPIO_Output');
	values.add('GPIO_Input');
	values.add('GPIO_Analog');
	values.add('Reset_State');

	// 1. Try CubeMX MCU XML (most complete — all Signal names from db/mcu/)
	const targetMcu = mcuName ?? 'STM32F446RETx';
	const xmlUri = await findCubeMxMcuXmlFile(targetMcu);
	if (xmlUri) {
		const pinSignals = await loadPinSignalsFromCubeMxXml(xmlUri);
		const pinKey = pinName.toUpperCase();
		const signals = pinSignals.get(pinKey) ?? [];
		for (const sig of signals) {
			if (sig.toUpperCase() === 'GPIO') {
				// GPIO expands to standard modes
			} else if (!sig.toUpperCase().startsWith('EVENTOUT') && !sig.toUpperCase().startsWith('ANALOG')) {
				values.add(sig);
			}
		}
	}

	// 2. Fallback: resource JSON altFunctions
	if (values.size <= 4) {
		const defs = await loadMcuPinDefinitions(mcuName);
		const found = defs.find(p => p.pin.toUpperCase() === pinName.toUpperCase());
		if (found?.mode) { values.add(found.mode); }
		for (const alt of (found?.altFunctions ?? [])) { values.add(alt); }
	}

	if (currentMode) { values.add(currentMode); }

	const groups: Record<string, string[]> = {};
	for (const mode of values) {
		const upper = mode.toUpperCase();
		let group = 'Other';
		if (upper.startsWith('RESET_STATE') || upper.startsWith('GPIO')) { group = 'GPIO'; }
		else if (upper.startsWith('USART') || upper.startsWith('UART') || upper.startsWith('LPUART')) { group = 'UART/USART'; }
		else if (upper.startsWith('I2C') || upper.startsWith('FMPI2C')) { group = 'I2C'; }
		else if (upper.startsWith('SPI') || upper.startsWith('I2S')) { group = 'SPI/I2S'; }
		else if (upper.startsWith('ADC') || upper.startsWith('DAC')) { group = 'ADC/DAC'; }
		else if (upper.startsWith('TIM') || upper.startsWith('LPTIM') || upper.startsWith('HRTIM')) { group = 'TIM/PWM'; }
		else if (upper.startsWith('CAN') || upper.startsWith('FDCAN')) { group = 'CAN/FDCAN'; }
		else if (upper.startsWith('USB') || upper.startsWith('OTG')) { group = 'USB'; }
		else if (upper.startsWith('ETH') || upper.startsWith('RMII') || upper.startsWith('MII')) { group = 'Ethernet'; }
		else if (upper.startsWith('SDIO') || upper.startsWith('SDMMC')) { group = 'SDIO/SDMMC'; }
		else if (upper.startsWith('QUADSPI') || upper.startsWith('OCTOSPI') || upper.startsWith('FSMCR') || upper.startsWith('FMC')) { group = 'FMC/QSPI'; }
		else if (upper.startsWith('RCC') || upper.startsWith('RTC') || upper.startsWith('SYS')) { group = 'RCC/RTC/SYS'; }
		else if (upper.startsWith('SAI') || upper.startsWith('SPDIFRX') || upper.startsWith('SPDIF')) { group = 'Audio'; }

		if (!groups[group]) { groups[group] = []; }
		groups[group].push(mode);
	}

	for (const key of Object.keys(groups)) {
		groups[key] = Array.from(new Set(groups[key])).sort((a, b) => a.localeCompare(b));
	}

	return Object.keys(groups).length > 0 ? groups : PIN_MODE_GROUPS;
}

async function openPinVisualizer(): Promise<void> {
	const iocUri = await findIocFile();
	const panel = vscode.window.createWebviewPanel('stm32ux.pinVisualizer', 'STM32 Pin Visualizer', vscode.ViewColumn.Active, { enableScripts: true });
	let panelDetectedMcu: string | undefined;
	let panelFixedPins = new Set<string>();
	const render = async (): Promise<void> => {
		let pins: Array<{ pin: string; mode: string }> = [];
		let detectedMcu: string | undefined;
		let iocSettings: IocFullSettings = parseFullIocSettings('');
		let packageName: string | undefined;
		let boardRoleMeta: BoardRoleMetadata = { roleByPin: {}, fixedByPin: {}, source: 'none' };
		const generatedConfiguredPins = await loadGeneratedCodePinAssignments();
		if (iocUri) {
			const bytes = await vscode.workspace.fs.readFile(iocUri);
			let text = '';
			for (const value of bytes) {
				text += String.fromCharCode(value);
			}
			const configuredPins = mergeConfiguredPins(parsePinLines(text), generatedConfiguredPins);
			detectedMcu = detectMcuFromIocText(text);
			packageName = parseIocPackageName(text);
			iocSettings = parseFullIocSettings(text);
			boardRoleMeta = await resolveBoardRoleMetadata(detectedMcu, packageName, iocSettings);
			// Use canonical pin list from JSON resource (matches real package), then
			// overlay .ioc configured modes — same logic as CubeMX's reset-state baseline.
			const canonicalPins = await loadMcuPackagePins(detectedMcu);
			if (canonicalPins.length > 0) {
				const configMap = new Map(configuredPins.map(p => [p.pin.toUpperCase(), p.mode]));
				pins = canonicalPins.map(p => ({
					pin: p.pin,
					mode: configMap.get(p.pin.toUpperCase()) ?? p.mode, // keep reset-state default if not configured
				}));
			} else {
				const totalPins = getPackagePinCount(text, detectedMcu);
				pins = buildFullPackagePins(configuredPins, totalPins);
			}
			panel.title = `STM32 Pin Visualizer — ${detectedMcu ?? 'STM32'} (${pins.length} pin)`;
			panelDetectedMcu = detectedMcu;
		} else {
			// No .ioc: recover current pin modes from generated sources (gpio.c/main.h) if possible.
			if (generatedConfiguredPins.length > 0) {
				const generatedMcu = await inferMcuFromGeneratedCode();
				const fallback = await loadMcuPackagePins(generatedMcu);
				if (fallback.length > 0) {
					const configMap = new Map(generatedConfiguredPins.map(p => [p.pin.toUpperCase(), p.mode]));
					pins = fallback.map(p => ({
						pin: p.pin,
						mode: configMap.get(p.pin.toUpperCase()) ?? p.mode,
					}));
					panel.title = `STM32 Pin Visualizer — Restored from generated code ${generatedMcu ? ('(' + generatedMcu + ')') : ''} (${pins.length} pin)`;
					panelDetectedMcu = generatedMcu;
				} else {
					pins = generatedConfiguredPins;
					panel.title = `STM32 Pin Visualizer — Restored from generated code (${pins.length} pin)`;
					panelDetectedMcu = undefined;
				}
			} else {
				// No .ioc and no generated sources: use default MCU baseline.
				const fallback = await loadMcuPackagePins();
				pins = fallback.length > 0 ? fallback : buildFullPackagePins([], 64);
				panel.title = 'STM32 Pin Visualizer — STM32F446RE (default)';
				panelDetectedMcu = 'STM32F446RETx';
			}
		}
		panelFixedPins = new Set(Object.keys(boardRoleMeta.fixedByPin).map(pin => pin.toUpperCase()));
		panel.webview.html = getPinVisualizerHtml(panel.webview, pins, iocUri?.fsPath, iocSettings, packageName, detectedMcu ?? panelDetectedMcu, boardRoleMeta.roleByPin, boardRoleMeta.fixedByPin);
	};

	let activeIocUri = iocUri;

	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message)) { return; }

		if (message.type === 'editPin' && typeof message.pin === 'string') {
			if (panelFixedPins.has(message.pin.toUpperCase())) {
				vscode.window.showWarningMessage(vscode.l10n.t('{0} is a board-fixed pin and cannot be edited.', message.pin));
				return;
			}
			if (!activeIocUri) {
				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (!wsFolder) {
					vscode.window.showWarningMessage(vscode.l10n.t('No workspace open. Open a folder first then retry.'));
					return;
				}
				const choice = await vscode.window.showInformationMessage(
					vscode.l10n.t('.ioc file not found. Create a new one with STM32F446RE defaults?'),
					vscode.l10n.t('Create'), vscode.l10n.t('Cancel')
				);
				if (choice !== vscode.l10n.t('Create')) { return; }
				const newIocUri = vscode.Uri.joinPath(wsFolder.uri, 'project.ioc');
				const mcuPins = await loadMcuPackagePins();
				const configPins = mcuPins.filter(p => p.mode && p.mode !== 'Reset_State' && p.mode !== 'Analog' && !p.mode.startsWith('__'));
				const pinEntries = configPins.map((p, i) => `Mcu.Pin${i}=${p.pin}`);
				const pinSignals = configPins.map(p => `${p.pin}.Signal=${p.mode}`);
				const lines = [
					'#MicroXplorer Configuration settings - do not modify',
					'File.Version=6',
					'KeepUserPlacement=true',
					'LibraryCopySrc=1',
					'Mcu.CPN=STM32F446RETx',
					'Mcu.Family=STM32F4',
					'Mcu.Name=STM32F446RETx',
					'Mcu.IP0=GPIO',
					'Mcu.IP1=RCC',
					'Mcu.IP2=SYS',
					'Mcu.IPNb=3',
					'Mcu.ThirdPartyNb=0',
					...pinEntries,
					`Mcu.PinsNb=${configPins.length}`,
					'Mcu.UserName=STM32F446RETx',
					'MxCube.Version=6.10.0',
					'MxDb.Version=DB.6.0.110',
					...pinSignals,
					'ProjectManager.ProjectBaudRate=115200',
					'ProjectManager.ProjectFileName=project.ioc',
					'ProjectManager.ProjectName=project',
					'ProjectManager.ToolChain=Makefile',
					'ProjectManager.NoMain=false',
					'ProjectManager.ComputerToolchain=0',
					'ProjectManager.LibraryCopySrc=1',
				];
				await writeTextFile(newIocUri, lines.join('\n') + '\n');
				activeIocUri = newIocUri;
				vscode.window.showInformationMessage(vscode.l10n.t('project.ioc created.'));
			}
			// Send mode list + current mode back to webview for the in-webview dialog
			let currentMode = '';
			let detectedMcu: string | undefined;
			if (activeIocUri) {
				const bytes = await vscode.workspace.fs.readFile(activeIocUri);
				let text = '';
				for (const value of bytes) { text += String.fromCharCode(value); }
				detectedMcu = detectMcuFromIocText(text);
				const m = text.match(new RegExp(`^${message.pin}=([^\\r\\n]+)`, 'm'));
				if (m) { currentMode = m[1]; }
			}
			const groups = await getPinModeGroupsForPin(detectedMcu, message.pin, currentMode);
			await panel.webview.postMessage({ type: 'openDialog', pin: message.pin, currentMode, groups });
			return;
		}

		if (message.type === 'applyPin' && typeof message.pin === 'string' && typeof message.mode === 'string') {
			if (!activeIocUri) { return; }
			if (panelFixedPins.has(message.pin.toUpperCase())) {
				vscode.window.showWarningMessage(vscode.l10n.t('{0} is a board-fixed pin and cannot be changed.', message.pin));
				return;
			}
			const allowedGroups = await getPinModeGroupsForPin(panelDetectedMcu, message.pin, message.mode);
			const allowedModes = Object.values(allowedGroups).flat();
			if (!allowedModes.includes(message.mode)) {
				vscode.window.showErrorMessage(vscode.l10n.t('{0} cannot use mode {1}.', message.pin, message.mode));
				return;
			}
			const updated = await updateIocPinMode(activeIocUri, message.pin, message.mode);
			if (updated) {
				vscode.window.showInformationMessage(vscode.l10n.t('Updated {0} to {1}.', message.pin, message.mode));
				await render();
			}
			return;
		}

		if (message.type === 'addPin' && typeof message.pin === 'string' && typeof message.mode === 'string') {
			if (panelFixedPins.has(message.pin.toUpperCase())) {
				vscode.window.showWarningMessage(vscode.l10n.t('{0} is a board-fixed pin and cannot be added or changed.', message.pin));
				return;
			}
			if (!activeIocUri) {
				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (!wsFolder) {
					vscode.window.showWarningMessage(vscode.l10n.t('No workspace open.'));
					return;
				}
				const choice = await vscode.window.showInformationMessage(
					vscode.l10n.t('.ioc file not found. Create a new one?'),
					vscode.l10n.t('Create'), vscode.l10n.t('Cancel')
				);
				if (choice !== vscode.l10n.t('Create')) { return; }
				const newIocUri = vscode.Uri.joinPath(wsFolder.uri, 'project.ioc');
				const mcuPins = await loadMcuPackagePins();
				const cfgPins = mcuPins.filter(p => p.mode && p.mode !== 'Reset_State' && p.mode !== 'Analog' && !p.mode.startsWith('__'));
				const pEntries = cfgPins.map((p, i) => `Mcu.Pin${i}=${p.pin}`);
				const pSignals = cfgPins.map(p => `${p.pin}.Signal=${p.mode}`);
				const lines = [
					'#MicroXplorer Configuration settings - do not modify',
					'File.Version=6',
					'KeepUserPlacement=true',
					'LibraryCopySrc=1',
					'Mcu.CPN=STM32F446RETx',
					'Mcu.Family=STM32F4',
					'Mcu.Name=STM32F446RETx',
					'Mcu.IP0=GPIO',
					'Mcu.IP1=RCC',
					'Mcu.IP2=SYS',
					'Mcu.IPNb=3',
					'Mcu.ThirdPartyNb=0',
					...pEntries,
					`Mcu.PinsNb=${cfgPins.length}`,
					'Mcu.UserName=STM32F446RETx',
					'MxCube.Version=6.10.0',
					'MxDb.Version=DB.6.0.110',
					...pSignals,
					'ProjectManager.ProjectBaudRate=115200',
					'ProjectManager.ProjectFileName=project.ioc',
					'ProjectManager.ProjectName=project',
					'ProjectManager.ToolChain=Makefile',
					'ProjectManager.NoMain=false',
					'ProjectManager.ComputerToolchain=0',
					'ProjectManager.LibraryCopySrc=1',
				];
				await writeTextFile(newIocUri, lines.join('\n') + '\n');
				activeIocUri = newIocUri;
			}
			const allowedGroups = await getPinModeGroupsForPin(panelDetectedMcu, message.pin, message.mode);
			const allowedModes = Object.values(allowedGroups).flat();
			if (!allowedModes.includes(message.mode)) {
				vscode.window.showErrorMessage(vscode.l10n.t('{0} does not support mode {1}.', message.pin, message.mode));
				return;
			}
			await updateIocPinMode(activeIocUri, message.pin, message.mode);
			vscode.window.showInformationMessage(vscode.l10n.t('Added {0} as {1}.', message.pin, message.mode));
			await render();
			return;
		}

		if (message.type === 'requestPinModes' && typeof message.pin === 'string') {
			const groups = await getPinModeGroupsForPin(panelDetectedMcu, message.pin.toUpperCase(), '');
			await panel.webview.postMessage({ type: 'setAddPinModes', pin: message.pin.toUpperCase(), groups });
			return;
		}

		// Apply a single key=value line to the .ioc file
		if (message.type === 'applyIocLine' && typeof message.key === 'string' && typeof message.value === 'string') {
			if (!activeIocUri) {
				vscode.window.showWarningMessage(vscode.l10n.t('.ioc file is not open.'));
				return;
			}
			await updateIocKeyValue(activeIocUri, message.key, message.value);
			await render();
			return;
		}

		// Apply multiple key=value lines at once (batch settings save)
		if (message.type === 'applyIocLines' && Array.isArray(message.lines)) {
			if (!activeIocUri) {
				vscode.window.showWarningMessage(vscode.l10n.t('.ioc file is not open.'));
				return;
			}
			const validLines = (message.lines as unknown[]).filter(
				(l): l is { key: string; value: string } =>
					typeof (l as Record<string, unknown>).key === 'string' && typeof (l as Record<string, unknown>).value === 'string'
			);
			for (const { key, value } of validLines) {
				await updateIocKeyValue(activeIocUri, key, value);
			}
			vscode.window.showInformationMessage(vscode.l10n.t('Saved {0} setting(s).', validLines.length));
			await render();
			return;
		}

		// Remove a key from the .ioc file
		if (message.type === 'removeIocKey' && typeof message.key === 'string') {
			if (!activeIocUri) { return; }
			await removeIocKey(activeIocUri, message.key);
			await render();
			return;
		}
	});

	await render();
}


async function createProjectFromBoardConfigurator(profile: BoardProfile, config: BoardConfiguratorPayload): Promise<void> {
	const folderPick = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: vscode.l10n.t('Select destination folder')
	});
	if (!folderPick || folderPick.length === 0) {
		return;
	}

	const projectName = sanitizeProjectName(config.projectName);
	const projectUri = vscode.Uri.joinPath(folderPick[0], projectName);
	const allowOverwrite = await confirmCreateProject(projectUri);
	if (!allowOverwrite) {
		return;
	}

	await vscode.workspace.fs.createDirectory(projectUri);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectUri, 'Core'));
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectUri, 'Core', 'Inc'));
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectUri, 'Core', 'Src'));
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectUri, '.vscode'));

	const mcuPins = await loadMcuPackagePins(profile.mcu);
	const mergedPins = mergePins(mcuPins, profile.defaultPins);
	const projectMcu = profile.mcu;
	const projectPins = mergedPins;

	const iocText = generateIocTextFromBoardConfig(projectName, projectMcu, projectPins, config);
	const mainText = generateMainSource(projectMcu);
	const headerText = generateMainHeader();
	const readmeText = generateReadme(projectName, profile.name, projectMcu, projectPins);
	const extJson = '{\n  "recommendations": [\n    "ms-vscode.cpptools"\n  ]\n}\n';
	const tasksJson = generateTasksJson();
	const launchJson = generateLaunchJson(projectName);
	const cPropertiesJson = generateCProperties(projectMcu);

	await writeTextFile(vscode.Uri.joinPath(projectUri, `${projectName}.ioc`), iocText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Src', 'main.c'), mainText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Inc', 'main.h'), headerText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'README.md'), readmeText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'extensions.json'), extJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'tasks.json'), tasksJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'launch.json'), launchJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'c_cpp_properties.json'), cPropertiesJson);

	const openAction = await vscode.window.showInformationMessage(
		vscode.l10n.t('Project generated from Board Config Studio: {0}', projectName),
		vscode.l10n.t('Open Folder'),
		vscode.l10n.t('Open Pin Config')
	);
	if (openAction === vscode.l10n.t('Open Folder')) {
		await vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
		return;
	}

	if (config.openPinGui || openAction === vscode.l10n.t('Open Pin Config')) {
		await vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: projectUri });
		await vscode.commands.executeCommand('stm32ux.openPinVisualizer');
	}
}

function mergePins(basePins: Array<{ pin: string; mode: string }>, preferredPins: Array<{ pin: string; mode: string }>): Array<{ pin: string; mode: string }> {
	const map = new Map<string, string>();
	for (const item of basePins) {
		map.set(item.pin, item.mode);
	}
	for (const item of preferredPins) {
		map.set(item.pin, item.mode);
	}
	return Array.from(map.entries()).map(([pin, mode]) => ({ pin, mode }));
}

function generateIocTextFromBoardConfig(projectName: string, mcuName: string, pinModes: Array<{ pin: string; mode: string }>, _config: BoardConfiguratorPayload): string {
	// Infer MCU family from name (e.g. STM32F303K8 → STM32F3)
	const familyMatch = mcuName.match(/^(STM32[A-Z]\d)/i);
	const mcuFamily = familyMatch ? familyMatch[1] : 'STM32F3';

	// Separate configured pins from default/reset-state pins
	const configuredPins = pinModes.filter(p =>
		p.mode && p.mode !== 'Reset_State' && p.mode !== 'Analog' && !p.mode.startsWith('__')
	);

	// Build Mcu.Pin entries (only for actively configured pins)
	const pinEntries = configuredPins.map((p, i) => `Mcu.Pin${i}=${p.pin}`);

	// Build pin signal/mode lines in CubeMX format: PA5.Signal=GPIO_Output
	const pinSignalLines: string[] = [];
	const pinGpioLabelLines: string[] = [];
	for (const p of configuredPins) {
		pinSignalLines.push(`${p.pin}.Signal=${p.mode}`);
		if (p.mode === 'GPIO_Output' || p.mode === 'GPIO_Input') {
			pinGpioLabelLines.push(`${p.pin}.GPIO_Label=`);
		}
	}

	// Collect IPs from configured pins
	const ipSet = new Set<string>(['GPIO', 'RCC', 'SYS']);
	for (const p of configuredPins) {
		if (p.mode.startsWith('USART')) { ipSet.add(p.mode.split('_')[0]); }
		if (p.mode.startsWith('SPI')) { ipSet.add(p.mode.split('_')[0]); }
		if (p.mode.startsWith('I2C')) { ipSet.add(p.mode.split('_')[0]); }
		if (p.mode.startsWith('TIM')) { ipSet.add(p.mode.split('_')[0]); }
		if (p.mode.startsWith('ADC')) { ipSet.add(p.mode.split('_')[0]); }
		if (p.mode.startsWith('DAC')) { ipSet.add(p.mode.split('_')[0]); }
	}
	const ipList = Array.from(ipSet).sort();
	const ipLines = ipList.map((ip, i) => `Mcu.IP${i}=${ip}`);

	const lines = [
		'#MicroXplorer Configuration settings - do not modify',
		'File.Version=6',
		'KeepUserPlacement=true',
		'LibraryCopySrc=1',
		`Mcu.CPN=${mcuName}`,
		`Mcu.Family=${mcuFamily}`,
		`Mcu.Name=${mcuName}`,
		...ipLines,
		`Mcu.IPNb=${ipList.length}`,
		'Mcu.ThirdPartyNb=0',
		...pinEntries,
		`Mcu.PinsNb=${configuredPins.length}`,
		`Mcu.UserName=${mcuName}`,
		'MxCube.Version=6.10.0',
		'MxDb.Version=DB.6.0.110',
		...pinSignalLines,
		...pinGpioLabelLines,
		`ProjectManager.ProjectBaudRate=115200`,
		`ProjectManager.ProjectFileName=${projectName}.ioc`,
		`ProjectManager.ProjectName=${projectName}`,
		'ProjectManager.ToolChain=Makefile',
		'ProjectManager.NoMain=false',
		'ProjectManager.ComputerToolchain=0',
		'ProjectManager.LibraryCopySrc=1',
		`ProjectManager.StackSize=1024`,
		`ProjectManager.HeapSize=1536`,
	];

	return `${lines.join('\n')}\n`;
}

async function confirmCreateProject(projectUri: vscode.Uri): Promise<boolean> {
	const exists = await directoryExists(projectUri);
	if (!exists) {
		return true;
	}
	const entries = await vscode.workspace.fs.readDirectory(projectUri);
	if (entries.length === 0) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Destination folder already has files. Overwrite and continue?'),
		{ modal: true },
		vscode.l10n.t('Continue')
	);
	return choice === vscode.l10n.t('Continue');
}

async function directoryExists(uri: vscode.Uri): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return stat.type === vscode.FileType.Directory;
	} catch {
		return false;
	}
}

function sanitizeProjectName(value: string): string {
	const replaced = value.replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
	return replaced.length > 0 ? replaced : 'stm32-project';
}


function generateMainHeader(): string {
	return [
		'/* Auto-generated minimal header */',
		'#ifndef __MAIN_H',
		'#define __MAIN_H',
		'',
		'#ifdef __cplusplus',
		'extern "C" {',
		'#endif',
		'',
		'void Error_Handler(void);',
		'',
		'#ifdef __cplusplus',
		'}',
		'#endif',
		'',
		'#endif /* __MAIN_H */',
		''
	].join('\n');
}

function generateMainSource(_mcuName: string): string {
	const userCode = [
		'/* Generated by TovaIDE-STM Board Config Studio */',
		'HAL_Delay(100);'
	].map(line => `  ${line}`).join('\n');
	return [
		'/* Auto-generated minimal source */',
		'#include "main.h"',
		'',
		'int main(void)',
		'{',
		'  while (1) {',
		userCode,
		'  }',
		'}',
		'',
		'void Error_Handler(void)',
		'{',
		'  while (1) {',
		'  }',
		'}',
		''
	].join('\n');
}

function generateReadme(projectName: string, boardName: string, mcuName: string, pinModes: Array<{ pin: string; mode: string }>): string {
	const pinRows = pinModes.map(pin => `- ${pin.pin}: ${pin.mode}`).join('\n');
	return [
		`# ${projectName}`,
		'',
		`Board: ${boardName}`,
		`MCU: ${mcuName}`,
		`Created by: TovaIDE-STM Board Config Studio`,
		`Category: Board Config Studio`,
		`MCU: ${mcuName}`,
		'',
		'## Pin Preset',
		pinRows,
		''
	].join('\n');
}

function generateTasksJson(): string {
	return JSON.stringify({
		version: '2.0.0',
		tasks: [
			{
				label: 'STM32: Debug Build',
				type: 'shell',
				command: 'make',
				args: ['-j8', 'all', '-C', './Debug'],
				group: { kind: 'build', isDefault: true },
				problemMatcher: ['$gcc'],
				presentation: { reveal: 'always', panel: 'shared' }
			},
			{
				label: 'STM32: Flash',
				type: 'shell',
				command: 'STM32_Programmer_CLI',
				args: ['-c', 'port=SWD', 'freq=4000', '-w', './Debug/*.elf', '0x08000000', '-v'],
				group: 'build',
				problemMatcher: [],
				presentation: { reveal: 'always', panel: 'shared' }
			},
			{
				label: 'STM32: Clean',
				type: 'shell',
				command: 'make',
				args: ['clean', '-C', './Debug'],
				group: 'build',
				problemMatcher: [],
				presentation: { reveal: 'silent' }
			}
		]
	}, null, 2) + '\n';
}

function generateLaunchJson(projectName: string): string {
	return JSON.stringify({
		version: '0.2.0',
		configurations: [
			{
				name: 'STM32 Debug (ST-LINK)',
				type: 'cppdbg',
				request: 'launch',
				program: `\${workspaceFolder}/Debug/${projectName}.elf`,
				cwd: '${workspaceFolder}',
				MIMode: 'gdb',
				miDebuggerPath: 'arm-none-eabi-gdb',
				miDebuggerServerAddress: 'localhost:61234',
				stopAtEntry: true,
				externalConsole: false,
				preLaunchTask: 'STM32: Debug Build'
			}
		]
	}, null, 2) + '\n';
}

interface McuFamilyProfile {
	halFolder: string;
	cmsisDev: string;
	partDefine: string;
}

function getMcuFamilyProfile(mcuName: string): McuFamilyProfile {
	const upper = mcuName.toUpperCase();
	if (upper.startsWith('STM32H7')) {
		return { halFolder: 'STM32H7xx_HAL_Driver', cmsisDev: 'STM32H7xx', partDefine: 'STM32H743xx' };
	}
	if (upper.startsWith('STM32L4')) {
		return { halFolder: 'STM32L4xx_HAL_Driver', cmsisDev: 'STM32L4xx', partDefine: 'STM32L476xx' };
	}
	if (upper.startsWith('STM32WB')) {
		return { halFolder: 'STM32WBxx_HAL_Driver', cmsisDev: 'STM32WBxx', partDefine: 'STM32WB55xx' };
	}
	if (upper.startsWith('STM32F1')) {
		return { halFolder: 'STM32F1xx_HAL_Driver', cmsisDev: 'STM32F1xx', partDefine: 'STM32F103xB' };
	}
	if (upper.startsWith('STM32G0')) {
		return { halFolder: 'STM32G0xx_HAL_Driver', cmsisDev: 'STM32G0xx', partDefine: 'STM32G071xx' };
	}
	if (upper.startsWith('STM32U5')) {
		return { halFolder: 'STM32U5xx_HAL_Driver', cmsisDev: 'STM32U5xx', partDefine: 'STM32U575xx' };
	}
	if (upper.startsWith('STM32C0')) {
		return { halFolder: 'STM32C0xx_HAL_Driver', cmsisDev: 'STM32C0xx', partDefine: 'STM32C031xx' };
	}
	return { halFolder: 'STM32F4xx_HAL_Driver', cmsisDev: 'STM32F4xx', partDefine: 'STM32F446xx' };
}

function generateCProperties(mcuName: string): string {
	const { halFolder, cmsisDev, partDefine } = getMcuFamilyProfile(mcuName);
	return JSON.stringify({
		configurations: [
			{
				name: 'STM32',
				includePath: [
					'${workspaceFolder}/**',
					'${workspaceFolder}/Core/Inc',
					`\${workspaceFolder}/Drivers/${halFolder}/Inc`,
					`\${workspaceFolder}/Drivers/CMSIS/Device/ST/${cmsisDev}/Include`,
					'${workspaceFolder}/Drivers/CMSIS/Include'
				],
				defines: [
					'USE_HAL_DRIVER',
					partDefine
				],
				compilerPath: 'arm-none-eabi-gcc',
				cStandard: 'c11',
				cppStandard: 'c++17',
				intelliSenseMode: 'gcc-arm',
				browse: {
					path: ['${workspaceFolder}/**'],
					limitSymbolsToIncludedHeaders: true
				}
			}
		],
		version: 4
	}, null, 2) + '\n';
}

async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function updateIocPinMode(iocUri: vscode.Uri, pin: string, mode: string): Promise<boolean> {
	// Write in CubeMX format: PA5.Signal=GPIO_Output
	const signalKey = `${pin}.Signal`;
	const updated = await updateIocKeyValue(iocUri, signalKey, mode);
	// Also remove legacy direct format (PA5=mode) if present
	await removeIocKey(iocUri, pin);
	return updated;
}

async function updateIocKeyValue(iocUri: vscode.Uri, key: string, value: string): Promise<boolean> {
	const oldText = await readTextFile(iocUri);

	// Escape special regex chars in key
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const linePattern = new RegExp(`^${escapedKey}=[^\\r\\n]*$`, 'm');
	const newLine = `${key}=${value}`;
	let newText = oldText;
	if (linePattern.test(oldText)) {
		newText = oldText.replace(linePattern, newLine);
	} else {
		const suffix = oldText.endsWith('\n') ? '' : '\n';
		newText = `${oldText}${suffix}${newLine}\n`;
	}

	if (newText === oldText) { return false; }
	await writeTextFile(iocUri, newText);
	return true;
}

async function removeIocKey(iocUri: vscode.Uri, key: string): Promise<void> {
	const oldText = await readTextFile(iocUri);
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const newText = oldText.replace(new RegExp(`^${escapedKey}=[^\\r\\n]*\\r?\\n?`, 'm'), '');
	if (newText !== oldText) { await writeTextFile(iocUri, newText); }
}

async function findIocFile(): Promise<vscode.Uri | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (active && active.fileName.toLowerCase().endsWith('.ioc')) {
		return active.uri;
	}
	const files = await vscode.workspace.findFiles('**/*.ioc', '**/node_modules/**', 1);
	return files[0];
}

function parsePinLines(text: string): Array<{ pin: string; mode: string }> {
	const byPin = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const signal = line.match(/^((P[A-K][0-9]{1,2})(?:[-_][^.=]+)?)\.Signal=([^\r\n]+)/);
		if (signal) {
			byPin.set(signal[2], signal[3].trim());
			continue;
		}

		const direct = line.match(/^(P[A-K][0-9]{1,2})=([^\r\n]+)/);
		if (direct) {
			const mode = direct[2].trim();
			if (mode.length > 0 && !mode.includes('.')) {
				byPin.set(direct[1], mode);
			}
		}
	}

	return Array.from(byPin.entries()).map(([pin, mode]) => ({ pin, mode }));
}

function parseIocPackageName(text: string): string | undefined {
	const match = text.match(/^Mcu\.Package\s*=\s*([^\r\n]+)/m);
	if (!match) {
		return undefined;
	}
	const pkg = match[1].trim();
	return pkg.length > 0 ? pkg : undefined;
}

function mergeConfiguredPins(
	preferredPins: Array<{ pin: string; mode: string }>,
	fallbackPins: Array<{ pin: string; mode: string }>
): Array<{ pin: string; mode: string }> {
	const merged = new Map<string, string>();
	for (const pin of fallbackPins) {
		merged.set(pin.pin.toUpperCase(), pin.mode);
	}
	for (const pin of preferredPins) {
		merged.set(pin.pin.toUpperCase(), pin.mode);
	}
	return Array.from(merged.entries()).map(([pin, mode]) => ({ pin, mode }));
}

async function loadGeneratedCodePinAssignments(): Promise<Array<{ pin: string; mode: string }>> {
	const gpioUri = await findFirstWorkspaceFile('**/Core/Src/gpio.c');
	if (!gpioUri) {
		return [];
	}

	let gpioText = '';
	let mainHeaderText = '';
	try {
		gpioText = await readTextFile(gpioUri);
	} catch {
		return [];
	}

	const headerUri = await findFirstWorkspaceFile('**/Core/Inc/main.h');
	if (headerUri) {
		try {
			mainHeaderText = await readTextFile(headerUri);
		} catch {
			mainHeaderText = '';
		}
	}

	return parseGeneratedPinLines(gpioText, mainHeaderText);
}

async function inferMcuFromGeneratedCode(): Promise<string | undefined> {
	const headerUri = await findFirstWorkspaceFile('**/Core/Inc/main.h');
	if (!headerUri) {
		return undefined;
	}

	let text = '';
	try {
		text = await readTextFile(headerUri);
	} catch {
		return undefined;
	}

	const match = text.match(/^#define\s+(STM32[A-Z0-9]+)xx\b/im);
	if (!match) {
		return undefined;
	}

	return match[1].toUpperCase();
}

async function findFirstWorkspaceFile(glob: string): Promise<vscode.Uri | undefined> {
	const files = await vscode.workspace.findFiles(glob, '**/node_modules/**', 1);
	return files[0];
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(bytes).toString('utf8');
}

function parseGeneratedPinLines(gpioText: string, mainHeaderText: string): Array<{ pin: string; mode: string }> {
	const byPin = new Map<string, string>();
	const mainHeaderPinMap = parseMainHeaderPinMap(mainHeaderText);

	const pinRegex = /^\s*GPIO_InitStruct\.Pin\s*=\s*([^;]+);/;
	const modeRegex = /^\s*GPIO_InitStruct\.Mode\s*=\s*([^;]+);/;
	const initRegex = /^\s*HAL_GPIO_Init\s*\(\s*(GPIO[A-K])\s*,\s*&GPIO_InitStruct\s*\)\s*;/;

	let currentPinsExpr = '';
	let currentModeExpr = '';

	for (const rawLine of gpioText.split(/\r?\n/)) {
		const pinMatch = rawLine.match(pinRegex);
		if (pinMatch) {
			currentPinsExpr = pinMatch[1].trim();
			continue;
		}

		const modeMatch = rawLine.match(modeRegex);
		if (modeMatch) {
			currentModeExpr = modeMatch[1].trim();
			continue;
		}

		const initMatch = rawLine.match(initRegex);
		if (!initMatch || !currentPinsExpr || !currentModeExpr) {
			continue;
		}

		const gpioPort = initMatch[1].toUpperCase();
		const mode = normalizeGeneratedGpioMode(currentModeExpr);
		for (const token of currentPinsExpr.split('|')) {
			const part = token.trim();
			if (!part) {
				continue;
			}

			const resolved = resolveGeneratedPinToken(part, gpioPort, mainHeaderPinMap);
			if (resolved) {
				byPin.set(resolved, mode);
			}
		}

		currentPinsExpr = '';
		currentModeExpr = '';
	}

	return Array.from(byPin.entries()).map(([pin, mode]) => ({ pin, mode }));
}

function parseMainHeaderPinMap(mainHeaderText: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!mainHeaderText) {
		return result;
	}

	const pinNumberByLabel = new Map<string, number>();
	const portByLabel = new Map<string, string>();

	for (const rawLine of mainHeaderText.split(/\r?\n/)) {
		const line = rawLine.trim();
		const pinMatch = line.match(/^#define\s+(\w+_Pin)\s+GPIO_PIN_(\d{1,2})\b/);
		if (pinMatch) {
			pinNumberByLabel.set(pinMatch[1], parseInt(pinMatch[2], 10));
			continue;
		}

		const portMatch = line.match(/^#define\s+(\w+)_GPIO_Port\s+(GPIO[A-K])\b/);
		if (portMatch) {
			portByLabel.set(`${portMatch[1]}_Pin`, portMatch[2].toUpperCase());
		}
	}

	for (const [label, pinNumber] of pinNumberByLabel.entries()) {
		const port = portByLabel.get(label);
		if (!port) {
			continue;
		}
		const bank = port.replace('GPIO', '');
		result.set(label, `P${bank}${pinNumber}`);
	}

	return result;
}

function resolveGeneratedPinToken(token: string, gpioPort: string, headerMap: Map<string, string>): string | undefined {
	const mapped = headerMap.get(token);
	if (mapped) {
		return mapped;
	}

	const directPin = token.match(/^GPIO_PIN_(\d{1,2})$/);
	if (!directPin) {
		return undefined;
	}

	const bank = gpioPort.replace('GPIO', '');
	const pinNumber = parseInt(directPin[1], 10);
	return `P${bank}${pinNumber}`;
}

function normalizeGeneratedGpioMode(rawMode: string): string {
	const mode = rawMode.trim().toUpperCase();
	if (mode.includes('ANALOG')) {
		return 'GPIO_Analog';
	}
	if (mode.includes('OUTPUT') || mode.includes('_OUT_')) {
		return 'GPIO_Output';
	}
	if (mode.includes('AF')) {
		return 'GPIO_AF';
	}
	if (mode.includes('IT_')) {
		return 'GPIO_EXTI';
	}
	if (mode.includes('EVENT')) {
		return 'GPIO_Event';
	}
	return 'GPIO_Input';
}

/** Estimate total pin count from .ioc text or MCU name */
function getPackagePinCount(iocText: string, mcuName: string): number {
	const pkgMatch = iocText.match(/Mcu\.Package\s*=\s*(\w+)/);
	const pkg = (pkgMatch?.[1] ?? '').toUpperCase();
	const pkgNum = pkg.match(/(\d{2,3})/);
	if (pkgNum) { return parseInt(pkgNum[1], 10); }
	// Strip CubeMX parenthesized variants: STM32F303K(6-8)Tx → STM32F303K8Tx (use last char in group)
	const stripped = (mcuName ?? '').replace(/\(([A-Z0-9](?:-[A-Z0-9])*)\)/gi, (_m, chars: string) => {
		const parts = chars.split('-');
		return parts[parts.length - 1];
	}).toUpperCase();
	const tail = stripped.slice(-4);
	if (/ZI|ZG|ZE/.test(tail)) { return 144; }
	if (/VI|VG|VE/.test(tail)) { return 100; }
	if (/RE|RG|RB/.test(tail)) { return 64; }
	if (/CB|CC|CE/.test(tail)) { return 48; }
	if (/K[A-Z0-9]T|KB|KC|K6|K8/.test(tail)) { return 32; }
	return 64;
}

/** Build full package pin list and merge with .ioc configured pins */
function buildFullPackagePins(
	configured: Array<{ pin: string; mode: string }>,
	totalPins: number,
): Array<{ pin: string; mode: string }> {
	const configMap = new Map(configured.map(p => [p.pin.toUpperCase(), p.mode]));

	const bankSizes: Array<[string, number, number]> =
		totalPins >= 144 ? [['A', 16, 0], ['B', 16, 0], ['C', 16, 0], ['D', 16, 0], ['E', 16, 0], ['F', 16, 0], ['G', 16, 0], ['H', 2, 0]]
			: totalPins >= 100 ? [['A', 16, 0], ['B', 16, 0], ['C', 16, 0], ['D', 16, 0], ['E', 16, 0]]
				: totalPins >= 64 ? [['A', 16, 0], ['B', 16, 0], ['C', 16, 0], ['D', 3, 0], ['H', 2, 0]]
					: totalPins >= 48 ? [['A', 16, 0], ['B', 16, 0], ['C', 4, 13]] // PC13-16
						: [['A', 10, 0], ['B', 16, 0], ['C', 3, 13]];

	const all: Array<{ pin: string; mode: string }> = [];
	for (const [bank, count, start] of bankSizes) {
		for (let i = 0; i < count; i++) {
			const pinName = `P${bank}${start + i}`;
			all.push({ pin: pinName, mode: configMap.get(pinName.toUpperCase()) ?? 'Unused' });
		}
	}

	for (const item of configured) {
		const key = item.pin.toUpperCase();
		const found = all.findIndex(p => p.pin.toUpperCase() === key);
		if (found >= 0) {
			all[found].mode = item.mode;
			continue;
		}
		const placeholder = all.findIndex(p => /^PIN\d+$/i.test(p.pin));
		if (placeholder >= 0) {
			all[placeholder] = { pin: item.pin, mode: item.mode };
		} else {
			all.push({ pin: item.pin, mode: item.mode });
		}
	}

	while (all.length < totalPins) {
		all.push({ pin: `PIN${all.length + 1}`, mode: 'Unused' });
	}

	if (all.length > totalPins) {
		return all.slice(0, totalPins);
	}

	return all;
}

function getErrorHint(message: string): string {
	const normalized = message.toLowerCase();
	if (normalized.includes('undeclared')) {
		return 'Undeclared symbol. Enable the target peripheral in the .ioc config or check for typos in the variable name.';
	}
	if (normalized.includes('no such file')) {
		return 'Header or source include path mismatch. After migrating from CubeIDE check includePath and the generated code location.';
	}
	if (normalized.includes('undefined reference')) {
		return 'Linker error. A source file may be missing, function signature may not match, or a library is not linked.';
	}
	return 'Review the error, compare the affected line with your last change. Run /fix in STM32 AI if needed.';
}

interface InferredToolPaths {
	programmerCliPath?: string;
	gccPath?: string;
}

async function inferToolPathsFromMetadataPath(metadataPath: string): Promise<InferredToolPaths> {
	const separator = metadataPath.includes('\\') ? '\\' : '/';
	const root = metadataPath.replace(/[\\/][^\\/]+$/, '');
	if (root.length === 0) {
		return {};
	}

	const joinPath = (...parts: string[]) => parts.join(separator);
	const programmerCandidates = process.platform === 'win32'
		? [
			joinPath(root, 'STM32CubeProgrammer', 'bin', 'STM32_Programmer_CLI.exe'),
			joinPath(root, 'bin', 'STM32_Programmer_CLI.exe')
		]
		: [
			joinPath(root, 'STM32CubeProgrammer', 'bin', 'STM32_Programmer_CLI'),
			joinPath(root, 'bin', 'STM32_Programmer_CLI')
		];

	const gccCandidates = process.platform === 'win32'
		? [
			joinPath(root, 'GNU-tools-for-STM32', 'bin', 'arm-none-eabi-gcc.exe'),
			joinPath(root, 'bin', 'arm-none-eabi-gcc.exe')
		]
		: [
			joinPath(root, 'GNU-tools-for-STM32', 'bin', 'arm-none-eabi-gcc'),
			joinPath(root, 'bin', 'arm-none-eabi-gcc')
		];

	return {
		programmerCliPath: await firstExistingPath(programmerCandidates),
		gccPath: await firstExistingPath(gccCandidates),
	};
}

async function firstExistingPath(candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		const exists = await fileExists(candidate);
		if (exists) {
			return candidate;
		}
	}
	return undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
		return true;
	} catch {
		return false;
	}
}

async function resolveCommandPath(command: string, cwd: string | undefined): Promise<string | undefined> {
	const locator = process.platform === 'win32' ? 'where' : 'which';
	try {
		const result = await execFileAsync(locator, [command], cwd);
		const first = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
		return first;
	} catch {
		return undefined;
	}
}

function execFileAsync(command: string, args: string[], cwd: string | undefined): Promise<ExecFileResult> {
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

function getUxI18n() {
	return {
		// Common
		cancel: vscode.l10n.t('Cancel'),
		save: vscode.l10n.t('Save'),
		open: vscode.l10n.t('Open'),
		close: vscode.l10n.t('Close'),
		start: vscode.l10n.t('Start'),
		apply: vscode.l10n.t('Apply'),
		add: vscode.l10n.t('Add'),
		del: vscode.l10n.t('Delete'),
		none: vscode.l10n.t('None'),
		unused: vscode.l10n.t('Unused'),
		// Onboarding / Dashboard
		dashboardTitle: vscode.l10n.t('TovaIDE-STM Dashboard'),
		dashboardSub: vscode.l10n.t('Start here to create, configure, build, flash, and control via MCP.'),
		boardStudio: vscode.l10n.t('Board Config Studio'),
		boardStudioMeta: vscode.l10n.t('Initial setup without CubeMX'),
		cubemxSync: vscode.l10n.t('CubeMX Catalog Sync'),
		cubemxSyncMeta: vscode.l10n.t('Import 5000+ MCUs'),
		pinVisualizer: vscode.l10n.t('Pin Visualizer'),
		pinVisualizerMeta: vscode.l10n.t('Chip diagram and pin editor'),
		svdRefresh: vscode.l10n.t('Refresh SVD Register View'),
		svdRefreshMeta: vscode.l10n.t('Show with fallback'),
		buildDebug: vscode.l10n.t('Debug Build'),
		buildDebugMeta: vscode.l10n.t('Jump to error location'),
		flash: vscode.l10n.t('Flash'),
		flashMeta: vscode.l10n.t('STM32_Programmer_CLI'),
		debugStart: vscode.l10n.t('Start Debug'),
		debugStartMeta: vscode.l10n.t('ST-LINK GDB Server'),
		mcpDesk: vscode.l10n.t('MCP Operation Desk'),
		mcpDeskMeta: vscode.l10n.t('All operations as RPC'),
		// MCP Desk
		mcpDeskTitle: vscode.l10n.t('STM32 MCP Operation Desk'),
		mcpDeskSub: vscode.l10n.t('Operations here are also callable as MCP JSON-RPC.'),
		mcpStatusChecking: vscode.l10n.t('Checking MCP status...'),
		// Welcome
		welcomeTitle: vscode.l10n.t('TovaIDE-STM Welcome'),
		welcomeSub: vscode.l10n.t('Quick access to common operations. Select an item to start.'),
		importCubeIDE: vscode.l10n.t('Import from CubeIDE'),
		importCubeIDEDesc: vscode.l10n.t('Import an existing STM32CubeIDE project.'),
		boardConfig: vscode.l10n.t('Board Configuration'),
		boardConfigDesc: vscode.l10n.t('Select a board, configure clock and debug settings, then create a project.'),
		envCheck: vscode.l10n.t('Environment Check'),
		envSettings: vscode.l10n.t('Environment Settings'),
		autoErrorExplain: vscode.l10n.t('Auto Error Explanation'),
		// Pin Visualizer
		pinVisualizerTitle: vscode.l10n.t('STM32 Pin Visualizer'),
		noIocFile: vscode.l10n.t('No .ioc file — using MCU package JSON fallback.'),
		filterPlaceholder: vscode.l10n.t('Filter by pin name / mode / label...'),
		filterAriaLabel: vscode.l10n.t('Filter pins'),
		viewToggleAriaLabel: vscode.l10n.t('Toggle view'),
		listView: vscode.l10n.t('List'),
		chipView: vscode.l10n.t('Chip Diagram'),
		addPin: vscode.l10n.t('+ Add Pin'),
		pinCount: vscode.l10n.t('{0} pins'),
		pinCountFiltered: vscode.l10n.t('{0} pins (filtered)'),
		pinClickHint: vscode.l10n.t('Click a pin to change its mode and sync to .ioc.'),
		colorLegend: vscode.l10n.t('Color Legend'),
		noIocOrPins: vscode.l10n.t('.ioc file not found or pin data could not be parsed.'),
		zoomIn: vscode.l10n.t('Zoom In (+)'),
		zoomOut: vscode.l10n.t('Zoom Out (-)'),
		reset: vscode.l10n.t('Reset'),
		noPins: vscode.l10n.t('No pins'),
		// Pin Visualizer — Settings tabs
		tabPins: vscode.l10n.t('📌 Pins'),
		tabGpio: vscode.l10n.t('⚡ GPIO'),
		tabNvic: vscode.l10n.t('🔔 NVIC'),
		tabDma: vscode.l10n.t('↔ DMA'),
		tabParam: vscode.l10n.t('⚙ Parameters'),
		tabConst: vscode.l10n.t('🔑 User Constants'),
		// GPIO panel
		gpioDetailTitle: vscode.l10n.t('GPIO Detail Settings'),
		gpioPin: vscode.l10n.t('Pin'),
		gpioMode: vscode.l10n.t('Assigned Mode'),
		gpioUserLabel: vscode.l10n.t('User Label'),
		gpioLabelPlaceholder: vscode.l10n.t('Label'),
		gpioEmpty: vscode.l10n.t('No configurable GPIO pins. Assign pins in the Pins tab first.'),
		// NVIC panel
		nvicTitle: vscode.l10n.t('NVIC Interrupt Settings'),
		nvicIrq: vscode.l10n.t('Interrupt Name (IRQ)'),
		nvicEnabled: vscode.l10n.t('Enabled'),
		nvicEmpty: vscode.l10n.t('No NVIC settings in .ioc. Enable peripherals in CubeMX then sync.'),
		// DMA panel
		dmaTitle: vscode.l10n.t('DMA Settings'),
		dmaKey: vscode.l10n.t('Key'),
		dmaValue: vscode.l10n.t('Value'),
		dmaEmpty: vscode.l10n.t('No DMA settings.'),
		// Param panel
		paramTitle: vscode.l10n.t('Parameter Settings'),
		paramEmpty: vscode.l10n.t('No parameter settings.'),
		// Const panel
		constTitle: vscode.l10n.t('User Constants (ProjectManager.UserConstants)'),
		constName: vscode.l10n.t('Name'),
		constValue: vscode.l10n.t('Value'),
		constNamePlaceholder: vscode.l10n.t('Constant name'),
		constValuePlaceholder: vscode.l10n.t('Value'),
		addConst: vscode.l10n.t('+ Add Constant'),
		confirmDeleteKey: vscode.l10n.t('Delete key "{0}"?'),
		// Add/Edit pin dialogs
		addPinTitle: vscode.l10n.t('Add Pin'),
		addPinLabel: vscode.l10n.t('Pin name (PA0 — PK15)'),
		addPinPlaceholder: vscode.l10n.t('e.g. PA5'),
		modeLabel: vscode.l10n.t('Mode'),
		enterPinFirst: vscode.l10n.t('Enter a pin first'),
		noModesAvailable: vscode.l10n.t('No modes available'),
		validPinRequired: vscode.l10n.t('Enter a valid pin'),
		pinFormatError: vscode.l10n.t('Format error: use PA0–PK15'),
		enterValidPin: vscode.l10n.t('Enter a valid pin name.'),
		selectModeForPin: vscode.l10n.t('Select an available mode for this pin.'),
		editPinTitle: vscode.l10n.t('Edit Pin'),
		editPinTitleWith: vscode.l10n.t('Edit Pin — {0}'),
		currentMode: vscode.l10n.t('Current mode: {0}'),
		currentModeNone: vscode.l10n.t('Current mode: —'),
		modeSearch: vscode.l10n.t('Search modes...'),
		modeSearchAriaLabel: vscode.l10n.t('Search modes'),
		// MCP desk extra
		mcpStartServer: vscode.l10n.t('Start MCP Server'),
		mcpStartSseServer: vscode.l10n.t('Start SSE MCP Server'),
		mcpStopServer: vscode.l10n.t('Stop MCP Server'),
		mcpExportConfig: vscode.l10n.t('Export MCP Config JSON'),
		mcpComposeRpc: vscode.l10n.t('Compose Custom RPC JSON'),
		regenerateCode: vscode.l10n.t('Regenerate Code'),
		// import
		import: vscode.l10n.t('Import'),
		openAction: vscode.l10n.t('Open'),
		syncCatalogAction: vscode.l10n.t('Sync Catalog'),
		// Board Configurator
		boardStudioTitle: vscode.l10n.t('TovaIDE-STM Board Config Studio'),
		boardStudioSub: vscode.l10n.t('This screen is for project creation only. Clock Tree / NVIC / DMA / GPIO are configured in .ioc after generation.'),
		boardStudioNotice: vscode.l10n.t('Run <b>CubeMX Catalog Sync</b> first to match CubeMX MCU counts.<br/>This screen loads Board DB and MCU DB separately.'),
		createMode: vscode.l10n.t('Creation Mode'),
		modeFromBoard: vscode.l10n.t('From Board'),
		modeFromMcu: vscode.l10n.t('From MCU/MPU Selector'),
		boardSearchLabel: vscode.l10n.t('Board Search (name / description / CPN)'),
		boardSearchPlaceholder: vscode.l10n.t('e.g. NUCLEO / DISCOVERY / STM32F446RE'),
		mcuSearchLabel: vscode.l10n.t('MCU/MPU Search (Commercial Part Number)'),
		mcuSearchPlaceholder: vscode.l10n.t('e.g. STM32F446RETX'),
		projectNameLabel: vscode.l10n.t('Project Name'),
		openPinGuiLabel: vscode.l10n.t('Open pin config GUI after creation'),
		createProject: vscode.l10n.t('Create Project'),
		noBoardMatch: vscode.l10n.t('No matching boards'),
		boardDbSuffix: vscode.l10n.t('(Board DB)'),
		mcuDbSuffix: vscode.l10n.t('(MCU DB)'),
		// MCP desk status
		mcpRunning: vscode.l10n.t('MCP running: {0}'),
		mcpStopped: vscode.l10n.t('MCP stopped: {0}'),
		mcpNoConnection: vscode.l10n.t('Not connected'),
	};
}

function getBoardConfiguratorHtml(webview: vscode.Webview, profiles: BoardProfile[], mcuNames: string[]): string {
	const csp = webview.cspSource;
	const _i18nJson = JSON.stringify(getUxI18n());
	const lang = vscode.env.language.split('-')[0] ?? 'en';
	const boardOptions = profiles.map(profile =>
		`<option value="${escapeHtml(profile.id)}" data-mcu="${escapeHtml(profile.mcu)}" data-desc="${escapeHtml(profile.description)}">${escapeHtml(profile.name)} (${escapeHtml(profile.mcu)})</option>`
	).join('');
	const mcuOptions = mcuNames.map(mcu =>
		`<option value="${escapeHtml(mcu)}">${escapeHtml(mcu)}</option>`
	).join('');

	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:transparent;color:var(--tx);padding:22px 24px;max-width:960px}
		h1{font-size:20px;font-weight:700;margin-bottom:6px}
		.sub{font-size:12px;color:var(--mt);margin-bottom:16px}
		.notice{font-size:12px;color:#cbd5e1;background:#121826;border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin-bottom:14px}
		.mode-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
		.mode-chip{display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--bd);border-radius:999px;background:#10131a;font-size:12px;cursor:pointer}
		.mode-chip input{margin:0}
		.card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:14px}
		.row{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
		label{font-size:12px;color:#d1d5db}
		input,select{background:#0d0e14;border:1px solid var(--bd);border-radius:7px;color:var(--tx);padding:8px 10px;font:12px var(--vscode-font-family,'Segoe UI',sans-serif);outline:none}
		input:focus,select:focus{border-color:var(--ac)}
		.desc{font-size:11px;color:var(--mt);line-height:1.5}
		.mcu-tag{font-size:11px;color:#99f6e4;background:rgba(15,118,110,.18);border:1px solid rgba(15,118,110,.45);padding:2px 8px;border-radius:999px;display:inline-block;margin-top:6px}
		.hidden{display:none}
		.chk{display:flex;align-items:center;gap:8px;margin-top:8px}
		.btnrow{display:flex;justify-content:flex-end;margin-top:14px}
		button{background:var(--ac);border:1px solid var(--ac);color:#fff;border-radius:8px;padding:9px 16px;font:600 12px var(--vscode-font-family,'Segoe UI',sans-serif);cursor:pointer}
	</style>
</head>
<body>
	<h1 id="bcTitle"></h1>
	<p class="sub" id="bcSub"></p>
	<div class="notice" id="bcNotice"></div>

	<div class="mode-row" role="radiogroup" id="bcModeRow">
		<label class="mode-chip"><input type="radio" name="selectMode" value="board" checked /> <span id="modeBoard"></span></label>
		<label class="mode-chip"><input type="radio" name="selectMode" value="mcu" /> <span id="modeMcu"></span></label>
	</div>

	<div class="card">
		<div id="boardPanel">
			<div class="row">
				<label id="boardSearchLabel" for="boardSearch"></label>
				<input id="boardSearch" type="search" />
				<div class="desc" id="boardSearchMeta">${profiles.length} </div>
			</div>
			<div class="row">
				<label id="boardIdLabel" for="boardId"></label>
				<select id="boardId">${boardOptions}</select>
				<div class="mcu-tag" id="boardMcu"></div>
				<div class="desc" id="boardDesc">-</div>
			</div>
		</div>

		<div id="mcuPanel" class="hidden">
			<div class="row">
				<label id="mcuSearchLabel" for="mcuSearch"></label>
				<input id="mcuSearch" type="search" />
				<div class="desc" id="mcuSearchMeta">${mcuNames.length} </div>
			</div>
			<div class="row">
				<label id="mcuIdLabel" for="mcuId"></label>
				<select id="mcuId">${mcuOptions}</select>
				<div class="mcu-tag" id="mcuMetaTag"></div>
			</div>
		</div>

		<div class="row">
			<label id="projectNameLabel" for="projectName"></label>
			<input id="projectName" value="stm32-project" maxlength="64" />
		</div>
		<label class="chk"><input id="openPinGui" type="checkbox" checked /> <span id="openPinGuiLabel"></span></label>
	</div>

	<div class="btnrow">
		<button id="createBtn"></button>
	</div>

	<script>
		const _i18n = ${_i18nJson};
		const vscode = acquireVsCodeApi();
		// Apply i18n
		document.getElementById('bcTitle').textContent = _i18n.boardStudioTitle;
		document.getElementById('bcSub').textContent = _i18n.boardStudioSub;
		document.getElementById('bcNotice').innerHTML = _i18n.boardStudioNotice;
		document.getElementById('bcModeRow').setAttribute('aria-label', _i18n.createMode);
		document.getElementById('modeBoard').textContent = _i18n.modeFromBoard;
		document.getElementById('modeMcu').textContent = _i18n.modeFromMcu;
		document.getElementById('boardIdLabel').textContent = _i18n.modeFromBoard;
		document.getElementById('mcuIdLabel').textContent = _i18n.modeFromMcu;
		document.getElementById('boardSearchLabel').textContent = _i18n.boardSearchLabel;
		document.getElementById('boardSearch').placeholder = _i18n.boardSearchPlaceholder;
		document.getElementById('boardSearch').setAttribute('aria-label', _i18n.boardSearchLabel);
		document.getElementById('mcuSearchLabel').textContent = _i18n.mcuSearchLabel;
		document.getElementById('mcuSearch').placeholder = _i18n.mcuSearchPlaceholder;
		document.getElementById('mcuSearch').setAttribute('aria-label', _i18n.mcuSearchLabel);
		document.getElementById('projectNameLabel').textContent = _i18n.projectNameLabel;
		document.getElementById('openPinGuiLabel').textContent = _i18n.openPinGuiLabel;
		document.getElementById('createBtn').textContent = _i18n.createProject;
		document.getElementById('createBtn').setAttribute('aria-label', _i18n.createProject);
		// Append suffix to initial count displays
		const bsmEl = document.getElementById('boardSearchMeta');
		if (bsmEl) bsmEl.textContent = bsmEl.textContent.trim() + ' ' + _i18n.boardDbSuffix;
		const msmEl = document.getElementById('mcuSearchMeta');
		if (msmEl) msmEl.textContent = msmEl.textContent.trim() + ' ' + _i18n.mcuDbSuffix;
		const boardSearch = document.getElementById('boardSearch');
		const boardId = document.getElementById('boardId');
		const boardSearchMeta = document.getElementById('boardSearchMeta');
		const boardMcu = document.getElementById('boardMcu');
		const boardDesc = document.getElementById('boardDesc');
		const mcuSearch = document.getElementById('mcuSearch');
		const mcuId = document.getElementById('mcuId');
		const mcuSearchMeta = document.getElementById('mcuSearchMeta');
		const mcuMetaTag = document.getElementById('mcuMetaTag');
		const boardPanel = document.getElementById('boardPanel');
		const mcuPanel = document.getElementById('mcuPanel');
		const projectName = document.getElementById('projectName');

		const allBoards = Array.from(boardId.options).map(opt => ({
			value: opt.value,
			label: opt.textContent || '',
			mcu: opt.dataset.mcu || '',
			desc: opt.dataset.desc || ''
		}));
		const allMcu = Array.from(mcuId.options).map(opt => opt.value);

		function renderBoardOptions(query) {
			const q = (query || '').trim().toLowerCase();
			const prev = boardId.value;
			const filtered = allBoards.filter(item => !q || item.value.toLowerCase().includes(q) || item.label.toLowerCase().includes(q) || item.mcu.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q));
			boardId.innerHTML = '';
			for (const item of filtered) {
				const opt = document.createElement('option');
				opt.value = item.value;
				opt.textContent = item.label;
				opt.dataset.mcu = item.mcu;
				opt.dataset.desc = item.desc;
				boardId.appendChild(opt);
			}
			if (filtered.length === 0) {
				const empty = document.createElement('option');
				empty.value = '';
				empty.textContent = _i18n.noBoardMatch;
				empty.disabled = true;
				empty.selected = true;
				boardId.appendChild(empty);
				boardId.disabled = true;
			} else {
				boardId.disabled = false;
				if (filtered.some(item => item.value === prev)) {
					boardId.value = prev;
				}
			}
			boardSearchMeta.textContent = filtered.length + ' / ' + allBoards.length + ' ' + _i18n.boardDbSuffix;
			updateBoardMeta();
		}

		function updateBoardMeta() {
			if (boardId.disabled || boardId.selectedIndex < 0) {
				boardMcu.textContent = '';
				boardDesc.textContent = _i18n.noBoardMatch;
				return;
			}
			const opt = boardId.options[boardId.selectedIndex];
			boardMcu.textContent = opt.dataset.mcu || '';
			boardDesc.textContent = opt.dataset.desc || '';
		}

		function renderMcuOptions(query) {
			const q = (query || '').trim().toLowerCase();
			const prev = mcuId.value;
			const filtered = allMcu.filter(item => !q || item.toLowerCase().includes(q));
			mcuId.innerHTML = '';
			for (const item of filtered) {
				const opt = document.createElement('option');
				opt.value = item;
				opt.textContent = item;
				mcuId.appendChild(opt);
			}
			if (filtered.length > 0 && filtered.includes(prev)) {
				mcuId.value = prev;
			}
			mcuSearchMeta.textContent = filtered.length + ' / ' + allMcu.length + ' ' + _i18n.mcuDbSuffix;
			mcuMetaTag.textContent = mcuId.value || '';
		}

		boardSearch.addEventListener('input', () => renderBoardOptions(boardSearch.value));
		boardId.addEventListener('change', updateBoardMeta);
		mcuSearch.addEventListener('input', () => renderMcuOptions(mcuSearch.value));
		mcuId.addEventListener('change', () => { mcuMetaTag.textContent = mcuId.value || ''; });

		for (const mode of document.querySelectorAll('input[name="selectMode"]')) {
			mode.addEventListener('change', () => {
				const useMcu = document.querySelector('input[name="selectMode"]:checked').value === 'mcu';
				boardPanel.classList.toggle('hidden', useMcu);
				mcuPanel.classList.toggle('hidden', !useMcu);
				if (useMcu && (!projectName.value || projectName.value === 'stm32-project')) {
					projectName.value = (mcuId.value || 'stm32-project').replace(/[^a-zA-Z0-9_-]/g, '-');
				}
			});
		}

		renderBoardOptions('');
		renderMcuOptions('');

		document.getElementById('createBtn').addEventListener('click', () => {
			const selectionMode = document.querySelector('input[name="selectMode"]:checked').value;
			const payload = {
				selectionMode,
				boardId: boardId.value,
				mcuName: mcuId.value,
				projectName: projectName.value,
				openPinGui: document.getElementById('openPinGui').checked
			};
			vscode.postMessage({ type: 'create', payload });
		});
	</script>
</body>
</html>`;
}

function getOnboardingHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	const i18n = getUxI18n();
	const lang = vscode.env.language.split('-')[0] ?? 'en';
	// Inline strings directly — no runtime i18n lookup needed in webview
	const t = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{
			--bg:var(--vscode-sideBar-background,#111827);
			--bd:var(--vscode-panel-border,#1f2937);
			--tx:var(--vscode-editor-foreground,#f3f4f6);
			--mt:var(--vscode-descriptionForeground,#9ca3af);
			--ac:#0d9488;
			--ac-bg:rgba(13,148,136,.12);
			--ac-bd:rgba(13,148,136,.4);
			--card:var(--vscode-editor-background,#1a2332);
		}
		body{
			font:12px/1.55 var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);
			background:var(--bg);
			color:var(--tx);
			padding:0 0 16px;
		}
		.header{
			padding:14px 12px 10px;
			border-bottom:1px solid var(--bd);
			background:linear-gradient(135deg,rgba(13,148,136,.18) 0%,transparent 60%);
		}
		.header-title{
			font-size:13px;
			font-weight:700;
			letter-spacing:.01em;
			color:var(--tx);
			display:flex;
			align-items:center;
			gap:6px;
		}
		.header-title::before{
			content:'';
			display:inline-block;
			width:3px;height:14px;
			background:var(--ac);
			border-radius:2px;
		}
		.header-sub{
			font-size:10px;
			color:var(--mt);
			margin-top:4px;
			line-height:1.4;
		}
		.section{
			padding:10px 10px 4px;
		}
		.section-label{
			font-size:9.5px;
			font-weight:700;
			letter-spacing:.08em;
			text-transform:uppercase;
			color:var(--mt);
			padding:0 2px 6px;
			border-bottom:1px solid var(--bd);
			margin-bottom:6px;
		}
		.row{
			display:flex;
			align-items:center;
			gap:0;
			width:100%;
			padding:6px 8px;
			margin-bottom:3px;
			border:1px solid transparent;
			border-radius:6px;
			background:none;
			color:var(--tx);
			cursor:pointer;
			text-align:left;
			transition:background .1s,border-color .1s;
			font:inherit;
		}
		.row:hover{
			background:var(--ac-bg);
			border-color:var(--ac-bd);
		}
		.row:active{
			opacity:.8;
		}
		.row-icon{
			width:24px;
			height:24px;
			border-radius:5px;
			background:var(--ac-bg);
			border:1px solid var(--ac-bd);
			display:flex;align-items:center;justify-content:center;
			font-size:11px;
			flex-shrink:0;
			margin-right:8px;
			color:var(--ac);
			font-weight:700;
		}
		.row-body{flex:1;min-width:0}
		.row-label{
			font-size:12px;
			font-weight:600;
			color:var(--tx);
			white-space:nowrap;
			overflow:hidden;
			text-overflow:ellipsis;
		}
		.row-meta{
			font-size:10px;
			color:var(--mt);
			margin-top:1px;
			white-space:nowrap;
			overflow:hidden;
			text-overflow:ellipsis;
		}
		.row-arrow{
			font-size:10px;
			color:var(--mt);
			margin-left:4px;
			opacity:0;
			transition:opacity .1s;
		}
		.row:hover .row-arrow{opacity:1}
	</style>
</head>
<body>
	<div class="header">
		<div class="header-title">${t(i18n.dashboardTitle)}</div>
		<div class="header-sub">${t(i18n.dashboardSub)}</div>
	</div>

	<div class="section">
		<div class="section-label">Project</div>
		<button class="row" id="board">
			<div class="row-icon">&#x2795;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.boardStudio)}</div>
				<div class="row-meta">${t(i18n.boardStudioMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="syncCatalog">
			<div class="row-icon">&#x21BB;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.cubemxSync)}</div>
				<div class="row-meta">${t(i18n.cubemxSyncMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="pin">
			<div class="row-icon">&#x25CE;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.pinVisualizer)}</div>
				<div class="row-meta">${t(i18n.pinVisualizerMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
	</div>

	<div class="section">
		<div class="section-label">Build &amp; Flash</div>
		<button class="row" id="build">
			<div class="row-icon">&#x25B6;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.buildDebug)}</div>
				<div class="row-meta">${t(i18n.buildDebugMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="flash">
			<div class="row-icon">&#x21A1;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.flash)}</div>
				<div class="row-meta">${t(i18n.flashMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="debug">
			<div class="row-icon">&#x1F41E;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.debugStart)}</div>
				<div class="row-meta">${t(i18n.debugStartMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
	</div>

	<div class="section">
		<div class="section-label">Tools</div>
		<button class="row" id="mcp">
			<div class="row-icon">MCP</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.mcpDesk)}</div>
				<div class="row-meta">${t(i18n.mcpDeskMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="svd">
			<div class="row-icon">SVD</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.svdRefresh)}</div>
				<div class="row-meta">${t(i18n.svdRefreshMeta)}</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="error">
			<div class="row-icon">&#x26A0;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.autoErrorExplain)}</div>
				<div class="row-meta">Auto-explain build errors with AI</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
		<button class="row" id="envSettings">
			<div class="row-icon">&#x2699;</div>
			<div class="row-body">
				<div class="row-label">${t(i18n.envSettings)}</div>
				<div class="row-meta">make / CubeMX / Programmer CLI paths</div>
			</div>
			<span class="row-arrow">&#x276F;</span>
		</button>
	</div>
<script>
	const vscode = acquireVsCodeApi();
	for (const id of ['board','syncCatalog','pin','build','flash','debug','mcp','svd','error','envSettings']) {
		document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
	}
</script>
</body>
</html>`;
}

function getMcpOperationDeskHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	const _i18nJson = JSON.stringify(getUxI18n());
	const lang = vscode.env.language.split('-')[0] ?? 'en';
	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e;--ac2:rgba(15,118,110,.14)}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:transparent;color:var(--tx);padding:18px}
		h1{font-size:18px;margin-bottom:4px}
		.sub{font-size:11px;color:var(--mt);margin-bottom:14px}
		.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
		button{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:10px;text-align:left;cursor:pointer;font:inherit}
		button:hover{background:var(--ac2);border-color:rgba(15,118,110,.5)}
		button:disabled{opacity:.5;cursor:not-allowed;background:rgba(107,114,128,.12);border-color:rgba(107,114,128,.45)}
		.t{font-weight:700;font-size:12px}
		.d{font-size:10px;color:var(--mt)}
		.status{margin:8px 0 12px;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;background:rgba(15,118,110,.08);font-size:11px;color:#d1fae5}
		.status.off{background:rgba(127,29,29,.12);color:#fecaca}
	</style>
</head>
<body>
	<h1 id="mcpDeskTitle"></h1>
	<div class="sub" id="mcpDeskSub"></div>
	<div id="mcpStatus" class="status off" data-checking=""></div>
	<div class="grid">
		<button id="startMcp"><div class="t" data-i18n="mcpStartServer"></div><div class="d">stm32ai.startMcpServer</div></button>
		<button id="startSseMcp"><div class="t" data-i18n="mcpStartSseServer"></div><div class="d">http://127.0.0.1:3737/sse</div></button>
		<button id="stopMcp"><div class="t" data-i18n="mcpStopServer"></div><div class="d">stm32ai.stopMcpServer</div></button>
		<button id="envSettings"><div class="t" data-i18n="envSettings"></div><div class="d">make / CubeMX path settings</div></button>
		<button id="exportConfig"><div class="t" data-i18n="mcpExportConfig"></div><div class="d">.vscode/stm32-mcp.config.json</div></button>
		<button id="composeRpc"><div class="t" data-i18n="mcpComposeRpc"></div><div class="d">Generate with any method/params</div></button>
		<button id="build"><div class="t" data-i18n="buildDebug"></div><div class="d">method: stm32.build</div></button>
		<button id="flash"><div class="t" data-i18n="flash"></div><div class="d">method: stm32.flash</div></button>
		<button id="regen"><div class="t" data-i18n="regenerateCode"></div><div class="d">method: stm32.regenerateCode</div></button>
		<button id="board"><div class="t" data-i18n="boardConfig"></div><div class="d">method: stm32.openBoardConfigurator</div></button>
		<button id="svd"><div class="t" data-i18n="svdRefresh"></div><div class="d">method: stm32.refreshRegisters</div></button>
	</div>
	<script>
		const _i18n = ${_i18nJson};
		const vscode = acquireVsCodeApi();
		document.getElementById('mcpDeskTitle').textContent = _i18n.mcpDeskTitle;
		document.getElementById('mcpDeskSub').textContent = _i18n.mcpDeskSub;
		document.getElementById('mcpStatus').textContent = _i18n.mcpStatusChecking;
		document.querySelectorAll('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if (_i18n[k]) el.textContent = _i18n[k]; });
		const startBtn = document.getElementById('startMcp');
		const stopBtn = document.getElementById('stopMcp');
		const statusNode = document.getElementById('mcpStatus');

		function applyStatus(payload) {
			const running = !!payload.running;
			startBtn.disabled = running;
			stopBtn.disabled = !running;
			statusNode.classList.toggle('off', !running);
			const endpoint = payload.endpoint ? (' / ' + payload.endpoint) : '';
			statusNode.textContent = running
				? _i18n.mcpRunning.replace('{0}', (payload.detail || '') + endpoint)
				: _i18n.mcpStopped.replace('{0}', payload.detail || _i18n.mcpNoConnection);
		}

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg && msg.type === 'mcpStatus') {
				applyStatus(msg);
			}
		});

		for (const id of ['startMcp','startSseMcp','stopMcp','envSettings','exportConfig','composeRpc','build','flash','regen','board','svd']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
		vscode.postMessage({ type: 'checkMcpStatus' });
	</script>
</body>
</html>`;
}



function getWelcomeHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	const _i18nJson = JSON.stringify(getUxI18n());
	const lang = vscode.env.language.split('-')[0] ?? 'en';
	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box}
		html,body{background:transparent !important}
		body{font:13px/1.65 var(--vscode-font-family,'Segoe UI',sans-serif);color:var(--vscode-editor-foreground);margin:0;padding:24px 28px}
		h1{font-size:22px;font-weight:700;margin:0 0 4px}
		.sub{color:var(--vscode-descriptionForeground);margin:0 0 20px;max-width:920px}
		h2{font-size:13px;font-weight:700;margin:22px 0 10px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.06em}
		.action-list{margin:0;padding:0;list-style:none}
		.action-item{display:grid;grid-template-columns:minmax(160px,200px) 1fr auto;gap:14px;align-items:start;padding:9px 0;border-bottom:1px solid var(--vscode-panel-border)}
		.action-name{font-weight:600}
		.action-desc{color:var(--vscode-descriptionForeground)}
		.action-btn{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font:600 12px var(--vscode-font-family,'Segoe UI',sans-serif);padding:0;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
		.action-btn:hover{color:var(--vscode-textLink-activeForeground)}
		.links{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px}
		.link-btn{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font:12px var(--vscode-font-family,'Segoe UI',sans-serif);padding:0;text-decoration:underline;text-underline-offset:2px}
		.link-btn:hover{color:var(--vscode-textLink-activeForeground)}
		@media (max-width: 760px){
			body{padding:18px 16px}
			.action-item{grid-template-columns:1fr;gap:6px}
		}
	</style>
</head>
<body>
	<h1 id="wlcTitle"></h1>
<p class="sub" id="wlcSub"></p>

<h2>Quick Start</h2>
<ul class="action-list">
	<li class="action-item">
		<div class="action-name" id="wlcImportName"></div>
		<div class="action-desc" id="wlcImportDesc"></div>
		<button class="action-btn" id="import"></button>
	</li>
	<li class="action-item">
		<div class="action-name" id="wlcBoardName"></div>
		<div class="action-desc" id="wlcBoardDesc"></div>
		<button class="action-btn" id="board"></button>
	</li>
	<li class="action-item">
		<div class="action-name" id="wlcSyncName"></div>
		<div class="action-desc" id="wlcSyncDesc"></div>
		<button class="action-btn" id="syncCatalog"></button>
	</li>
</ul>

<div class="links">
	<button class="link-btn" id="env"></button>
	<button class="link-btn" id="envSettings"></button>
	<button class="link-btn" id="pin"></button>
	<button class="link-btn" id="error"></button>
</div>

<script>
	const _i18n = ${_i18nJson};
	const vscode = acquireVsCodeApi();
	document.getElementById('wlcTitle').textContent = _i18n.welcomeTitle;
	document.getElementById('wlcSub').textContent = _i18n.welcomeSub;
	document.getElementById('wlcImportName').textContent = _i18n.importCubeIDE;
	document.getElementById('wlcImportDesc').textContent = _i18n.importCubeIDEDesc;
	document.getElementById('import').textContent = _i18n.import;
	document.getElementById('wlcBoardName').textContent = _i18n.boardConfig;
	document.getElementById('wlcBoardDesc').textContent = _i18n.boardConfigDesc;
	document.getElementById('board').textContent = _i18n.openAction;
	document.getElementById('wlcSyncName').textContent = _i18n.cubemxSync;
	document.getElementById('wlcSyncDesc').textContent = _i18n.cubemxSyncMeta;
	document.getElementById('syncCatalog').textContent = _i18n.syncCatalogAction;
	document.getElementById('env').textContent = _i18n.envCheck;
	document.getElementById('envSettings').textContent = _i18n.envSettings;
	document.getElementById('pin').textContent = _i18n.pinVisualizer;
	document.getElementById('error').textContent = _i18n.autoErrorExplain;
	document.getElementById('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));
	document.getElementById('board').addEventListener('click', () => vscode.postMessage({ type: 'board' }));
	document.getElementById('syncCatalog').addEventListener('click', () => vscode.postMessage({ type: 'syncCatalog' }));
	document.getElementById('env').addEventListener('click', () => vscode.postMessage({ type: 'env' }));
	document.getElementById('envSettings').addEventListener('click', () => vscode.postMessage({ type: 'envSettings' }));
	document.getElementById('pin').addEventListener('click', () => vscode.postMessage({ type: 'pin' }));
	document.getElementById('error').addEventListener('click', () => vscode.postMessage({ type: 'error' }));
</script>
</body>
</html>`;
}



function buildLqfpSvg(
	pins: Array<{ pin: string; mode: string }>,
	packageName?: string,
	searchTagsByPin: Record<string, string> = {},
	usageByPin: Record<string, string> = {},
	fixedByPin: Record<string, boolean> = {},
	mcuName?: string
): string {
	const n = pins.length;
	if (n === 0) { return `<text x="10" y="20" fill="#6B7280" font-size="12">${escapeHtml(getUxI18n().noPins)}</text>`; }

	const basePerSide = Math.floor(n / 4);
	const remainder = n % 4;
	const sideCounts = [basePerSide, basePerSide, basePerSide, basePerSide];
	for (let i = 0; i < remainder; i++) {
		sideCounts[i] += 1;
	}
	const maxPerSide = Math.max(...sideCounts);

	// Slightly denser layout for better overview on large packages.
	const PIN_PITCH = 22;   // px per pin slot
	const PIN_W = 10;       // pin lead width (perpendicular to direction)
	const PIN_STUB = 12;    // pin lead length from chip edge
	const longestUsage = Object.values(usageByPin).reduce((max, text) => Math.max(max, text.length), 0);
	const LABEL_AREA = Math.max(72, Math.min(260, 72 + longestUsage * 5));
	const CHIP_SIZE = maxPerSide * PIN_PITCH + 16;
	const OFFSET = PIN_STUB + LABEL_AREA; // total margin = 84px
	const TOTAL = CHIP_SIZE + OFFSET * 2;

	// Pin numbering follows common QFP convention: pin 1 at top-left, then counter-clockwise.
	// Side order in this renderer: left(top->bottom), bottom(left->right), right(bottom->top), top(right->left).
	const sidePins: Array<Array<{ pin: string; mode: string }>> = [[], [], [], []];
	let cursor = 0;
	for (let s = 0; s < 4; s++) {
		sidePins[s] = pins.slice(cursor, cursor + sideCounts[s]);
		cursor += sideCounts[s];
	}

	let elements = '';

	// chip body
	const CX = OFFSET, CY = OFFSET;
	elements += `<rect x="${CX}" y="${CY}" width="${CHIP_SIZE}" height="${CHIP_SIZE}" rx="8" fill="#1a1d2e" stroke="#4B5563" stroke-width="1.5"/>`;
	elements += `<path d="M${CX + 18},${CY} A18,18 0 0,0 ${CX},${CY + 18}" fill="#0d0e14" stroke="#4B5563" stroke-width="1"/>`;
	const midX = CX + CHIP_SIZE / 2;
	const midY = CY + CHIP_SIZE / 2;
	const chipTitle = mcuName ?? 'STM32';
	const chipPkg = packageName ?? ('PKG' + n);
	elements += `<text x="${midX}" y="${midY - 10}" text-anchor="middle" fill="#D1D5DB" font-size="16" font-weight="700" font-family="Segoe UI,sans-serif">${escapeHtml(chipTitle)}</text>`;
	elements += `<text x="${midX}" y="${midY + 10}" text-anchor="middle" fill="#9CA3AF" font-size="13" font-style="italic" font-family="Segoe UI,sans-serif">${escapeHtml(chipPkg)}</text>`;
	elements += `<circle cx="${CX + 12}" cy="${CY + 12}" r="3" fill="#f59e0b" opacity="0.9"/>`;

	let globalPinNum = 0;
	for (let s = 0; s < 4; s++) {
		const sideOffset = ((maxPerSide - sidePins[s].length) * PIN_PITCH) / 2;
		for (let i = 0; i < sidePins[s].length; i++) {
			globalPinNum++;
			const item = sidePins[s][i];
			const editable = /^P[A-K][0-9]{1,2}$/i.test(item.pin) && !fixedByPin[item.pin.toUpperCase()];
			const usage = usageByPin[item.pin.toUpperCase()] ?? '';
			const sideLabelText = usage;
			const isUnused = item.mode === 'Unused';
			const fill = isUnused ? '#1a1d2e' : colorForMode(item.mode);
			const stroke = isUnused ? '#374151' : colorForModeBorder(item.mode);

			// center position along this side
			const sidePos = 8 + sideOffset + i * PIN_PITCH + PIN_PITCH / 2;

			let prect = '', pnum = '', plbl = '';

			if (s === 0) {
				// left: top -> bottom
				const py = CY + sidePos;
				const chipLeft = CX;
				prect = `<rect x="${chipLeft - PIN_STUB}" y="${py - PIN_W / 2}" width="${PIN_STUB}" height="${PIN_W}" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
				pnum = `<text x="${chipLeft + 4}" y="${py + 4}" text-anchor="start" fill="rgba(255,255,255,0.4)" font-size="7" font-family="Segoe UI,sans-serif">${globalPinNum}</text>`;
				plbl = sideLabelText ? `<text x="${chipLeft - PIN_STUB - 6}" y="${py + 4}" text-anchor="end" dominant-baseline="middle" fill="#D1D5DB" font-size="10" font-family="Segoe UI,sans-serif" pointer-events="none">${escapeHtml(sideLabelText)}</text>` : '';
			} else if (s === 1) {
				// bottom: left -> right
				const px = CX + sidePos;
				const chipBot = CY + CHIP_SIZE;
				prect = `<rect x="${px - PIN_W / 2}" y="${chipBot}" width="${PIN_W}" height="${PIN_STUB}" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
				pnum = `<text x="${px}" y="${chipBot - 2}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="7" font-family="Segoe UI,sans-serif">${globalPinNum}</text>`;
				plbl = sideLabelText ? `<g transform="translate(${px},${chipBot + PIN_STUB + 3}) rotate(90)"><text x="0" y="0" text-anchor="start" dominant-baseline="middle" fill="#D1D5DB" font-size="10" font-family="Segoe UI,sans-serif" pointer-events="none">${escapeHtml(sideLabelText)}</text></g>` : '';
			} else if (s === 2) {
				// right: bottom -> top
				const py = CY + CHIP_SIZE - sidePos;
				const chipRight = CX + CHIP_SIZE;
				prect = `<rect x="${chipRight}" y="${py - PIN_W / 2}" width="${PIN_STUB}" height="${PIN_W}" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
				pnum = `<text x="${chipRight - 4}" y="${py + 4}" text-anchor="end" fill="rgba(255,255,255,0.4)" font-size="7" font-family="Segoe UI,sans-serif">${globalPinNum}</text>`;
				plbl = sideLabelText ? `<text x="${chipRight + PIN_STUB + 6}" y="${py + 4}" text-anchor="start" dominant-baseline="middle" fill="#D1D5DB" font-size="10" font-family="Segoe UI,sans-serif" pointer-events="none">${escapeHtml(sideLabelText)}</text>` : '';
			} else {
				// top: right -> left
				const px = CX + CHIP_SIZE - sidePos;
				const chipTop = CY;
				prect = `<rect x="${px - PIN_W / 2}" y="${chipTop - PIN_STUB}" width="${PIN_W}" height="${PIN_STUB}" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
				pnum = `<text x="${px}" y="${chipTop + 8}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="7" font-family="Segoe UI,sans-serif">${globalPinNum}</text>`;
				plbl = sideLabelText ? `<g transform="translate(${px},${chipTop - PIN_STUB - 3}) rotate(-90)"><text x="0" y="0" text-anchor="start" dominant-baseline="middle" fill="#D1D5DB" font-size="10" font-family="Segoe UI,sans-serif" pointer-events="none">${escapeHtml(sideLabelText)}</text></g>` : '';
			}

			const searchTags = searchTagsByPin[item.pin.toUpperCase()] ?? '';
			elements += `<g class="lqfp-pin${editable ? '' : ' fixed'}" data-pin="${escapeHtml(item.pin)}" data-mode="${escapeHtml(item.mode)}" data-search="${escapeHtml(searchTags)}" data-num="${globalPinNum}" data-editable="${editable ? '1' : '0'}" role="${editable ? 'button' : 'img'}" tabindex="${editable ? '0' : '-1'}" aria-label="${globalPinNum}: ${escapeHtml(item.pin)}: ${escapeHtml(item.mode)}">`
				+ prect + pnum + plbl + `</g>`;
		}
	}

	return `<svg viewBox="0 0 ${TOTAL} ${TOTAL}" width="${TOTAL}" height="${TOTAL}" aria-label="LQFP chip diagram" role="img">${elements}</svg>`;
}

function comparePinNames(a: { pin: string }, b: { pin: string }): number {
	const re = /^([A-Za-z]+)(\d+)$/;
	const ma = a.pin.match(re);
	const mb = b.pin.match(re);
	if (!ma || !mb) { return a.pin.localeCompare(b.pin); }
	const portCmp = ma[1].localeCompare(mb[1]);
	return portCmp !== 0 ? portCmp : parseInt(ma[2], 10) - parseInt(mb[2], 10);
}

function trimUsageLabel(value: string, max = 38): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max - 1)}…`;
}

function normalizeSignalUsageLabel(signal: string): string {
	const raw = signal.trim();
	const upper = raw.toUpperCase();

	if (upper.includes('SYS_JTMS')) { return 'TMS'; }
	if (upper.includes('SYS_JTCK')) { return 'TCK'; }
	if (upper.includes('SYS_JTDI')) { return 'TDI'; }
	if (upper.includes('SYS_JTDO')) { return 'TDO'; }
	if (upper.includes('SYS_NJTRST')) { return 'nTRST'; }
	if (upper.includes('SWDIO')) { return 'SWDIO'; }
	if (upper.includes('SWCLK')) { return 'SWCLK'; }
	if (upper.includes('USB') || upper.includes('OTG')) {
		if (upper.endsWith('_DP') || upper.includes('_DP_')) { return 'USB_DP'; }
		if (upper.endsWith('_DM') || upper.includes('_DM_')) { return 'USB_DM'; }
		if (upper.endsWith('_ID') || upper.includes('_ID_')) { return 'USB_ID'; }
		if (upper.endsWith('_VBUS') || upper.includes('_VBUS_')) { return 'USB_VBUS'; }
		if (upper.endsWith('_SOF') || upper.includes('_SOF_')) { return 'USB_SOF'; }
	}

	return raw.replace(/^SYS_/, '').replace(/^USB_OTG_[A-Z0-9]+_/, 'USB_');
}

function getPinVisualizerHtml(webview: vscode.Webview, pins: Array<{ pin: string; mode: string }>, iocPath: string | undefined, iocSettings: IocFullSettings = { pinAssignments: {}, pinSignals: {}, pinLocks: {}, pinGpioConfigs: {}, nvicSettings: {}, dmaLines: [], paramSettings: {}, userConstants: [], systemSettings: {} }, packageName?: string, mcuName?: string, boardRolesByPin: Record<string, string> = {}, boardFixedByPin: Record<string, boolean> = {}): string {
	const csp = webview.cspSource;

	const sorted = [...pins].sort(comparePinNames);
	const editablePins = sorted.filter(item => /^P[A-K][0-9]{1,2}$/i.test(item.pin));

	const groupMap = new Map<string, Array<{ pin: string; mode: string }>>();
	for (const item of editablePins) {
		const portMatch = item.pin.match(/^([A-Za-z]+)/);
		const portKey = portMatch ? portMatch[1].toUpperCase() : '?';
		let arr = groupMap.get(portKey);
		if (!arr) { arr = []; groupMap.set(portKey, arr); }
		arr.push(item);
	}

	const searchTagsByPin: Record<string, string> = {};
	const usageByPin: Record<string, string> = {};
	const modeGroupsByPin: Record<string, Record<string, string[]>> = {};
	for (const p of editablePins) {
		const key = p.pin.toUpperCase();
		const aliases = COMMON_PIN_ALIASES[key] ?? [];
		const usage = boardRolesByPin[key] ?? '';
		const signals = iocSettings.pinSignals[p.pin] ?? [];
		usageByPin[key] = usage;
		const tags = [p.pin, p.mode, usage, ...signals, ...aliases].filter(v => typeof v === 'string' && v.trim().length > 0);
		searchTagsByPin[key] = tags.join(' ').toLowerCase();
		modeGroupsByPin[key] = { GPIO: ['GPIO_Output', 'GPIO_Input', 'GPIO_Analog', 'Reset_State', p.mode] };
	}

	const cardHtml = Array.from(groupMap.entries()).map(([port, items]) => {
		const cards = items.map(item => {
			const color = colorForMode(item.mode);
			const border = colorForModeBorder(item.mode);
			const usage = usageByPin[item.pin.toUpperCase()] || '';
			const searchTags = searchTagsByPin[item.pin.toUpperCase()] ?? '';
			const editable = !boardFixedByPin[item.pin.toUpperCase()];
			return `<button class="pin-card" data-pin="${escapeHtml(item.pin)}"
				data-editable="${editable ? '1' : '0'}"
				data-search="${escapeHtml(searchTags)}"
				style="background:${color};border-color:${border}"
				aria-label="${escapeHtml(item.pin)}: ${escapeHtml(item.mode)}"
				title="${escapeHtml(item.mode)}">
				<span class="pin-name">${escapeHtml(item.pin)}</span>
				${usage ? `<span class="pin-usage">${escapeHtml(usage)}</span>` : ''}
			</button>`;
		}).join('');
		return `<div class="port-group" data-port="${escapeHtml(port)}">
			<div class="port-hd"><span class="port-badge">PORT ${escapeHtml(port)}</span><span class="port-count">${items.length} pin</span></div>
			<div class="pin-grid">${cards}</div>
		</div>`;
	}).join('');

	const legend = [
		{ color: '#0f4c5c', border: '#14b8a6', label: 'GPIO Output' },
		{ color: '#1a4731', border: '#22c55e', label: 'GPIO Input' },
		{ color: '#7c3a00', border: '#f59e0b', label: 'UART/USART' },
		{ color: '#6d1a4c', border: '#ec4899', label: 'I2C' },
		{ color: '#1f4d7a', border: '#38bdf8', label: 'SPI/I2S' },
		{ color: '#7c1d1d', border: '#ef4444', label: 'ADC/DAC' },
		{ color: '#1a3050', border: '#3b82f6', label: 'TIM/PWM' },
		{ color: '#3b1f6e', border: '#a78bfa', label: 'SWD/JTAG' },
		{ color: '#1a3a2e', border: '#34d399', label: 'RCC/OSC' },
		{ color: '#3d2800', border: '#fb923c', label: 'CAN' },
		{ color: '#1a1d2e', border: '#374151', label: getUxI18n().unused },
	];
	const legendHtml = legend.map(l =>
		`<span class="lg-item"><span class="lg-dot" style="background:${l.color};border-color:${l.border}"></span>${escapeHtml(l.label)}</span>`
	).join('');

	const chipSvg = buildLqfpSvg(pins, packageName, searchTagsByPin, usageByPin, boardFixedByPin, mcuName);

	// ---- Build settings tab content from parsed ioc settings ----

	// GPIO Settings tab: all configured pins with sub-settings
	const gpioSpeedOptions = ['GPIO_SPEED_FREQ_LOW', 'GPIO_SPEED_FREQ_MEDIUM', 'GPIO_SPEED_FREQ_HIGH', 'GPIO_SPEED_FREQ_VERY_HIGH'];
	const gpioPuPdOptions = ['GPIO_NOPULL', 'GPIO_PULLUP', 'GPIO_PULLDOWN'];
	const gpioModeOptions = ['GPIO_MODE_OUTPUT_PP', 'GPIO_MODE_OUTPUT_OD', 'GPIO_MODE_INPUT', 'GPIO_MODE_ANALOG', 'GPIO_MODE_AF_PP', 'GPIO_MODE_AF_OD', 'GPIO_MODE_IT_RISING', 'GPIO_MODE_IT_FALLING', 'GPIO_MODE_IT_RISING_FALLING', 'GPIO_MODE_EVT_RISING', 'GPIO_MODE_EVT_FALLING', 'GPIO_MODE_EVT_RISING_FALLING'];
	const gpioRows = sorted
		.filter(p => /^GPIO/i.test(p.mode) || Object.prototype.hasOwnProperty.call(iocSettings.pinGpioConfigs, p.pin))
		.map(p => {
			const cfg = iocSettings.pinGpioConfigs[p.pin] ?? {};
			const modeKey = `${p.pin}-${p.mode}.GPIO_Mode`;
			const speedKey = `${p.pin}-${p.mode}.GPIO_Speed`;
			const pupKey = `${p.pin}-${p.mode}.GPIO_PuPd`;
			const labelKey = `${p.pin}-${p.mode}.GPIO_Label`;
			const makeSelect = (key: string, opts: string[], cur: string): string => {
				const optsHtml = opts.map(o => `<option value="${escapeHtml(o)}"${o === cur ? ' selected' : ''}>${escapeHtml(o.replace(/GPIO_(?:MODE_|SPEED_FREQ_|)?/gi, ''))}</option>`).join('');
				return `<select class="s-sel" data-key="${escapeHtml(key)}" title="${escapeHtml(key)}">${optsHtml}</select>`;
			};
			return `<tr>
				<td class="s-td-pin">${escapeHtml(p.pin)}</td>
				<td class="s-td-mode">${escapeHtml(p.mode)}</td>
				<td>${makeSelect(modeKey, gpioModeOptions, cfg['GPIO_Mode'] ?? '')}</td>
				<td>${makeSelect(speedKey, gpioSpeedOptions, cfg['GPIO_Speed'] ?? '')}</td>
				<td>${makeSelect(pupKey, gpioPuPdOptions, cfg['GPIO_PuPd'] ?? '')}</td>
				<td><input class="s-inp" type="text" data-key="${escapeHtml(labelKey)}" value="${escapeHtml(cfg['GPIO_Label'] ?? '')}" /></td>
			</tr>`;
		}).join('');

	// NVIC Settings tab
	const nvicRows = Object.entries(iocSettings.nvicSettings).sort((a, b) => a[0].localeCompare(b[0])).map(([irq, cfg]) => {
		const stateKey = `NVIC.${irq}_IRQChannelState`;
		const preKey = `NVIC.${irq}_IRQChannelPreemptionPriority`;
		const subKey = `NVIC.${irq}_IRQChannelSubPriority`;
		const isEnabled = (cfg['IRQChannelState'] ?? '').toUpperCase() === 'ENABLE' || cfg['IRQChannelState'] === '1' || cfg['IRQChannelState'] === 'TRUE';
		const prePri = cfg['IRQChannelPreemptionPriority'] ?? '0';
		const subPri = cfg['IRQChannelSubPriority'] ?? '0';
		return `<tr>
			<td class="s-td-pin">${escapeHtml(irq)}</td>
			<td><input type="checkbox" class="s-chk" data-key="${escapeHtml(stateKey)}" data-on="ENABLE" data-off="DISABLE" ${isEnabled ? 'checked' : ''} /></td>
			<td><input class="s-num" type="number" min="0" max="15" data-key="${escapeHtml(preKey)}" value="${escapeHtml(prePri)}" /></td>
			<td><input class="s-num" type="number" min="0" max="15" data-key="${escapeHtml(subKey)}" value="${escapeHtml(subPri)}" /></td>
		</tr>`;
	}).join('');
	const nvicEmpty = nvicRows ? '' : '<tr><td colspan="4" class="s-empty" id="nvicEmpty"></td></tr>';

	// DMA Settings tab
	const dmaRows = iocSettings.dmaLines.map(({ key, value }) =>
		`<tr>
			<td><code class="s-code">${escapeHtml(key)}</code></td>
			<td><input class="s-inp" type="text" data-key="${escapeHtml(key)}" value="${escapeHtml(value)}" /></td>
			<td><button class="s-del-btn" data-removekey="${escapeHtml(key)}">✕</button></td>
		</tr>`
	).join('');
	const dmaEmpty = dmaRows ? '' : '<tr><td colspan="3" class="s-empty" id="dmaEmpty"></td></tr>';

	// Parameter Settings tab
	const skipParamGroups = new Set(['ProjectManager', 'Mcu', 'File', 'KeepUserPlacement', 'NVIC', 'DMA']);
	const paramGroupsHtml = Object.entries(iocSettings.paramSettings)
		.filter(([grp]) => !skipParamGroups.has(grp))
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([grp, props]) => {
			const rows = Object.entries(props).sort((a, b) => a[0].localeCompare(b[0])).map(([prop, val]) => {
				const key = `${grp}.${prop}`;
				return `<tr>
					<td><code class="s-code">${escapeHtml(prop)}</code></td>
					<td><input class="s-inp" type="text" data-key="${escapeHtml(key)}" value="${escapeHtml(val)}" /></td>
					<td><button class="s-del-btn" data-removekey="${escapeHtml(key)}">✕</button></td>
				</tr>`;
			}).join('');
			return `<div class="s-pgrp">
				<div class="s-pgrp-hd">${escapeHtml(grp)}</div>
				<table class="s-table"><tbody>${rows}</tbody></table>
			</div>`;
		}).join('');
	const paramEmpty = paramGroupsHtml ? '' : '<p class="s-empty-p" id="paramEmptyP"></p>';

	// User Constants tab
	const constRows = iocSettings.userConstants.map((c, i) =>
		`<tr>
			<td><input class="s-inp s-const-name" type="text" data-idx="${i}" value="${escapeHtml(c.name)}" /></td>
			<td><input class="s-inp s-const-val" type="text" data-idx="${i}" value="${escapeHtml(c.value)}" /></td>
			<td><button class="s-del-btn s-const-del" data-idx="${i}">✕</button></td>
		</tr>`
	).join('');

	// Serialize iocSettings for JS usage
	const _i18nJson = JSON.stringify(getUxI18n());
	const lang = vscode.env.language.split('-')[0] ?? 'en';
	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e}
		body{font:13px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);background:transparent;color:var(--tx);padding:16px 20px}
		/* ---- settings tab bar ---- */
		.stab-bar{display:flex;gap:2px;margin-bottom:14px;border-bottom:1px solid var(--bd);flex-wrap:wrap}
		.stab-btn{background:none;border:none;border-bottom:2px solid transparent;color:var(--mt);padding:7px 14px;font-size:12px;cursor:pointer;margin-bottom:-1px;white-space:nowrap}
		.stab-btn:hover{color:var(--tx);background:var(--sf)}
		.stab-btn.active{color:#e8eaed;border-bottom-color:var(--ac);font-weight:600}
		.stab-panel{display:none}
		.stab-panel.active{display:block}
		/* ---- settings tables ---- */
		.s-panel-hd{display:flex;align-items:center;gap:12px;margin-bottom:12px}
		.s-panel-title{font-size:13px;font-weight:700;flex:1}
		.s-save-btn{background:var(--ac);border:none;color:#fff;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;font-weight:600}
		.s-save-btn:hover{opacity:.9}
		.s-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
		.s-table th{padding:5px 8px;text-align:left;background:var(--sf);border:1px solid var(--bd);font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--mt);text-transform:uppercase}
		.s-table td{padding:4px 8px;border:1px solid var(--bd);vertical-align:middle}
		.s-table tr:hover td{background:rgba(255,255,255,.03)}
		.s-td-pin{font-family:var(--vscode-editor-font-family,monospace);font-size:12px;font-weight:700;white-space:nowrap;color:#93c5fd}
		.s-td-mode{font-size:11px;color:var(--mt)}
		.s-sel{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:4px;padding:3px 6px;font-size:11px;outline:none;width:100%}
		.s-sel:focus{border-color:var(--ac)}
		.s-inp{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:4px;padding:3px 7px;font-size:11px;outline:none;width:100%}
		.s-inp:focus{border-color:var(--ac)}
		.s-num{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:4px;padding:3px 5px;font-size:11px;outline:none;width:64px}
		.s-num:focus{border-color:var(--ac)}
		.s-chk{width:16px;height:16px;accent-color:var(--ac);cursor:pointer}
		.s-del-btn{background:none;border:1px solid var(--bd);color:#ef4444;border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer}
		.s-del-btn:hover{background:#7c1d1d}
		.s-empty{padding:12px 8px;color:var(--mt);font-size:12px;text-align:center}
		.s-empty-p{padding:16px 0;color:var(--mt);font-size:12px}
		.s-code{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;color:#9ca3af}
		.s-pgrp{margin-bottom:18px}
		.s-pgrp-hd{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--mt);margin-bottom:6px;padding:4px 8px;background:var(--sf);border-left:3px solid var(--ac);border-radius:2px}
		.s-add-btn{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;margin-top:8px}
		.s-add-btn:hover{border-color:var(--ac)}
		/* ---- pin view ---- */
		.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
		.chip-hdr{flex:1;min-width:0}
		.chip-hdr h1{font-size:15px;font-weight:700;margin-bottom:2px}
		.chip-hdr .path{font-size:11px;color:var(--mt);font-family:var(--vscode-editor-font-family,monospace);word-break:break-all}
		.search-wrap{position:relative}
		.search-wrap input{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:6px;padding:5px 10px 5px 30px;font-size:12px;outline:none;width:180px}
		.search-wrap input:focus{border-color:var(--ac)}
		.search-wrap .ic{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--mt);font-size:13px;pointer-events:none}
		.pin-count{font-size:11px;color:var(--mt);white-space:nowrap}
		.view-toggle{display:flex;gap:4px}
		.vtbtn{background:var(--sf);border:1px solid var(--bd);color:var(--mt);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer}
		.vtbtn.active{background:var(--ac);border-color:var(--ac);color:#fff}
		.legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;padding:9px 12px;border:1px solid var(--bd);border-radius:8px;background:var(--sf)}
		.lg-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--mt)}
		.lg-dot{width:10px;height:10px;border-radius:3px;border:1.5px solid;flex-shrink:0}
		.port-group{margin-bottom:10px}
		.port-group.hidden{display:none}
		.port-hd{display:flex;align-items:center;gap:6px;margin-bottom:4px}
		.port-badge{font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:4px;background:var(--sf);border:1px solid var(--bd);color:var(--mt)}
		.port-count{font-size:10px;color:var(--mt)}
		.pin-grid{display:flex;flex-wrap:wrap;gap:2px}
		.pin-card{display:flex;flex-direction:column;align-items:flex-start;padding:2px 5px;border:1.2px solid;border-radius:5px;cursor:pointer;min-width:72px;text-align:left;transition:filter .1s,box-shadow .1s}
		.pin-card:hover{filter:brightness(1.18);box-shadow:0 0 0 2px rgba(255,255,255,.08)}
		.pin-card:focus{outline:2px solid #fff;outline-offset:2px}
		.pin-card[data-editable="0"]{cursor:default;opacity:.8}
		.pin-card[data-editable="0"]:hover{filter:none;box-shadow:none}
		.pin-name{font-size:11px;font-weight:700;color:#e8eaed;line-height:1.15}
		.pin-usage{font-size:9px;color:#fbbf24;line-height:1.1;margin-top:1px}
		.empty-msg{color:var(--mt);font-size:13px;margin-top:20px}
		.hint{font-size:11px;color:var(--mt);margin-bottom:14px}
		#chipView{overflow:auto;border:1px solid var(--bd);border-radius:8px;background:#13151e;padding:6px;display:block}
		#chipView .lqfp-pin{cursor:pointer}
		#chipView .lqfp-pin.fixed{cursor:default}
		#chipView .lqfp-pin:focus rect{stroke:#fff;stroke-width:2}
		#chipView .lqfp-pin:hover rect{filter:brightness(1.25)}
		#chipView .lqfp-pin.dim{opacity:.18}
		#chipView .lqfp-pin.match rect{stroke:#fbbf24;stroke-width:2;filter:brightness(1.3)}
		#chipWrap{overflow:auto}
		#chipSvg{transform-origin:top left;transition:transform .15s}
		.zoom-row{display:flex;gap:6px;align-items:center;margin-bottom:8px}
		.zbtn{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:5px;width:28px;height:28px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1}
		.zbtn:hover{border-color:var(--ac)}
		.zoom-label{font-size:11px;color:var(--mt);min-width:36px;text-align:center}
		#pinTooltip{position:fixed;pointer-events:none;background:#1a1d2e;border:1px solid #374151;border-radius:7px;padding:6px 10px;font-size:11px;color:#e8eaed;display:none;z-index:200;box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:220px}
		#pinTooltip .tt-pin{font-weight:700;font-size:12px}
		#pinTooltip .tt-num{color:#6b7280;font-size:10px}
		#pinTooltip .tt-mode{color:#9ca3af;font-size:10px;margin-top:2px}
		#groupsView{display:none}
		/* ---- pin edit dialog ---- */
		#dlgBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100}
		#dlgBackdrop.open{display:flex}
		#dlgBox{background:#1a1d2e;border:1px solid #374151;border-radius:12px;padding:20px 22px;width:min(560px,94vw);max-height:82vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
		#dlgTitle{font-size:14px;font-weight:700;color:#e8eaed}
		#dlgCur{font-size:11px;color:#9ca3af}
		#dlgSearch{background:#0d0e14;border:1px solid #374151;color:#e8eaed;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:100%}
		#dlgSearch:focus{border-color:#0f766e}
		#dlgGroups{overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px}
		.dg-hd{font-size:10px;font-weight:700;letter-spacing:.06em;color:#6b7280;text-transform:uppercase;margin-bottom:4px}
		.dg-chips{display:flex;flex-wrap:wrap;gap:5px}
		.dg-chip{padding:4px 10px;border-radius:6px;border:1.5px solid #374151;background:#0d0e14;color:#9ca3af;font-size:11px;cursor:pointer;transition:background .1s,border-color .1s}
		.dg-chip:hover{background:#1e2030;border-color:#0f766e;color:#e8eaed}
		.dg-chip.selected{background:#0f766e;border-color:#0f766e;color:#fff;font-weight:600}
		.dg-chip.current{border-color:#22c55e;color:#86efac}
		.dg-section.hidden{display:none}
		.dg-chip.chip-hidden{display:none}
		#dlgActions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
		.dlg-btn{padding:6px 18px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid}
		#dlgCancel{background:transparent;border-color:#374151;color:#9ca3af}
		#dlgCancel:hover{border-color:#6b7280;color:#e8eaed}
		#dlgApply{background:#0f766e;border-color:#0f766e;color:#fff}
		#dlgApply:hover{background:#0d9488}
		#dlgApply:disabled{opacity:.4;cursor:not-allowed}
		/* ---- add pin dialog ---- */
		#addDlgBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100}
		#addDlgBackdrop.open{display:flex}
		#addDlgBox{background:#1a1d2e;border:1px solid #374151;border-radius:12px;padding:20px 22px;width:min(420px,94vw);display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
		#addDlgTitle{font-size:14px;font-weight:700;color:#e8eaed}
		.add-row{display:flex;flex-direction:column;gap:4px}
		.add-lbl{font-size:11px;color:#9ca3af}
		#addPinInput{background:#0d0e14;border:1px solid #374151;color:#e8eaed;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:100%;font-family:monospace}
		#addPinInput:focus{border-color:#0f766e}
		#addPinInput.invalid{border-color:#ef4444}
		#addModeSelect{background:#0d0e14;border:1px solid #374151;color:#e8eaed;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:100%}
		#addModeSelect:focus{border-color:#0f766e}
		#addPinErr{font-size:11px;color:#ef4444;min-height:14px}
		#addDlgActions{display:flex;gap:8px;justify-content:flex-end}
	</style>
</head>
<body>
	<!-- ===== Settings tab bar ===== -->
	<div class="stab-bar" role="tablist">
		<button class="stab-btn active" data-show="tab-pins" id="stab-pins" role="tab" aria-selected="true"></button>
		<button class="stab-btn" data-show="tab-gpio" id="stab-gpio" role="tab" aria-selected="false"></button>
		<button class="stab-btn" data-show="tab-nvic" id="stab-nvic" role="tab" aria-selected="false"></button>
		<button class="stab-btn" data-show="tab-dma" id="stab-dma" role="tab" aria-selected="false"></button>
		<button class="stab-btn" data-show="tab-param" id="stab-param" role="tab" aria-selected="false"></button>
		<button class="stab-btn" data-show="tab-const" id="stab-const" role="tab" aria-selected="false"></button>
	</div>

	<!-- ===== Pin Visualizer Panel ===== -->
	<div id="tab-pins" class="stab-panel active">
		<div class="toolbar">
			<div class="chip-hdr">
				<h1 id="pvTitle"></h1>
			<div class="path" id="pvPath">${iocPath ? escapeHtml(iocPath) : ''}</div>
			</div>
			<div class="search-wrap">
				<span class="ic">🔍</span>
				<input id="filterInput" type="search" />
			</div>
			<div class="view-toggle" role="group">
			<button id="btnList" class="vtbtn" aria-pressed="false"></button>
			<button id="btnChip" class="vtbtn active" aria-pressed="true"></button>
		</div>
		<button id="btnAddPin" class="vtbtn" style="border-color:rgba(15,118,110,.45)"></button>
		<span class="pin-count" id="pinCount">${sorted.length}</span>
		</div>
		<div class="hint" id="pvHint"></div>
		<div class="legend" id="pvLegend">${legendHtml}</div>
		<div id="groupsView">${cardHtml || '<p class="empty-msg" id="pvEmpty"></p>'}</div>
		<div id="chipView">
			<div class="zoom-row">
				<button class="zbtn" id="zoomIn">+</button>
			<span class="zoom-label" id="zoomLabel">100%</span>
			<button class="zbtn" id="zoomOut">−</button>
			<button class="zbtn" id="zoomReset" style="width:auto;padding:0 8px;font-size:11px"></button>
			</div>
			<div id="chipWrap"><div id="chipSvg">${chipSvg}</div></div>
		</div>
	</div>
	<div id="pinTooltip"><div class="tt-num"></div><div class="tt-pin"></div><div class="tt-mode"></div></div>

	<!-- ===== GPIO Settings Panel ===== -->
	<div id="tab-gpio" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title" id="gpioTitle"></span>
			<button class="s-save-btn" id="saveGpio"></button>
		</div>
		<table class="s-table">
			<thead><tr><th id="thGpioPin"></th><th id="thGpioMode"></th><th>GPIO Mode</th><th>Speed</th><th>Pull</th><th id="thGpioLabel"></th></tr></thead>
			<tbody>${gpioRows || '<tr><td colspan="6" class="s-empty" id="gpioEmpty"></td></tr>'}</tbody>
		</table>
	</div>

	<!-- ===== NVIC Settings Panel ===== -->
	<div id="tab-nvic" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title" id="nvicTitle"></span>
			<button class="s-save-btn" id="saveNvic"></button>
		</div>
		<table class="s-table">
			<thead><tr><th id="thNvicIrq"></th><th id="thNvicEnabled"></th><th>PreemptPriority</th><th>SubPriority</th></tr></thead>
			<tbody>${nvicRows}${nvicEmpty}</tbody>
		</table>
	</div>

	<!-- ===== DMA Settings Panel ===== -->
	<div id="tab-dma" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title" id="dmaTitle"></span>
			<button class="s-save-btn" id="saveDma"></button>
		</div>
		<table class="s-table">
			<thead><tr><th id="thDmaKey"></th><th id="thDmaValue"></th><th></th></tr></thead>
			<tbody>${dmaRows}${dmaEmpty}</tbody>
		</table>
	</div>

	<!-- ===== Parameter Settings Panel ===== -->
	<div id="tab-param" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title" id="paramTitle"></span>
			<button class="s-save-btn" id="saveParam"></button>
		</div>
		${paramGroupsHtml}${paramEmpty}
	</div>

	<!-- ===== User Constants Panel ===== -->
	<div id="tab-const" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title" id="constTitle"></span>
			<button class="s-save-btn" id="saveConst"></button>
		</div>
		<table class="s-table">
			<thead><tr><th id="thConstName"></th><th id="thConstValue"></th><th></th></tr></thead>
			<tbody id="constBody">${constRows}</tbody>
		</table>
		<button class="s-add-btn" id="addConst"></button>
	</div>

	<!-- ===== Dialogs ===== -->
	<div id="addDlgBackdrop" role="dialog" aria-modal="true" aria-labelledby="addDlgTitle">
		<div id="addDlgBox">
			<div id="addDlgTitle"></div>
		<div class="add-row">
			<label class="add-lbl" id="addPinLabel" for="addPinInput"></label>
			<input id="addPinInput" type="text" autocomplete="off" spellcheck="false" />
			<div id="addPinErr"></div>
		</div>
		<div class="add-row">
			<label class="add-lbl" id="addModeLabel" for="addModeSelect"></label>
			<select id="addModeSelect" disabled><option value="" id="addModeEnterPin"></option></select>
		</div>
		<div id="addDlgActions">
			<button id="addDlgCancel" class="dlg-btn" style="background:transparent;border-color:#374151;color:#9ca3af"></button>
			<button id="addDlgApply" class="dlg-btn" style="background:#0f766e;border-color:#0f766e;color:#fff"></button>
		</div>
		</div>
	</div>

	<div id="dlgBackdrop" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
		<div id="dlgBox">
			<div id="dlgTitle"></div>
		<div id="dlgCur"></div>
		<input id="dlgSearch" type="search" />
		<div id="dlgGroups"></div>
		<div id="dlgActions">
			<button id="dlgCancel" class="dlg-btn"></button>
			<button id="dlgApply" class="dlg-btn" disabled></button>
		</div>
		</div>
	</div>

	<script>
		const _i18n = ${_i18nJson};
		const vscode = acquireVsCodeApi();
		const modeGroupsByPin = ${JSON.stringify(modeGroupsByPin)};
		// Apply i18n to static elements
		document.getElementById('stab-pins').textContent = _i18n.tabPins;
		document.getElementById('stab-gpio').textContent = _i18n.tabGpio;
		document.getElementById('stab-nvic').textContent = _i18n.tabNvic;
		document.getElementById('stab-dma').textContent = _i18n.tabDma;
		document.getElementById('stab-param').textContent = _i18n.tabParam;
		document.getElementById('stab-const').textContent = _i18n.tabConst;
		document.getElementById('pvTitle').textContent = _i18n.pinVisualizerTitle;
		const pvPath = document.getElementById('pvPath');
		if (!pvPath.textContent) pvPath.textContent = _i18n.noIocFile;
		document.getElementById('filterInput').placeholder = _i18n.filterPlaceholder;
		document.getElementById('filterInput').setAttribute('aria-label', _i18n.filterAriaLabel);
		document.getElementById('btnList').textContent = _i18n.listView;
		document.getElementById('btnChip').textContent = _i18n.chipView;
		document.getElementById('btnAddPin').textContent = _i18n.addPin;
		document.getElementById('btnList').setAttribute('aria-label', _i18n.listView);
		document.getElementById('btnChip').setAttribute('aria-label', _i18n.chipView);
		document.getElementById('btnAddPin').setAttribute('aria-label', _i18n.addPin);
		const pvLegend = document.getElementById('pvLegend');
		if (pvLegend) pvLegend.setAttribute('aria-label', _i18n.colorLegend);
		document.getElementById('pvHint').textContent = _i18n.pinClickHint;
		const pvEmpty = document.getElementById('pvEmpty');
		if (pvEmpty) pvEmpty.textContent = _i18n.noIocOrPins;
		document.getElementById('zoomIn').title = _i18n.zoomIn;
		document.getElementById('zoomIn').setAttribute('aria-label', _i18n.zoomIn);
		document.getElementById('zoomOut').title = _i18n.zoomOut;
		document.getElementById('zoomOut').setAttribute('aria-label', _i18n.zoomOut);
		document.getElementById('zoomReset').textContent = _i18n.reset;
		document.getElementById('zoomReset').title = _i18n.reset;
		document.getElementById('zoomReset').setAttribute('aria-label', _i18n.reset);
		// GPIO tab
		document.getElementById('gpioTitle').textContent = _i18n.gpioDetailTitle;
		const thGpioPin = document.getElementById('thGpioPin'); if(thGpioPin) thGpioPin.textContent = _i18n.gpioPin;
		const thGpioMode = document.getElementById('thGpioMode'); if(thGpioMode) thGpioMode.textContent = _i18n.gpioMode;
		const thGpioLabel = document.getElementById('thGpioLabel'); if(thGpioLabel) thGpioLabel.textContent = _i18n.gpioUserLabel;
		const gpioEmpty = document.getElementById('gpioEmpty'); if(gpioEmpty) gpioEmpty.textContent = _i18n.gpioEmpty;
		// NVIC tab
		document.getElementById('nvicTitle').textContent = _i18n.nvicTitle;
		const thNvicIrq = document.getElementById('thNvicIrq'); if(thNvicIrq) thNvicIrq.textContent = _i18n.nvicIrq;
		const thNvicEnabled = document.getElementById('thNvicEnabled'); if(thNvicEnabled) thNvicEnabled.textContent = _i18n.nvicEnabled;
		const nvicEmptyEl = document.getElementById('nvicEmpty'); if(nvicEmptyEl) nvicEmptyEl.textContent = _i18n.nvicEmpty;
		// DMA tab
		document.getElementById('dmaTitle').textContent = _i18n.dmaTitle;
		const thDmaKey = document.getElementById('thDmaKey'); if(thDmaKey) thDmaKey.textContent = _i18n.dmaKey;
		const thDmaValue = document.getElementById('thDmaValue'); if(thDmaValue) thDmaValue.textContent = _i18n.dmaValue;
		const dmaEmptyEl = document.getElementById('dmaEmpty'); if(dmaEmptyEl) dmaEmptyEl.textContent = _i18n.dmaEmpty;
		// Param tab
		document.getElementById('paramTitle').textContent = _i18n.paramTitle;
		const paramEmptyEl = document.getElementById('paramEmptyP'); if(paramEmptyEl) paramEmptyEl.textContent = _i18n.paramEmpty;
		// Const tab
		document.getElementById('constTitle').textContent = _i18n.constTitle;
		const thConstName = document.getElementById('thConstName'); if(thConstName) thConstName.textContent = _i18n.constName;
		const thConstValue = document.getElementById('thConstValue'); if(thConstValue) thConstValue.textContent = _i18n.constValue;
		document.getElementById('addConst').textContent = _i18n.addConst;
		// Save button labels
		for (const id of ['saveGpio','saveNvic','saveDma','saveParam','saveConst']) {
			const btn = document.getElementById(id); if (btn) btn.textContent = '💾 ' + _i18n.save;
		}
		// Add/Edit pin dialogs
		document.getElementById('addDlgTitle').textContent = _i18n.addPinTitle;
		document.getElementById('addPinLabel').textContent = _i18n.addPinLabel;
		document.getElementById('addPinInput').placeholder = _i18n.addPinPlaceholder;
		document.getElementById('addModeLabel').textContent = _i18n.modeLabel;
		document.getElementById('addModeEnterPin').textContent = _i18n.enterPinFirst;
		document.getElementById('addDlgCancel').textContent = _i18n.cancel;
		document.getElementById('addDlgApply').textContent = _i18n.add;
		document.getElementById('dlgTitle').textContent = _i18n.editPinTitle;
		document.getElementById('dlgCur').textContent = _i18n.currentModeNone;
		document.getElementById('dlgSearch').placeholder = _i18n.modeSearch;
		document.getElementById('dlgSearch').setAttribute('aria-label', _i18n.modeSearchAriaLabel);
		document.getElementById('dlgCancel').textContent = _i18n.cancel;
		document.getElementById('dlgApply').textContent = _i18n.apply;
		// Update pin count display
		const pinCountEl = document.getElementById('pinCount');
		if (pinCountEl) pinCountEl.textContent = pinCountEl.textContent.trim() + ' ' + _i18n.pinCount.replace('{0}', '').trim();

		// ---- Settings tab switching ----
		const stabBtns = document.querySelectorAll('.stab-btn');
		const stabPanels = document.querySelectorAll('.stab-panel');
		for (const btn of stabBtns) {
			btn.addEventListener('click', () => {
				const targetId = btn.dataset.show;
				for (const b of stabBtns) { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); }
				for (const p of stabPanels) { p.classList.remove('active'); }
				btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
				const panel = document.getElementById(targetId);
				if (panel) { panel.classList.add('active'); }
			});
		}

		// ---- Settings save helpers ----
		function collectLines(panel) {
			const lines = [];
			for (const el of panel.querySelectorAll('.s-sel,.s-inp,.s-num')) {
				if (el.dataset.key) { lines.push({ key: el.dataset.key, value: el.value.trim() }); }
			}
			for (const el of panel.querySelectorAll('.s-chk')) {
				if (el.dataset.key) { lines.push({ key: el.dataset.key, value: el.checked ? (el.dataset.on || 'ENABLE') : (el.dataset.off || 'DISABLE') }); }
			}
			return lines;
		}
		function removeIocKey(key) {
			if (confirm(_i18n.confirmDeleteKey.replace('{0}', key))) {
				vscode.postMessage({ type: 'removeIocKey', key });
			}
		}

		const saveGpioEl = document.getElementById('saveGpio');
		if (saveGpioEl) {
			saveGpioEl.addEventListener('click', () => {
				const lines = collectLines(document.getElementById('tab-gpio'));
				if (lines.length) { vscode.postMessage({ type: 'applyIocLines', lines }); }
			});
		}
		const saveNvicEl = document.getElementById('saveNvic');
		if (saveNvicEl) {
			saveNvicEl.addEventListener('click', () => {
				const lines = collectLines(document.getElementById('tab-nvic'));
				if (lines.length) { vscode.postMessage({ type: 'applyIocLines', lines }); }
			});
		}
		const saveDmaEl = document.getElementById('saveDma');
		if (saveDmaEl) {
			saveDmaEl.addEventListener('click', () => {
				const lines = collectLines(document.getElementById('tab-dma'));
				if (lines.length) { vscode.postMessage({ type: 'applyIocLines', lines }); }
			});
		}
		for (const btn of document.querySelectorAll('#tab-dma .s-del-btn')) {
			btn.addEventListener('click', () => { if (btn.dataset.removekey) { removeIocKey(btn.dataset.removekey); } });
		}
		const saveParamEl = document.getElementById('saveParam');
		if (saveParamEl) {
			saveParamEl.addEventListener('click', () => {
				const lines = collectLines(document.getElementById('tab-param'));
				if (lines.length) { vscode.postMessage({ type: 'applyIocLines', lines }); }
			});
		}
		for (const btn of document.querySelectorAll('#tab-param .s-del-btn')) {
			btn.addEventListener('click', () => { if (btn.dataset.removekey) { removeIocKey(btn.dataset.removekey); } });
		}

		// User constants
		let constRowIdx = ${iocSettings.userConstants.length};
		function addConstRow(name, value) {
			const tbody = document.getElementById('constBody');
			if (!tbody) { return; }
			const tr = document.createElement('tr');
			const idx = constRowIdx++;
			tr.innerHTML = '<td><input class="s-inp s-const-name" type="text" value="' + (name || '').replace(/"/g, '&quot;') + '" placeholder="' + (_i18n.constNamePlaceholder || '') + '" /></td>' +
				'<td><input class="s-inp s-const-val" type="text" value="' + (value || '').replace(/"/g, '&quot;') + '" placeholder="' + (_i18n.constValuePlaceholder || '') + '" /></td>' +
				'<td><button class="s-del-btn s-const-del">✕</button></td>';
			tr.querySelector('.s-const-del').addEventListener('click', () => tbody.removeChild(tr));
			tbody.appendChild(tr);
		}
		for (const btn of document.querySelectorAll('#constBody .s-const-del')) {
			btn.addEventListener('click', () => btn.closest('tr').remove());
		}
		const addConstEl = document.getElementById('addConst');
		if (addConstEl) { addConstEl.addEventListener('click', () => addConstRow('', '')); }
		const saveConstEl = document.getElementById('saveConst');
		if (saveConstEl) {
			saveConstEl.addEventListener('click', () => {
				const parts = [];
				for (const tr of document.querySelectorAll('#constBody tr')) {
					const n = tr.querySelector('.s-const-name')?.value.trim();
					const v = tr.querySelector('.s-const-val')?.value.trim();
					if (n) { parts.push(n + ':' + (v || '')); }
				}
				vscode.postMessage({ type: 'applyIocLine', key: 'ProjectManager.UserConstants', value: parts.join(',') });
			});
		}

		// ---- Pin Visualizer ----
		for (const btn of document.querySelectorAll('.pin-card')) {
			btn.addEventListener('click', () => {
				if (btn.dataset.editable !== '1') { return; }
				vscode.postMessage({ type: 'editPin', pin: btn.dataset.pin });
			});
			btn.addEventListener('keydown', e => {
				if (btn.dataset.editable !== '1') { return; }
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vscode.postMessage({ type: 'editPin', pin: btn.dataset.pin }); }
			});
		}
		for (const g of document.querySelectorAll('.lqfp-pin')) {
			g.addEventListener('click', () => {
				if (g.dataset.editable !== '1') { return; }
				vscode.postMessage({ type: 'editPin', pin: g.dataset.pin });
			});
			g.addEventListener('keydown', e => {
				if (g.dataset.editable !== '1') { return; }
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vscode.postMessage({ type: 'editPin', pin: g.dataset.pin }); }
			});
		}

		// ---- zoom ----
		const chipSvgEl = document.getElementById('chipSvg');
		const chipWrap = document.getElementById('chipWrap');
		const zoomLabel = document.getElementById('zoomLabel');
		let zoom = 1;
		const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
		function applyZoom(z) {
			zoom = Math.max(0.25, Math.min(4, z));
			chipSvgEl.style.transform = 'scale(' + zoom + ')';
			chipSvgEl.style.transformOrigin = 'top left';
			zoomLabel.textContent = Math.round(zoom * 100) + '%';
		}
		document.getElementById('zoomIn').addEventListener('click', () => {
			const idx = ZOOM_STEPS.findIndex(z => z > zoom);
			applyZoom(idx >= 0 ? ZOOM_STEPS[idx] : 4);
		});
		document.getElementById('zoomOut').addEventListener('click', () => {
			const idx = [...ZOOM_STEPS].reverse().findIndex(z => z < zoom);
			applyZoom(idx >= 0 ? [...ZOOM_STEPS].reverse()[idx] : 0.25);
		});
		document.getElementById('zoomReset').addEventListener('click', () => applyZoom(1));
		if (chipWrap) {
			chipWrap.addEventListener('wheel', e => {
				e.preventDefault();
				applyZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
			}, { passive: false });
		}

		// ---- tooltip ----
		const tooltip = document.getElementById('pinTooltip');
		const ttNum = tooltip.querySelector('.tt-num');
		const ttPin = tooltip.querySelector('.tt-pin');
		const ttMode = tooltip.querySelector('.tt-mode');
		function showTip(e, g) {
			ttNum.textContent = 'Pin #' + (g.dataset.num || '');
			ttPin.textContent = g.dataset.pin || '';
			ttMode.textContent = g.dataset.mode || '';
			tooltip.style.display = 'block';
			positionTip(e);
		}
		function positionTip(e) {
			const x = e.clientX + 14, y = e.clientY + 14;
			tooltip.style.left = (x + tooltip.offsetWidth > window.innerWidth ? x - tooltip.offsetWidth - 28 : x) + 'px';
			tooltip.style.top = (y + tooltip.offsetHeight > window.innerHeight ? y - tooltip.offsetHeight - 28 : y) + 'px';
		}
		for (const g of document.querySelectorAll('.lqfp-pin')) {
			g.addEventListener('mouseenter', e => showTip(e, g));
			g.addEventListener('mousemove', e => positionTip(e));
			g.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
		}

		// ---- dialog ----
		const dlgBackdrop = document.getElementById('dlgBackdrop');
		const dlgTitle = document.getElementById('dlgTitle');
		const dlgCur = document.getElementById('dlgCur');
		const dlgSearch = document.getElementById('dlgSearch');
		const dlgGroups = document.getElementById('dlgGroups');
		const dlgApply = document.getElementById('dlgApply');
		const dlgCancel = document.getElementById('dlgCancel');
		let dlgPin = '', dlgSelected = '';

		function openDialog(pin, currentMode, groups) {
			dlgPin = pin; dlgSelected = '';
			dlgTitle.textContent = 'Edit Pin — ' + pin;
			dlgCur.textContent = 'Current mode: ' + (currentMode || 'not set');
			dlgSearch.value = '';
			dlgApply.disabled = true;
			dlgGroups.innerHTML = '';
			for (const [grpName, modes] of Object.entries(groups)) {
				const sec = document.createElement('div');
				sec.className = 'dg-section';
				sec.dataset.grp = grpName;
				const hd = document.createElement('div');
				hd.className = 'dg-hd'; hd.textContent = grpName;
				const chips = document.createElement('div');
				chips.className = 'dg-chips';
				for (const mode of modes) {
					const chip = document.createElement('button');
					chip.className = 'dg-chip' + (mode === currentMode ? ' current' : '');
					chip.textContent = mode; chip.dataset.mode = mode;
					chip.addEventListener('click', () => {
						dlgGroups.querySelectorAll('.dg-chip.selected').forEach(c => c.classList.remove('selected'));
						chip.classList.add('selected');
						dlgSelected = mode;
						dlgApply.disabled = false;
					});
					chips.appendChild(chip);
				}
				sec.appendChild(hd); sec.appendChild(chips);
				dlgGroups.appendChild(sec);
			}
			dlgBackdrop.classList.add('open');
			setTimeout(() => dlgSearch.focus(), 60);
		}

		function closeDialog() { dlgBackdrop.classList.remove('open'); }
		function closeAddDialog() { document.getElementById('addDlgBackdrop').classList.remove('open'); }
		dlgCancel.addEventListener('click', closeDialog);
		dlgBackdrop.addEventListener('click', e => { if (e.target === dlgBackdrop) { closeDialog(); } });
		document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDialog(); closeAddDialog(); } });
		dlgApply.addEventListener('click', () => {
			if (!dlgSelected) { return; }
			vscode.postMessage({ type: 'applyPin', pin: dlgPin, mode: dlgSelected });
			closeDialog();
		});
		dlgSearch.addEventListener('input', () => {
			const q = dlgSearch.value.trim().toLowerCase();
			for (const sec of dlgGroups.querySelectorAll('.dg-section')) {
				let vis = 0;
				for (const chip of sec.querySelectorAll('.dg-chip')) {
					const show = !q || chip.dataset.mode.toLowerCase().includes(q);
					chip.classList.toggle('chip-hidden', !show);
					if (show) { vis++; }
				}
				sec.classList.toggle('hidden', vis === 0);
			}
		});
		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg && msg.type === 'openDialog') { openDialog(msg.pin, msg.currentMode, msg.groups); }
		});

		// ---- add pin dialog ----
		const addDlgBackdrop = document.getElementById('addDlgBackdrop');
		const addPinInput = document.getElementById('addPinInput');
		const addPinErr = document.getElementById('addPinErr');
		const addModeSelect = document.getElementById('addModeSelect');
		const addDlgApply = document.getElementById('addDlgApply');
		const addDlgCancel = document.getElementById('addDlgCancel');
		const PIN_RE = /^P[A-Ka-k][0-9]{1,2}$/;
		function fillAddModeOptions(groups) {
			addModeSelect.innerHTML = '';
			let count = 0;
			for (const [grp, modes] of Object.entries(groups || {})) {
				const og = document.createElement('optgroup');
				og.label = grp;
				for (const mode of modes) {
					const opt = document.createElement('option');
					opt.value = mode;
					opt.textContent = mode;
					og.appendChild(opt);
					count++;
				}
				addModeSelect.appendChild(og);
			}
			if (count === 0) {
				addModeSelect.innerHTML = '<option value="">No modes available</option>';
				addModeSelect.disabled = true;
			} else {
				addModeSelect.disabled = false;
			}
		}
		function openAddDialog() {
			addPinInput.value = ''; addPinErr.textContent = '';
			addPinInput.classList.remove('invalid');
			addModeSelect.innerHTML = '<option value="">Enter a pin first</option>';
			addModeSelect.disabled = true;
			addDlgBackdrop.classList.add('open');
			setTimeout(() => addPinInput.focus(), 60);
		}
		document.getElementById('btnAddPin').addEventListener('click', openAddDialog);
		addDlgCancel.addEventListener('click', closeAddDialog);
		addDlgBackdrop.addEventListener('click', e => { if (e.target === addDlgBackdrop) { closeAddDialog(); } });
		addPinInput.addEventListener('input', () => {
			const pin = addPinInput.value.trim().toUpperCase();
			const ok = PIN_RE.test(pin);
			addPinInput.classList.toggle('invalid', addPinInput.value.length > 0 && !ok);
			addPinErr.textContent = (addPinInput.value.length > 0 && !ok) ? 'Format error: enter in PA0–PK15 format' : '';
			if (!ok) {
				addModeSelect.innerHTML = '<option value="">Enter a valid pin</option>';
				addModeSelect.disabled = true;
				return;
			}
			const localGroups = modeGroupsByPin[pin];
			if (localGroups) {
				fillAddModeOptions(localGroups);
			}
			vscode.postMessage({ type: 'requestPinModes', pin });
		});
		addDlgApply.addEventListener('click', () => {
			const pin = addPinInput.value.trim().toUpperCase();
			if (!PIN_RE.test(pin)) { addPinErr.textContent = 'Enter a valid pin name.'; addPinInput.classList.add('invalid'); return; }
			if (!addModeSelect.value) { addPinErr.textContent = 'Select an available mode for this pin.'; return; }
			vscode.postMessage({ type: 'addPin', pin, mode: addModeSelect.value });
			closeAddDialog();
		});

		// ---- Pin filter + list/chip view toggle ----
		const filterInput = document.getElementById('filterInput');
		const pinCountEl = document.getElementById('pinCount');
		const groupsView = document.getElementById('groupsView');
		const chipView = document.getElementById('chipView');
		const btnList = document.getElementById('btnList');
		const btnChip = document.getElementById('btnChip');
		const hasChipPins = document.querySelectorAll('.lqfp-pin').length > 0;
		const shouldStartList = document.querySelectorAll('.pin-card').length > 120;
		if (!hasChipPins) {
			groupsView.style.display = ''; chipView.style.display = 'none';
			btnList.classList.add('active'); btnList.setAttribute('aria-pressed', 'true');
			btnChip.classList.remove('active'); btnChip.setAttribute('aria-pressed', 'false');
			btnChip.disabled = true;
		} else if (shouldStartList) {
			groupsView.style.display = ''; chipView.style.display = 'none';
			btnList.classList.add('active'); btnList.setAttribute('aria-pressed', 'true');
			btnChip.classList.remove('active'); btnChip.setAttribute('aria-pressed', 'false');
		}
		btnList.addEventListener('click', () => {
			groupsView.style.display = ''; chipView.style.display = 'none';
			btnList.classList.add('active'); btnList.setAttribute('aria-pressed', 'true');
			btnChip.classList.remove('active'); btnChip.setAttribute('aria-pressed', 'false');
		});
		btnChip.addEventListener('click', () => {
			groupsView.style.display = 'none'; chipView.style.display = '';
			btnChip.classList.add('active'); btnChip.setAttribute('aria-pressed', 'true');
			btnList.classList.remove('active'); btnList.setAttribute('aria-pressed', 'false');
		});
		function applyFilter(q) {
			let visible = 0;
			for (const group of document.querySelectorAll('.port-group')) {
				let groupVisible = 0;
				for (const card of group.querySelectorAll('.pin-card')) {
					const search = (card.dataset.search || '').toLowerCase();
					const show = !q || search.includes(q);
					card.style.display = show ? '' : 'none';
					if (show) { groupVisible++; visible++; }
				}
				group.classList.toggle('hidden', groupVisible === 0);
			}
			const hasQ = q.length > 0;
			for (const g of document.querySelectorAll('.lqfp-pin')) {
				const search = (g.dataset.search || ((g.dataset.pin || '') + ' ' + (g.dataset.mode || ''))).toLowerCase();
				const matches = !hasQ || search.includes(q);
				g.classList.toggle('dim', hasQ && !matches);
				g.classList.toggle('match', hasQ && matches);
			}
			pinCountEl.textContent = q ? visible + ' pins (filtered)' : visible + ' pins';
		}
		filterInput.addEventListener('input', () => applyFilter(filterInput.value.trim().toLowerCase()));
		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg && msg.type === 'setAddPinModes' && typeof msg.pin === 'string' && msg.pin === addPinInput.value.trim().toUpperCase()) {
				fillAddModeOptions(msg.groups || {});
			}
		});
	</script>
</body>
</html>`;
}

function colorForMode(mode: string): string {
	const value = mode.toLowerCase();
	if (value === 'unused') { return '#1a1d2e'; }
	if (value.includes('gpio_output')) { return '#0f4c5c'; }
	if (value.includes('gpio_input')) { return '#1a4731'; }
	if (value.includes('swdio') || value.includes('swclk') || value.includes('sys_sw')) { return '#3b1f6e'; }
	if (value.includes('rcc_osc') || value.includes('osc')) { return '#1a3a2e'; }
	if (value.includes('usart') || value.includes('uart') || value.includes('lpuart')) { return '#7c3a00'; }
	if (value.includes('i2c')) { return '#6d1a4c'; }
	if (value.includes('spi') || value.includes('i2s')) { return '#1f4d7a'; }
	if (value.includes('adc') || value.includes('dac')) { return '#7c1d1d'; }
	if (value.includes('tim') || value.includes('pwm')) { return '#1a3050'; }
	if (value.includes('can')) { return '#3d2800'; }
	if (value.includes('usb')) { return '#1a3d3d'; }
	return '#1e2030';
}

function colorForModeBorder(mode: string): string {
	const value = mode.toLowerCase();
	if (value === 'unused') { return '#374151'; }
	if (value.includes('gpio_output')) { return '#14b8a6'; }
	if (value.includes('gpio_input')) { return '#22c55e'; }
	if (value.includes('swdio') || value.includes('swclk') || value.includes('sys_sw')) { return '#a78bfa'; }
	if (value.includes('rcc_osc') || value.includes('osc')) { return '#34d399'; }
	if (value.includes('usart') || value.includes('uart') || value.includes('lpuart')) { return '#f59e0b'; }
	if (value.includes('i2c')) { return '#ec4899'; }
	if (value.includes('spi') || value.includes('i2s')) { return '#38bdf8'; }
	if (value.includes('adc') || value.includes('dac')) { return '#ef4444'; }
	if (value.includes('tim') || value.includes('pwm')) { return '#3b82f6'; }
	if (value.includes('can')) { return '#fb923c'; }
	if (value.includes('usb')) { return '#2dd4bf'; }
	return '#4b5563';
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
