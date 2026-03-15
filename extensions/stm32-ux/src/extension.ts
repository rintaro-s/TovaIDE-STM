/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;
declare const process: { platform: string };

const childProcess = require('child_process') as {
	execFile: (command: string, args: string[], options: { cwd?: string; shell?: boolean }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
};
const pathModule = require('path') as {
	dirname: (path: string) => string;
	join: (...parts: string[]) => string;
	resolve: (...parts: string[]) => string;
};

const CUBEMX_MCU_CATALOG_KEY = 'stm32ux.cubemxMcuCatalog';
const CUBEMX_BOARD_CATALOG_KEY = 'stm32ux.cubemxBoardCatalog';
let extensionContextRef: vscode.ExtensionContext;

interface ExecFileResult {
	stdout: string;
	stderr: string;
}

interface TemplateDefinition {
	name: string;
	category: string;
	mcu: string;
	pinModes: Array<{ pin: string; mode: string }>;
	userCodeLines: string[];
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
		description: '汎用評価ボード。初学者向け。',
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PA2', mode: 'USART2_TX' }, { pin: 'PA3', mode: 'USART2_RX' }]
	},
	{
		id: 'nucleo-l476rg',
		name: 'Nucleo-L476RG',
		mcu: 'STM32L476RGTx',
		description: '低消費電力向け。',
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PB6', mode: 'I2C1_SCL' }, { pin: 'PB7', mode: 'I2C1_SDA' }]
	},
	{
		id: 'nucleo-g071rb',
		name: 'Nucleo-G071RB',
		mcu: 'STM32G071RBTx',
		description: 'コスト重視の量産向け。',
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PA9', mode: 'USART1_TX' }, { pin: 'PA10', mode: 'USART1_RX' }]
	},
	{
		id: 'bluepill-f103c8',
		name: 'BluePill-F103C8',
		mcu: 'STM32F103C8Tx',
		description: '手軽なF1系評価基板。',
		defaultPins: [{ pin: 'PC13', mode: 'GPIO_Output' }, { pin: 'PA9', mode: 'USART1_TX' }, { pin: 'PA10', mode: 'USART1_RX' }]
	},
	{
		id: 'nucleo-h743zi',
		name: 'Nucleo-H743ZI',
		mcu: 'STM32H743ZITx',
		description: '高性能H7向け。',
		defaultPins: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PB13', mode: 'SPI2_SCK' }, { pin: 'PB14', mode: 'SPI2_MISO' }, { pin: 'PB15', mode: 'SPI2_MOSI' }]
	}
];

const TUTORIAL_STEPS = [
	'1. MCUを選択: タイトルバーのMCUセレクタで対象デバイスを選びます。',
	'2. 新規プロジェクト: コマンドパレットから STM32: 新規プロジェクト を実行します。',
	'3. ピン設定: PA5 を GPIO_Output に設定して LED ピンを割り当てます。',
	'4. コード再生成: ioc からコード再生成を実行します。',
	'5. USER CODE にLチカコードを記述します。',
	'6. Debugビルドを実行してエラーを解消します。',
	'7. 書込みを実行して LED 点滅を確認します。'
];


const PIN_MODE_GROUPS: Record<string, string[]> = {
	'GPIO': ['GPIO_Output', 'GPIO_Input', 'GPIO_Analog', 'Reset_State'],
	'UART/USART': ['USART1_TX', 'USART1_RX', 'USART2_TX', 'USART2_RX', 'USART3_TX', 'USART3_RX', 'UART4_TX', 'UART4_RX', 'LPUART1_TX', 'LPUART1_RX'],
	'I2C': ['I2C1_SCL', 'I2C1_SDA', 'I2C2_SCL', 'I2C2_SDA', 'I2C3_SCL', 'I2C3_SDA'],
	'SPI': ['SPI1_SCK', 'SPI1_MISO', 'SPI1_MOSI', 'SPI1_NSS', 'SPI2_SCK', 'SPI2_MISO', 'SPI2_MOSI', 'SPI2_NSS', 'SPI3_SCK', 'SPI3_MISO', 'SPI3_MOSI', 'SPI3_NSS'],
	'ADC': ['ADC1_IN0', 'ADC1_IN1', 'ADC1_IN2', 'ADC1_IN3', 'ADC1_IN4', 'ADC1_IN5', 'ADC1_IN6', 'ADC1_IN7', 'ADC2_IN0', 'ADC2_IN1'],
	'TIM/PWM': ['TIM1_CH1', 'TIM1_CH2', 'TIM1_CH3', 'TIM1_CH4', 'TIM2_CH1', 'TIM2_CH2', 'TIM2_CH3', 'TIM2_CH4', 'TIM3_CH1', 'TIM3_CH2', 'TIM3_CH3', 'TIM3_CH4', 'TIM4_CH1', 'TIM4_CH2', 'TIM4_CH3', 'TIM4_CH4'],
	'その他': ['CAN1_TX', 'CAN1_RX', 'USB_DM', 'USB_DP', 'ETH_MDC', 'ETH_MDIO', 'SDIO_D0', 'SDIO_CLK', 'SDIO_CMD'],
};

let outputChannel: vscode.OutputChannel;
let extensionUri: vscode.Uri;

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('STM32 UX');
	extensionUri = context.extensionUri;
	extensionContextRef = context;
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('stm32-ux.onboardingView', new OnboardingViewProvider()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openWorkflowStudio', () => openWorkflowStudio()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openWelcomeWizard', () => openWelcomeWizard()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openMcpOperationDesk', () => openMcpOperationDesk()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.syncMcuCatalogFromCubeMX', () => syncMcuCatalogFromCubeMX()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.startBlinkTutorial', () => openBlinkTutorial()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openTemplateGallery', () => openTemplateGallery()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openBoardConfigurator', () => openBoardConfigurator()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.runEnvironmentCheck', () => runEnvironmentCheck()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.explainLatestError', () => explainLatestError()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openPinVisualizer', () => openPinVisualizer()));

	const shouldOpenWelcome = vscode.workspace.getConfiguration('stm32ux').get<boolean>('autoOpenWelcome', true);
	if (shouldOpenWelcome) {
		void openWelcomeWizard();
	}
}

export function deactivate(): void {
}

class OnboardingViewProvider implements vscode.WebviewViewProvider {
	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getOnboardingHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async message => {
			if (!isRecord(message) || typeof message.type !== 'string') {
				return;
			}
			switch (message.type) {
				case 'studio':
					await openWorkflowStudio();
					break;
				case 'mcp':
					await openMcpOperationDesk();
					break;
				case 'collab':
					await vscode.commands.executeCommand('stm32collab.openPanel');
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
				case 'welcome':
					await openWelcomeWizard();
					break;
				case 'board':
					await openBoardConfigurator();
					break;
				case 'tutorial':
					await openBlinkTutorial();
					break;
				case 'templates':
					await openTemplateGallery();
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
			}
		});
	}
}

async function openWorkflowStudio(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.workflowStudio', 'STM32 ワークフロースタジオ', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getWorkflowStudioHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}

		switch (message.type) {
			case 'create':
				await openBoardConfigurator();
				break;
			case 'syncCatalog':
				await syncMcuCatalogFromCubeMX();
				break;
			case 'coding':
				await vscode.commands.executeCommand('stm32.openCommandCenter');
				break;
			case 'settings':
				await runEnvironmentCheck();
				break;
			case 'tutorial':
				await openBlinkTutorial();
				break;
			case 'pins':
				await openPinVisualizer();
				break;
		}
	});
}

async function openMcpOperationDesk(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.mcpDesk', 'STM32 MCP オペレーションデスク', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getMcpOperationDeskHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}

		const run = async (method: string, params?: Record<string, unknown>): Promise<void> => {
			await vscode.commands.executeCommand('stm32ai.startMcpServer');
			const payload = params
				? JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
				: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method });
			const result = await vscode.window.showInputBox({
				title: vscode.l10n.t('MCP 呼び出し JSON (実行済み)'),
				value: payload,
				prompt: vscode.l10n.t('下記 JSON は MCP クライアントから同等に実行できます。')
			});
			if (typeof result === 'string') {
				void result;
			}
		};

		switch (message.type) {
			case 'startMcp':
				await vscode.commands.executeCommand('stm32ai.startMcpServer');
				break;
			case 'stopMcp':
				await vscode.commands.executeCommand('stm32ai.stopMcpServer');
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
			case 'collab':
				await run('stm32.collab.openPanel');
				await vscode.commands.executeCommand('stm32collab.openPanel');
				break;
			case 'svd':
				await run('stm32.refreshRegisters');
				await vscode.commands.executeCommand('stm32.debug.refreshRegisters');
				break;
		}
	});
}

async function openWelcomeWizard(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.welcome', 'TovaIDE-STM ウェルカム', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getWelcomeHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'studio':
				await openWorkflowStudio();
				break;
			case 'syncCatalog':
				await syncMcuCatalogFromCubeMX();
				break;
			case 'board':
				await openBoardConfigurator();
				break;
			case 'tutorial':
				await openBlinkTutorial();
				break;
			case 'import':
				await vscode.commands.executeCommand('stm32.importCubeIDE');
				break;
			case 'templates':
				await openTemplateGallery();
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
		}
	});
}

async function openBlinkTutorial(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.tutorial', 'STM32 Lチカチュートリアル', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getTutorialHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}
		if (message.type === 'runBuild') {
			await vscode.commands.executeCommand('stm32.buildDebug');
		}
		if (message.type === 'runFlash') {
			await vscode.commands.executeCommand('stm32.flash');
		}
		if (message.type === 'openPin') {
			await openPinVisualizer();
		}
		if (message.type === 'complete') {
			panel.dispose();
			vscode.window.showInformationMessage(
				vscode.l10n.t('🎉 チュートリアル完了！STM32 Lチカをマスターしました。'),
				vscode.l10n.t('テンプレートを探す')
			).then(choice => {
				if (choice === vscode.l10n.t('テンプレートを探す')) {
					void openTemplateGallery();
				}
			});
		}
	});
}

async function openTemplateGallery(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.templates', 'STM32 テンプレートギャラリー', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getTemplateGalleryHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.template !== 'string') {
			return;
		}
		const selected = message.template;
		const action = await vscode.window.showInformationMessage(vscode.l10n.t('テンプレート選択: {0}', selected), vscode.l10n.t('新規プロジェクト作成'));
		if (action === vscode.l10n.t('新規プロジェクト作成')) {
			await createProjectFromTemplate(selected);
		}
	});
}

async function openBoardConfigurator(): Promise<void> {
	const profiles = await getBoardProfilesFromCatalog();
	const mcuNames = await getMcuSelectorNamesFromCatalog(profiles);
	if (profiles.length === 0 && mcuNames.length === 0) {
		vscode.window.showErrorMessage(vscode.l10n.t('利用可能なMCU定義が見つかりません。resources/stm32/mcu を確認してください。'));
		return;
	}

	const panel = vscode.window.createWebviewPanel('stm32ux.boardConfigurator', 'TovaIDE-STM ボード設定スタジオ', vscode.ViewColumn.Active, { enableScripts: true });
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
				vscode.window.showErrorMessage(vscode.l10n.t('Board を選択してください。'));
				return;
			}
		} else {
			if (mcuName.length === 0) {
				vscode.window.showErrorMessage(vscode.l10n.t('MCU/MPU Selector から Commercial Part Number を選択してください。'));
				return;
			}
			const matched = profiles.find(item => normalizeMcuKey(item.mcu) === normalizeMcuKey(mcuName));
			profile = matched ?? {
				id: `mcu-${mcuName.toLowerCase()}`,
				name: `MCU/MPU Selector (${mcuName})`,
				mcu: mcuName,
				description: 'MCU/MPU Selector で選択した CPN から生成',
				defaultPins: []
			};
		}

		if (projectName.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t('プロジェクト名を入力してください。'));
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
		rows.push(`- STM32CubeMX: ${exists ? `✅ ${configuredCubeMx}` : `❌ 設定パスが無効: ${configuredCubeMx}`}`);
	} else {
		const foundPath = await resolveCommandPath('STM32CubeMX', workspaceRoot);
		rows.push(`- STM32CubeMX: ${foundPath ? `✅ ${foundPath}` : '❌ 未検出'}`);
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
		rows.push(`- STM32CubeCLT_metadata: ${exists ? `✅ ${configuredMetadata}` : `❌ 設定パスが無効: ${configuredMetadata}`}`);
	} else {
		const foundPath = await resolveCommandPath('STM32CubeCLT_metadata', workspaceRoot);
		rows.push(`- STM32CubeCLT_metadata: ${foundPath ? `✅ ${foundPath}` : '❌ 未検出'}`);
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
			rows.push(`- ${tool.id}: ✅ ${inferredToolPaths.programmerCliPath} (CubeCLT メタデータから推定)`);
			continue;
		}

		if (tool.id === 'arm-none-eabi-gcc' && inferredToolPaths.gccPath) {
			rows.push(`- ${tool.id}: ✅ ${inferredToolPaths.gccPath} (CubeCLT メタデータから推定)`);
			continue;
		}

		rows.push(`- ${tool.id}: ❌ 未検出 (PATH に含まれていません)`);
	}

	const report = [
		'# STM32 環境チェック',
		'',
		'## ツール検出',
		...rows,
		'',
		'## 設定値',
		`- stm32.cubemx.path: ${configuredCubeMx.length > 0 ? configuredCubeMx : '(未設定)'}`,
		`- stm32.cubeclt.metadataPath: ${configuredMetadata.length > 0 ? configuredMetadata : '(未設定)'}`,
		'',
		'## ヒント',
		'- STM32_Programmer_CLI / arm-none-eabi-gcc が PATH に無くても、CubeCLT メタデータパスから推定検出される場合があります',
		'- PATH に通しておくと、外部ターミナルやビルドタスクでも同じ実行ファイルを利用できます',
		'- コマンドパレット: `STM32: CubeCLT メタデータを検出`',
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
		vscode.window.showInformationMessage(vscode.l10n.t('現在エラーは検出されていません。'));
		return;
	}

	const message = firstError.item.message;
	const hint = getErrorHint(message);
	const doc = await vscode.workspace.openTextDocument({
		language: 'markdown',
		content: [
			'# ビルドエラー自動解説',
			'',
			`- ファイル: ${firstError.uri.fsPath}`,
			`- 行: ${firstError.item.range.start.line + 1}`,
			`- エラー: ${message}`,
			'',
			`## 解説`,
			hint,
		].join('\n')
	});
	await vscode.window.showTextDocument(doc, { preview: false });
}

function detectMcuFromIocText(iocText: string): string {
	const match = iocText.match(/^Mcu\.Name=([^\r\n]+)/m);
	if (!match) { return 'STM32F446RE'; }
	const raw = match[1].trim();
	const normalized = raw
		.replace(/Tx$/, '')
		.replace(/x$/, '');
	for (const known of ['STM32H743ZI', 'STM32H743', 'STM32L476RG', 'STM32L476', 'STM32WB55RG', 'STM32WB55', 'STM32F446RE', 'STM32F446', 'STM32F103C8', 'STM32F103', 'STM32G071RB', 'STM32G071', 'STM32U575RI', 'STM32U575', 'STM32C031C6', 'STM32C031']) {
		if (normalized.toUpperCase().startsWith(known.toUpperCase())) {
			return known;
		}
	}
	return normalized.length > 4 ? normalized : 'STM32F446RE';
}

function normalizeMcuKey(mcuKey: string): string {
	return mcuKey
		.trim()
		.replace(/\.json$/i, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

async function resolveMcuJsonName(mcuKey: string): Promise<string> {
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
	};

	const raw = normalizeMcuKey(mcuKey);
	const trimmedVariant = raw.replace(/TX$/, '').replace(/X$/, '');
	const candidates = [
		raw,
		trimmedVariant,
		map[raw],
		map[trimmedVariant],
		'STM32F446RE',
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

	return 'STM32F446RE';
}

async function loadMcuPackagePins(mcuName?: string): Promise<Array<{ pin: string; mode: string }>> {
	const fileName = await resolveMcuJsonName(mcuName ?? 'STM32F446RE');
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
		vscode.window.showErrorMessage(vscode.l10n.t('CubeMX の MCU DB が見つかりません。stm32.cubemx.path を設定して再実行してください。'));
		return;
	}

	const mcuNames = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: vscode.l10n.t('CubeMX MCU カタログを同期中...'),
		cancellable: false,
	}, async progress => {
		progress.report({ message: vscode.l10n.t('MCU 定義を走査しています') });
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
	vscode.window.showInformationMessage(vscode.l10n.t('CubeMX 同期完了: MCU {0} 件 / Board {1} 件', mcuNames.length, boardItems.length));
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
				description: `CubeMX Board DB 由来 (${boardName})`
			});
		}
	}

	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}

async function loadMcuPinDefinitions(mcuName?: string): Promise<Array<{ pin: string; mode?: string; altFunctions?: string[] }>> {
	const fileName = await resolveMcuJsonName(mcuName ?? 'STM32F446RE');
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

/** CubeMX MCU DBの db/mcu フォルダから、対象MCUに対応するXMLファイルを検索する */
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

/** "STM32F446R(C-E)Tx" のような CubeMX ファイル名パターンが指定 MCU にマッチするか */
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

/** CubeMX MCU XML から Pin → Signal名一覧 を読み込む */
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
			continue;
		}

		// Pin GPIO config: PA5-GPIO_Output.GPIO_Speed=HIGH
		const pinCfgM = key.match(/^(P[A-K][0-9]{1,2})-[^.]+\.(.+)$/);
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
		if (key.startsWith('ProjectManager.') || key.startsWith('Mcu.') || key.startsWith('File.') || key.startsWith('KeepUserPlacement')) {
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
		let group = 'その他';
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
	const panel = vscode.window.createWebviewPanel('stm32ux.pinVisualizer', 'STM32 ピンビジュアライザ', vscode.ViewColumn.Active, { enableScripts: true });
	const render = async (): Promise<void> => {
		let pins: Array<{ pin: string; mode: string }> = [];
		let detectedMcu: string | undefined;
		let iocSettings: IocFullSettings = parseFullIocSettings('');
		if (iocUri) {
			const bytes = await vscode.workspace.fs.readFile(iocUri);
			let text = '';
			for (const value of bytes) {
				text += String.fromCharCode(value);
			}
			const configuredPins = parsePinLines(text);
			detectedMcu = detectMcuFromIocText(text);
			const totalPins = getPackagePinCount(text, detectedMcu);
			pins = buildFullPackagePins(configuredPins, totalPins);
			iocSettings = parseFullIocSettings(text);
			panel.title = `STM32 ピンビジュアライザ — ${detectedMcu} (${totalPins} pin)`;
		} else {
			const fallback = await loadMcuPackagePins();
			pins = fallback.length > 0 ? fallback : buildFullPackagePins([], 64);
			panel.title = 'STM32 ピンビジュアライザ — STM32F446RE (デフォルト)';
		}
		panel.webview.html = getPinVisualizerHtml(panel.webview, pins, iocUri?.fsPath, iocSettings);
	};

	let activeIocUri = iocUri;

	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message)) { return; }

		if (message.type === 'editPin' && typeof message.pin === 'string') {
			if (!activeIocUri) {
				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (!wsFolder) {
					vscode.window.showWarningMessage(vscode.l10n.t('ワークスペースが開かれていません。フォルダを開いてから再試行してください。'));
					return;
				}
				const choice = await vscode.window.showInformationMessage(
					vscode.l10n.t('.ioc ファイルが見つかりません。STM32F446RE の初期設定で新規作成しますか？'),
					vscode.l10n.t('作成する'), vscode.l10n.t('キャンセル')
				);
				if (choice !== vscode.l10n.t('作成する')) { return; }
				const newIocUri = vscode.Uri.joinPath(wsFolder.uri, 'project.ioc');
				const mcuPins = await loadMcuPackagePins();
				const lines = [
					'# Generated by TovaIDE-STM Pin Visualizer',
					'Mcu.Name=STM32F446RETx',
					'ProjectManager.ProjectName=project',
					'ProjectManager.TargetToolchain=STM32CubeIDE',
					...mcuPins.map(p => `${p.pin}=${p.mode}`)
				];
				await writeTextFile(newIocUri, lines.join('\n') + '\n');
				activeIocUri = newIocUri;
				vscode.window.showInformationMessage(vscode.l10n.t('project.ioc を作成しました。'));
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
			const updated = await updateIocPinMode(activeIocUri, message.pin, message.mode);
			if (updated) {
				vscode.window.showInformationMessage(vscode.l10n.t('{0} を {1} に更新しました。', message.pin, message.mode));
				await render();
			}
			return;
		}

		if (message.type === 'addPin' && typeof message.pin === 'string' && typeof message.mode === 'string') {
			if (!activeIocUri) {
				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (!wsFolder) {
					vscode.window.showWarningMessage(vscode.l10n.t('ワークスペースが開かれていません。'));
					return;
				}
				const choice = await vscode.window.showInformationMessage(
					vscode.l10n.t('.ioc ファイルが見つかりません。新規作成しますか？'),
					vscode.l10n.t('作成する'), vscode.l10n.t('キャンセル')
				);
				if (choice !== vscode.l10n.t('作成する')) { return; }
				const newIocUri = vscode.Uri.joinPath(wsFolder.uri, 'project.ioc');
				const mcuPins = await loadMcuPackagePins();
				const lines = [
					'# Generated by TovaIDE-STM Pin Visualizer',
					'Mcu.Name=STM32F446RETx',
					'ProjectManager.ProjectName=project',
					'ProjectManager.TargetToolchain=STM32CubeIDE',
					...mcuPins.map(p => `${p.pin}=${p.mode}`)
				];
				await writeTextFile(newIocUri, lines.join('\n') + '\n');
				activeIocUri = newIocUri;
			}
			await updateIocPinMode(activeIocUri, message.pin, message.mode);
			vscode.window.showInformationMessage(vscode.l10n.t('{0} を {1} として追加しました。', message.pin, message.mode));
			await render();
			return;
		}

		// Apply a single key=value line to the .ioc file
		if (message.type === 'applyIocLine' && typeof message.key === 'string' && typeof message.value === 'string') {
			if (!activeIocUri) {
				vscode.window.showWarningMessage(vscode.l10n.t('.ioc ファイルが開かれていません。'));
				return;
			}
			await updateIocKeyValue(activeIocUri, message.key, message.value);
			await render();
			return;
		}

		// Apply multiple key=value lines at once (batch settings save)
		if (message.type === 'applyIocLines' && Array.isArray(message.lines)) {
			if (!activeIocUri) {
				vscode.window.showWarningMessage(vscode.l10n.t('.ioc ファイルが開かれていません。'));
				return;
			}
			const validLines = (message.lines as unknown[]).filter(
				(l): l is { key: string; value: string } =>
					typeof (l as Record<string, unknown>).key === 'string' && typeof (l as Record<string, unknown>).value === 'string'
			);
			for (const { key, value } of validLines) {
				await updateIocKeyValue(activeIocUri, key, value);
			}
			vscode.window.showInformationMessage(vscode.l10n.t('設定を {0} 件保存しました。', validLines.length));
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

async function createProjectFromTemplate(templateName: string): Promise<void> {
	const template = getTemplateDefinition(templateName);
	const folderPick = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: vscode.l10n.t('作成先フォルダを選択')
	});
	if (!folderPick || folderPick.length === 0) {
		return;
	}

	const suggested = sanitizeProjectName(template.name);
	const projectName = (await vscode.window.showInputBox({
		title: vscode.l10n.t('プロジェクト名'),
		value: suggested,
		prompt: vscode.l10n.t('英数字とハイフン/アンダースコア推奨')
	}))?.trim();
	if (!projectName) {
		return;
	}

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

	const iocText = generateIocText(projectName, template);
	const mainText = generateMainSource(template);
	const headerText = generateMainHeader();
	const readmeText = generateReadme(projectName, template);
	const extJson = '{\n  "recommendations": [\n    "ms-vscode.cpptools"\n  ]\n}\n';
	const tasksJson = generateTasksJson();
	const launchJson = generateLaunchJson(projectName);
	const cPropertiesJson = generateCProperties(template);

	await writeTextFile(vscode.Uri.joinPath(projectUri, `${projectName}.ioc`), iocText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Src', 'main.c'), mainText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Inc', 'main.h'), headerText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'README.md'), readmeText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'extensions.json'), extJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'tasks.json'), tasksJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'launch.json'), launchJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'c_cpp_properties.json'), cPropertiesJson);

	const openAction = await vscode.window.showInformationMessage(
		vscode.l10n.t('テンプレートからプロジェクトを生成しました: {0}', projectName),
		vscode.l10n.t('フォルダを開く')
	);
	if (openAction === vscode.l10n.t('フォルダを開く')) {
		await vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
	}
}

async function createProjectFromBoardConfigurator(profile: BoardProfile, config: BoardConfiguratorPayload): Promise<void> {
	const folderPick = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: vscode.l10n.t('作成先フォルダを選択')
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
	const template: TemplateDefinition = {
		name: profile.name,
		category: 'ボード設定スタジオ',
		mcu: profile.mcu,
		pinModes: mergedPins,
		userCodeLines: [
			'/* TovaIDE-STM ボード設定スタジオで生成 */',
			'HAL_Delay(100);'
		]
	};

	const iocText = generateIocTextFromBoardConfig(projectName, template, config);
	const mainText = generateMainSource(template);
	const headerText = generateMainHeader();
	const readmeText = generateReadme(projectName, template);
	const extJson = '{\n  "recommendations": [\n    "ms-vscode.cpptools"\n  ]\n}\n';
	const tasksJson = generateTasksJson();
	const launchJson = generateLaunchJson(projectName);
	const cPropertiesJson = generateCProperties(template);

	await writeTextFile(vscode.Uri.joinPath(projectUri, `${projectName}.ioc`), iocText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Src', 'main.c'), mainText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Inc', 'main.h'), headerText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'README.md'), readmeText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'extensions.json'), extJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'tasks.json'), tasksJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'launch.json'), launchJson);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'c_cpp_properties.json'), cPropertiesJson);

	const openAction = await vscode.window.showInformationMessage(
		vscode.l10n.t('ボード設定スタジオでプロジェクトを生成しました: {0}', projectName),
		vscode.l10n.t('フォルダを開く'),
		vscode.l10n.t('このままピン設定を開く')
	);
	if (openAction === vscode.l10n.t('フォルダを開く')) {
		await vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
		return;
	}

	if (config.openPinGui || openAction === vscode.l10n.t('このままピン設定を開く')) {
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

function generateIocTextFromBoardConfig(projectName: string, template: TemplateDefinition, _config: BoardConfiguratorPayload): string {
	const lines = [
		'# Auto-generated by TovaIDE-STM board configurator',
		`Mcu.Name=${template.mcu}`,
		`ProjectManager.ProjectName=${projectName}`,
		'ProjectManager.TargetToolchain=STM32CubeIDE',
		'ProjectManager.NoMain=false',
		'ProjectManager.StackSize=1024',
		'ProjectManager.HeapSize=1536',
	];

	for (const pin of template.pinModes) {
		lines.push(`${pin.pin}=${pin.mode}`);
	}

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
		vscode.l10n.t('作成先フォルダに既存ファイルがあります。上書きして続行しますか？'),
		{ modal: true },
		vscode.l10n.t('続行')
	);
	return choice === vscode.l10n.t('続行');
}

async function directoryExists(uri: vscode.Uri): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return stat.type === vscode.FileType.Directory;
	} catch {
		return false;
	}
}

const TEMPLATE_DEFINITIONS: Record<string, TemplateDefinition> = {
	'GPIO Blinky (F4)': {
		name: 'GPIO Blinky (F4)', category: '初級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: ['HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);', 'HAL_Delay(500);']
	},
	'UART Hello (F4)': {
		name: 'UART Hello (F4)', category: '初級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA2', mode: 'USART2_TX' }, { pin: 'PA3', mode: 'USART2_RX' }],
		userCodeLines: [
			'uint8_t msg[] = "Hello STM32\\r\\n";',
			'HAL_UART_Transmit(&huart2, msg, sizeof(msg)-1, 100);',
			'HAL_Delay(1000);'
		]
	},
	'EXTI Button IRQ': {
		name: 'EXTI Button IRQ', category: '初級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }, { pin: 'PC13', mode: 'GPIO_EXTI13' }],
		userCodeLines: [
			'/* PA5 LED toggled in HAL_GPIO_EXTI_Callback */',
			'HAL_Delay(10);'
		]
	},
	'ADC Polling': {
		name: 'ADC Polling', category: '初級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA0', mode: 'ADC1_IN0' }],
		userCodeLines: [
			'HAL_ADC_Start(&hadc1);',
			'if (HAL_ADC_PollForConversion(&hadc1, 10) == HAL_OK) {',
			'  uint32_t val = HAL_ADC_GetValue(&hadc1);',
			'  (void)val;',
			'}',
			'HAL_ADC_Stop(&hadc1);',
			'HAL_Delay(100);'
		]
	},
	'DAC Wave Output': {
		name: 'DAC Wave Output', category: '初級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA4', mode: 'DAC1_OUT1' }],
		userCodeLines: [
			'static uint16_t sine[64] = { 2048,2248,2446,2637,2820,2991,3147,3285,',
			'  3401,3495,3563,3604,3615,3598,3552,3479,',
			'  3381,3260,3117,2955,2778,2587,2388,2182,',
			'  1975,1769,1570,1379,1200,1036, 893, 772,',
			'   674, 601, 555, 538, 549, 590, 658, 752,',
			'   868,1004,1156,1321,1498,1682,1872,2064,',
			'  2048 };',
			'HAL_DAC_SetValue(&hdac, DAC_CHANNEL_1, DAC_ALIGN_12B_R, sine[0]);',
			'HAL_Delay(1);'
		]
	},
	'I2C Sensor Read (F4)': {
		name: 'I2C Sensor Read (F4)', category: '中級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PB6', mode: 'I2C1_SCL' }, { pin: 'PB7', mode: 'I2C1_SDA' }],
		userCodeLines: [
			'uint8_t buf[2];',
			'uint16_t addr = 0x68 << 1;',
			'HAL_I2C_Master_Receive(&hi2c1, addr, buf, 2, 10);',
			'HAL_Delay(50);'
		]
	},
	'SPI IMU (F4)': {
		name: 'SPI IMU (F4)', category: '中級', mcu: 'STM32F446RETx',
		pinModes: [
			{ pin: 'PA5', mode: 'SPI1_SCK' }, { pin: 'PA6', mode: 'SPI1_MISO' },
			{ pin: 'PA7', mode: 'SPI1_MOSI' }, { pin: 'PB6', mode: 'GPIO_Output' }
		],
		userCodeLines: [
			'uint8_t tx[2] = { 0x75 | 0x80, 0x00 };',
			'uint8_t rx[2] = { 0 };',
			'HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET);',
			'HAL_SPI_TransmitReceive(&hspi1, tx, rx, 2, 10);',
			'HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);',
			'HAL_Delay(10);'
		]
	},
	'Timer PWM Basic': {
		name: 'Timer PWM Basic', category: '中級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA8', mode: 'TIM1_CH1' }],
		userCodeLines: [
			'HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);',
			'__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 500);',
			'HAL_Delay(1000);',
			'__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 250);',
			'HAL_Delay(1000);'
		]
	},
	'ADC + DMA': {
		name: 'ADC + DMA', category: '中級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA0', mode: 'ADC1_IN0' }, { pin: 'PA1', mode: 'ADC1_IN1' }],
		userCodeLines: [
			'uint32_t adcBuf[2];',
			'HAL_ADC_Start_DMA(&hadc1, adcBuf, 2);',
			'HAL_Delay(10);',
			'(void)adcBuf;'
		]
	},
	'CAN Loopback': {
		name: 'CAN Loopback', category: '中級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA11', mode: 'CAN1_RX' }, { pin: 'PA12', mode: 'CAN1_TX' }],
		userCodeLines: [
			'CAN_TxHeaderTypeDef txHdr = { .StdId=0x7FF, .DLC=1, .RTR=CAN_RTR_DATA, .IDE=CAN_ID_STD };',
			'uint8_t data[1] = { 0xAB };',
			'uint32_t txMbox;',
			'HAL_CAN_AddTxMessage(&hcan1, &txHdr, data, &txMbox);',
			'HAL_Delay(100);'
		]
	},
	'RTC Calendar': {
		name: 'RTC Calendar', category: '中級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'RTC_TimeTypeDef t;',
			'RTC_DateTypeDef d;',
			'HAL_RTC_GetTime(&hrtc, &t, RTC_FORMAT_BIN);',
			'HAL_RTC_GetDate(&hrtc, &d, RTC_FORMAT_BIN);',
			'(void)t; (void)d;',
			'HAL_Delay(1000);'
		]
	},
	'USB CDC Device': {
		name: 'USB CDC Device', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'extern USBD_HandleTypeDef hUsbDeviceFS;',
			'uint8_t msg[] = "USB CDC\\r\\n";',
			'CDC_Transmit_FS(msg, sizeof(msg)-1);',
			'HAL_Delay(1000);'
		]
	},
	'USB HID Device': {
		name: 'USB HID Device', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'extern USBD_HandleTypeDef hUsbDeviceFS;',
			'uint8_t report[4] = { 0 };',
			'USBD_HID_SendReport(&hUsbDeviceFS, report, 4);',
			'HAL_Delay(10);'
		]
	},
	'FreeRTOS 2 Tasks': {
		name: 'FreeRTOS 2 Tasks', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: [
			'/* Tasks defined in freertos.c — see Task1 / Task2 */',
			'HAL_Delay(1);'
		]
	},
	'FreeRTOS Queue': {
		name: 'FreeRTOS Queue', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'/* Producer/consumer pattern via osMessageQueuePut / Get */',
			'HAL_Delay(1);'
		]
	},
	'FreeRTOS Mutex': {
		name: 'FreeRTOS Mutex', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'/* Shared resource protected via osMutexAcquire / Release */',
			'HAL_Delay(1);'
		]
	},
	'LwIP TCP Echo': {
		name: 'LwIP TCP Echo', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'/* LwIP raw TCP echo server — see tcp_echoserver.c */',
			'MX_LWIP_Process();',
			'HAL_Delay(1);'
		]
	},
	'LwIP HTTP Basic': {
		name: 'LwIP HTTP Basic', category: '上級', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'/* Basic HTTP/1.0 server using LwIP httpd — see httpd.c */',
			'MX_LWIP_Process();',
			'HAL_Delay(1);'
		]
	},
	'FatFS SD Card': {
		name: 'FatFS SD Card', category: 'ストレージ', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'FATFS fs; FIL fil; FRESULT res;',
			'f_mount(&fs, "", 1);',
			'res = f_open(&fil, "test.txt", FA_CREATE_ALWAYS | FA_WRITE);',
			'if (res == FR_OK) { f_printf(&fil, "Hello\\n"); f_close(&fil); }',
			'f_mount(NULL, "", 0);',
			'HAL_Delay(100);'
		]
	},
	'QSPI External Flash': {
		name: 'QSPI External Flash', category: 'ストレージ', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'/* Read ID via QSPI — configure QSPI peripheral in CubeMX */',
			'QSPI_CommandTypeDef cmd = { .Instruction=0x9F, .InstructionMode=QSPI_INSTRUCTION_1_LINE,',
			'  .DataMode=QSPI_DATA_1_LINE, .NbData=3 };',
			'uint8_t id[3];',
			'HAL_QSPI_Command(&hqspi, &cmd, 100);',
			'HAL_QSPI_Receive(&hqspi, id, 100);',
			'HAL_Delay(10);'
		]
	},
	'Bootloader UART': {
		name: 'Bootloader UART', category: 'ストレージ', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA2', mode: 'USART2_TX' }, { pin: 'PA3', mode: 'USART2_RX' }],
		userCodeLines: [
			'/* Simple UART bootloader stub — jumps to app at 0x08008000 */',
			'void (*app)(void) = (void (*)(void))(*(uint32_t *)(0x08008004));',
			'__set_MSP(*(uint32_t *)0x08008000);',
			'app();'
		]
	},
	'Low Power STOP Mode': {
		name: 'Low Power STOP Mode', category: '電源', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'HAL_SuspendTick();',
			'HAL_PWR_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON, PWR_STOPENTRY_WFI);',
			'SystemClock_Config();',
			'HAL_ResumeTick();'
		]
	},
	'Watchdog IWDG': {
		name: 'Watchdog IWDG', category: '電源', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'HAL_IWDG_Refresh(&hiwdg);',
			'HAL_Delay(50);'
		]
	},
	'Crypto AES (L5)': {
		name: 'Crypto AES (L5)', category: '電源', mcu: 'STM32L552ZETx',
		pinModes: [],
		userCodeLines: [
			'uint8_t key[16] = { 0x00 };',
			'uint8_t plain[16] = { 0x01 };',
			'uint8_t cipher[16];',
			'CRYP_ConfigTypeDef cfg = { .DataType=CRYP_DATATYPE_8B, .KeySize=CRYP_KEYSIZE_128B };',
			'HAL_CRYP_Encrypt(&hcryp, (uint32_t *)plain, 4, (uint32_t *)cipher, 100);',
			'(void)cipher;',
			'HAL_Delay(10);'
		]
	},
	'CMSIS-DSP FIR': {
		name: 'CMSIS-DSP FIR', category: '電源', mcu: 'STM32F446RETx',
		pinModes: [],
		userCodeLines: [
			'#include "arm_math.h"',
			'static float32_t fir_state[32+16-1];',
			'arm_fir_instance_f32 fir;',
			'/* arm_fir_init_f32 / arm_fir_f32 — see CMSIS-DSP docs */',
			'HAL_Delay(1);'
		]
	},
	'Modbus RTU Slave': {
		name: 'Modbus RTU Slave', category: '産業', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA2', mode: 'USART2_TX' }, { pin: 'PA3', mode: 'USART2_RX' }],
		userCodeLines: [
			'/* Modbus RTU via RS-485 — add freemodbus or similar library */',
			'eMBPoll();',
			'HAL_Delay(1);'
		]
	},
	'Motor PWM + Encoder': {
		name: 'Motor PWM + Encoder', category: '産業', mcu: 'STM32F446RETx',
		pinModes: [
			{ pin: 'PA8', mode: 'TIM1_CH1' }, { pin: 'PB4', mode: 'TIM3_CH1' }, { pin: 'PB5', mode: 'TIM3_CH2' }
		],
		userCodeLines: [
			'HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);',
			'HAL_TIM_Encoder_Start(&htim3, TIM_CHANNEL_ALL);',
			'int32_t pos = (int16_t)__HAL_TIM_GET_COUNTER(&htim3);',
			'(void)pos;',
			'HAL_Delay(10);'
		]
	},
	'Hall Sensor Capture': {
		name: 'Hall Sensor Capture', category: '産業', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA8', mode: 'TIM1_CH1' }],
		userCodeLines: [
			'HAL_TIM_IC_Start_IT(&htim1, TIM_CHANNEL_1);',
			'/* Period measured in HAL_TIM_IC_CaptureCallback */',
			'HAL_Delay(1);'
		]
	},
	'BLE UART Bridge (WB)': {
		name: 'BLE UART Bridge (WB)', category: 'ワイヤレス', mcu: 'STM32WB55RGVx',
		pinModes: [{ pin: 'PA2', mode: 'USART1_TX' }, { pin: 'PA3', mode: 'USART1_RX' }],
		userCodeLines: [
			'/* BLE UART transparent bridge — see STM32WB BLE UART example */',
			'MX_APPE_Process();',
			'HAL_Delay(1);'
		]
	},
	'Multi-board Workspace Sample': {
		name: 'Multi-board Workspace Sample', category: 'ワイヤレス', mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: ['/* Multi-board sample — add second board folder to workspace */', 'HAL_Delay(100);']
	},
	'Ethernet TCP (H7)': {
		name: 'Ethernet TCP (H7)', category: 'H7', mcu: 'STM32H743ZITx',
		pinModes: [],
		userCodeLines: [
			'/* LwIP TCP client on STM32H743 — see tcp_client.c */',
			'MX_LWIP_Process();',
			'HAL_Delay(1);'
		]
	},
	'FMC SDRAM (H7)': {
		name: 'FMC SDRAM (H7)', category: 'H7', mcu: 'STM32H743ZITx',
		pinModes: [],
		userCodeLines: [
			'/* SDRAM at 0xC0000000 via FMC — initialized in MX_FMC_Init */',
			'uint32_t *sdram = (uint32_t *)0xC0000000UL;',
			'sdram[0] = 0xDEADBEEF;',
			'HAL_Delay(1);'
		]
	},
	'Low Power LPUART (L4)': {
		name: 'Low Power LPUART (L4)', category: 'L4', mcu: 'STM32L476RGTx',
		pinModes: [{ pin: 'PB10', mode: 'LPUART1_TX' }, { pin: 'PB11', mode: 'LPUART1_RX' }],
		userCodeLines: [
			'uint8_t msg[] = "L4 Low Power UART\\r\\n";',
			'HAL_UART_Transmit(&hlpuart1, msg, sizeof(msg)-1, 100);',
			'HAL_PWR_EnterSLEEPMode(PWR_MAINREGULATOR_ON, PWR_SLEEPENTRY_WFI);'
		]
	},
	'Touch Sense (L4)': {
		name: 'Touch Sense (L4)', category: 'L4', mcu: 'STM32L476RGTx',
		pinModes: [],
		userCodeLines: [
			'/* TSC group acquisition — configure TSC in CubeMX */',
			'HAL_TSC_Start(&htsc);',
			'if (HAL_TSC_PollForAcquisition(&htsc) == HAL_OK) {',
			'  uint32_t val = HAL_TSC_GroupGetValue(&htsc, TSC_GROUP1_IDX);',
			'  (void)val;',
			'}',
			'HAL_Delay(10);'
		]
	},
	'BLE Custom Profile (WB)': {
		name: 'BLE Custom Profile (WB)', category: 'WB', mcu: 'STM32WB55RGVx',
		pinModes: [],
		userCodeLines: [
			'/* Custom BLE GATT service — see custom_app.c generated by STM32CubeMX */',
			'Custom_App_Process();',
			'MX_APPE_Process();',
			'HAL_Delay(1);'
		]
	},
	'Blue Pill Blinky (F1)': {
		name: 'Blue Pill Blinky (F1)', category: 'F1', mcu: 'STM32F103C8Tx',
		pinModes: [{ pin: 'PC13', mode: 'GPIO_Output' }],
		userCodeLines: ['HAL_GPIO_TogglePin(GPIOC, GPIO_PIN_13);', 'HAL_Delay(500);']
	},
	'Blue Pill UART (F1)': {
		name: 'Blue Pill UART (F1)', category: 'F1', mcu: 'STM32F103C8Tx',
		pinModes: [{ pin: 'PA9', mode: 'USART1_TX' }, { pin: 'PA10', mode: 'USART1_RX' }],
		userCodeLines: [
			'uint8_t msg[] = "Blue Pill STM32F1\\r\\n";',
			'HAL_UART_Transmit(&huart1, msg, sizeof(msg)-1, 100);',
			'HAL_Delay(1000);'
		]
	},
	'G0 Nucleo Blinky': {
		name: 'G0 Nucleo Blinky', category: 'G0', mcu: 'STM32G071RBTx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: ['HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);', 'HAL_Delay(500);']
	},
	'G0 Low Power': {
		name: 'G0 Low Power', category: 'G0', mcu: 'STM32G071RBTx',
		pinModes: [],
		userCodeLines: [
			'HAL_SuspendTick();',
			'HAL_PWREx_EnterSTOP2Mode(PWR_STOPENTRY_WFI);',
			'SystemClock_Config();',
			'HAL_ResumeTick();'
		]
	},
	'U5 TrustZone Blinky': {
		name: 'U5 TrustZone Blinky', category: 'U5', mcu: 'STM32U575RITx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: [
			'/* Secure world LED blink on Nucleo-U575ZI-Q */',
			'HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);',
			'HAL_Delay(500);'
		]
	},
	'U5 Low Power LPUART': {
		name: 'U5 Low Power LPUART', category: 'U5', mcu: 'STM32U575RITx',
		pinModes: [{ pin: 'PA2', mode: 'LPUART1_TX' }, { pin: 'PA3', mode: 'LPUART1_RX' }],
		userCodeLines: [
			'uint8_t msg[] = "U5 Low Power UART\\r\\n";',
			'HAL_UART_Transmit(&hlpuart1, msg, sizeof(msg)-1, 100);',
			'HAL_PWREx_EnterSTOP1Mode(PWR_STOPENTRY_WFI);',
			'SystemClock_Config();'
		]
	},
	'C0 Minimal Blinky': {
		name: 'C0 Minimal Blinky', category: 'C0', mcu: 'STM32C031C6Tx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: ['HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);', 'HAL_Delay(500);']
	},
	'C0 UART Echo': {
		name: 'C0 UART Echo', category: 'C0', mcu: 'STM32C031C6Tx',
		pinModes: [{ pin: 'PA9', mode: 'USART1_TX' }, { pin: 'PA10', mode: 'USART1_RX' }],
		userCodeLines: [
			'uint8_t buf[1];',
			'if (HAL_UART_Receive(&huart1, buf, 1, 1) == HAL_OK) {',
			'  HAL_UART_Transmit(&huart1, buf, 1, 10);',
			'}'
		]
	},
};

function getTemplateDefinition(templateName: string): TemplateDefinition {
	return TEMPLATE_DEFINITIONS[templateName] ?? {
		name: templateName,
		category: '標準',
		mcu: 'STM32F446RETx',
		pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
		userCodeLines: ['/* TODO: template logic */', 'HAL_Delay(100);']
	};
}

function sanitizeProjectName(value: string): string {
	const replaced = value.replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
	return replaced.length > 0 ? replaced : 'stm32-project';
}

function generateIocText(projectName: string, template: TemplateDefinition): string {
	const lines = [
		'# Auto-generated by STM32 UX template gallery',
		`Mcu.Name=${template.mcu}`,
		`ProjectManager.ProjectName=${projectName}`,
		'ProjectManager.TargetToolchain=STM32CubeIDE',
		'ProjectManager.NoMain=false'
	];

	for (const pin of template.pinModes) {
		lines.push(`${pin.pin}=${pin.mode}`);
	}

	return `${lines.join('\n')}\n`;
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

function generateMainSource(template: TemplateDefinition): string {
	const userCode = template.userCodeLines.map(line => `  ${line}`).join('\n');
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

function generateReadme(projectName: string, template: TemplateDefinition): string {
	const pinRows = template.pinModes.map(pin => `- ${pin.pin}: ${pin.mode}`).join('\n');
	return [
		`# ${projectName}`,
		'',
		`Template: ${template.name}`,
		`Category: ${template.category}`,
		`MCU: ${template.mcu}`,
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

function generateCProperties(template: TemplateDefinition): string {
	const { halFolder, cmsisDev, partDefine } = getMcuFamilyProfile(template.mcu);
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
	const bytes = Uint8Array.from(content.split('').map(ch => ch.charCodeAt(0)));
	await vscode.workspace.fs.writeFile(uri, bytes);
}

async function updateIocPinMode(iocUri: vscode.Uri, pin: string, mode: string): Promise<boolean> {
	return updateIocKeyValue(iocUri, pin, mode);
}

async function updateIocKeyValue(iocUri: vscode.Uri, key: string, value: string): Promise<boolean> {
	const oldBytes = await vscode.workspace.fs.readFile(iocUri);
	let oldText = '';
	for (const v of oldBytes) { oldText += String.fromCharCode(v); }

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
	const oldBytes = await vscode.workspace.fs.readFile(iocUri);
	let oldText = '';
	for (const v of oldBytes) { oldText += String.fromCharCode(v); }
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

/** パッケージのピン総数を .ioc テキストまたは MCU 名から推定する */
function getPackagePinCount(iocText: string, mcuName: string): number {
	const pkgMatch = iocText.match(/Mcu\.Package\s*=\s*(\w+)/);
	const pkg = (pkgMatch?.[1] ?? '').toUpperCase();
	const pkgNum = pkg.match(/(\d{2,3})/);
	if (pkgNum) { return parseInt(pkgNum[1], 10); }
	// MCU 名末尾のパッケージサフィックスで推定
	const upper = (mcuName ?? '').toUpperCase();
	if (/ZI|ZG|ZE/.test(upper.slice(-4))) { return 144; }
	if (/VI|VG|VE/.test(upper.slice(-4))) { return 100; }
	if (/RE|RG|RB/.test(upper.slice(-4))) { return 64; }
	if (/CB|CC|CE/.test(upper.slice(-4))) { return 48; }
	if (/KB|KC/.test(upper.slice(-4))) { return 32; }
	return 64;
}

/** パッケージ全ピンリストを生成し .ioc 設定済みピンをマージする */
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
			all.push({ pin: pinName, mode: configMap.get(pinName.toUpperCase()) ?? '未使用' });
		}
	}
	return all;
}

function getErrorHint(message: string): string {
	const normalized = message.toLowerCase();
	if (normalized.includes('undeclared')) {
		return '未宣言シンボルです。ioc設定で対象ペリフェラルを有効化するか、変数名の誤字を確認してください。';
	}
	if (normalized.includes('no such file')) {
		return 'ヘッダまたはソースのインクルードパス不整合です。CubeIDE移行直後は includePath と生成コードの場所を確認してください。';
	}
	if (normalized.includes('undefined reference')) {
		return 'リンクエラーです。ソース追加漏れ、関数名不一致、またはライブラリ未リンクの可能性があります。';
	}
	return 'エラー内容を確認し、該当行と直前の変更を比較してください。必要であれば STM32 AI で /fix を実行します。';
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

function getBoardConfiguratorHtml(webview: vscode.Webview, profiles: BoardProfile[], mcuNames: string[]): string {
	const csp = webview.cspSource;
	const boardOptions = profiles.map(profile =>
		`<option value="${escapeHtml(profile.id)}" data-mcu="${escapeHtml(profile.mcu)}" data-desc="${escapeHtml(profile.description)}">${escapeHtml(profile.name)} (${escapeHtml(profile.mcu)})</option>`
	).join('');
	const mcuOptions = mcuNames.map(mcu =>
		`<option value="${escapeHtml(mcu)}">${escapeHtml(mcu)}</option>`
	).join('');

	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:22px 24px;max-width:960px}
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
	<h1>TovaIDE-STM ボード設定スタジオ</h1>
	<p class="sub">この画面は「プロジェクト作成専用」です。Clock Tree / Parameter Settings / NVIC / DMA / GPIO はプロジェクト生成後に .ioc 編集（ピンビジュアライザまたはCubeMX）で行います。</p>
	<div class="notice">CubeMXと件数を合わせるには、先に <b>CubeMXカタログ同期</b> を実行してください。<br/>この画面は Board DB と MCU DB を別々に読み込みます。</div>

	<div class="mode-row" role="radiogroup" aria-label="作成モード">
		<label class="mode-chip"><input type="radio" name="selectMode" value="board" checked /> Board から作成</label>
		<label class="mode-chip"><input type="radio" name="selectMode" value="mcu" /> MCU/MPU Selector から作成</label>
	</div>

	<div class="card">
		<div id="boardPanel">
			<div class="row">
				<label for="boardSearch">Board 検索 (Board 名 / 説明 / CPN)</label>
				<input id="boardSearch" type="search" placeholder="例: NUCLEO / DISCOVERY / STM32F446RE" aria-label="Board 検索" />
				<div class="desc" id="boardSearchMeta">${profiles.length} 件 (Board DB)</div>
			</div>
			<div class="row">
				<label for="boardId">Board</label>
				<select id="boardId">${boardOptions}</select>
				<div class="mcu-tag" id="boardMcu">CPN: -</div>
				<div class="desc" id="boardDesc">-</div>
			</div>
		</div>

		<div id="mcuPanel" class="hidden">
			<div class="row">
				<label for="mcuSearch">MCU/MPU Selector 検索 (Commercial Part Number)</label>
				<input id="mcuSearch" type="search" placeholder="例: STM32F446RETX" aria-label="MCU 検索" />
				<div class="desc" id="mcuSearchMeta">${mcuNames.length} 件 (MCU DB)</div>
			</div>
			<div class="row">
				<label for="mcuId">MCU / MPU Selector</label>
				<select id="mcuId">${mcuOptions}</select>
				<div class="mcu-tag" id="mcuMetaTag">CPN: -</div>
			</div>
		</div>

		<div class="row">
			<label for="projectName">プロジェクト名</label>
			<input id="projectName" value="stm32-project" maxlength="64" />
		</div>
		<label class="chk"><input id="openPinGui" type="checkbox" checked /> 作成後にピン設定GUIを開く</label>
	</div>

	<div class="btnrow">
		<button id="createBtn" aria-label="プロジェクトを作成">プロジェクト作成</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
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
				empty.textContent = '一致する Board がありません';
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
			boardSearchMeta.textContent = filtered.length + ' / ' + allBoards.length + ' 件 (Board DB)';
			updateBoardMeta();
		}

		function updateBoardMeta() {
			if (boardId.disabled || boardId.selectedIndex < 0) {
				boardMcu.textContent = 'CPN: -';
				boardDesc.textContent = '一致する Board がありません。';
				return;
			}
			const opt = boardId.options[boardId.selectedIndex];
			boardMcu.textContent = 'CPN: ' + (opt.dataset.mcu || '-');
			boardDesc.textContent = opt.dataset.desc || '-';
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
			mcuSearchMeta.textContent = filtered.length + ' / ' + allMcu.length + ' 件 (MCU DB)';
			mcuMetaTag.textContent = 'CPN: ' + (mcuId.value || '-');
		}

		boardSearch.addEventListener('input', () => renderBoardOptions(boardSearch.value));
		boardId.addEventListener('change', updateBoardMeta);
		mcuSearch.addEventListener('input', () => renderMcuOptions(mcuSearch.value));
		mcuId.addEventListener('change', () => { mcuMetaTag.textContent = 'CPN: ' + (mcuId.value || '-'); });

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
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-sideBar-background,#121621);--card:#181d2a;--bd:var(--vscode-panel-border,#273146);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#8b9bb5);--ac:#0f766e;--ac2:rgba(15,118,110,.2);--ok:#22c55e}
		body{font:12px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);padding:8px;background:radial-gradient(circle at 85% -10%, rgba(15,118,110,.25), transparent 35%),var(--bg);color:var(--tx)}
		.hero{padding:10px 10px 12px;border:1px solid var(--bd);border-radius:10px;background:linear-gradient(160deg,#101523,#1a2234);margin-bottom:8px}
		.hero h1{font-size:13px;letter-spacing:.02em;margin-bottom:4px}
		.hero p{font-size:10px;color:var(--mt)}
		.grid{display:grid;gap:6px}
		.btn{display:flex;align-items:center;gap:8px;width:100%;padding:8px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--tx);cursor:pointer;text-align:left;transition:background .12s,border-color .12s}
		.btn:hover{background:var(--ac2);border-color:rgba(15,118,110,.55)}
		.badge{font-size:9px;padding:2px 6px;border-radius:999px;border:1px solid rgba(34,197,94,.45);color:#86efac;background:rgba(34,197,94,.14)}
		.label{font-size:12px;font-weight:600;flex:1}
		.meta{font-size:10px;color:var(--mt)}
	</style>
</head>
<body>
	<div class="hero">
		<h1>TovaIDE-STM ダッシュボード</h1>
		<p>CubeIDEの実運用フローに合わせて、作成・設定・ビルド・書込み・MCP操作をここから開始します。</p>
	</div>
	<div class="grid">
		<button class="btn" id="studio"><span class="badge">MODE</span><span class="label">ワークフロースタジオ</span><span class="meta">作成/コーディング/設定</span></button>
		<button class="btn" id="board"><span class="badge">NEW</span><span class="label">ボード設定スタジオ</span><span class="meta">CubeMX不要の初期作成</span></button>
		<button class="btn" id="syncCatalog"><span class="badge">MCU</span><span class="label">CubeMXカタログ同期</span><span class="meta">5000+ MCU取り込み</span></button>
		<button class="btn" id="pin"><span class="badge">PIN</span><span class="label">ピンビジュアライザ</span><span class="meta">チップ図とピン編集</span></button>
		<button class="btn" id="svd"><span class="badge">DBG</span><span class="label">SVDレジスタ表示を更新</span><span class="meta">フォールバック含め表示</span></button>
		<button class="btn" id="build"><span class="badge">BUILD</span><span class="label">Debugビルド</span><span class="meta">エラー位置へ即移動</span></button>
		<button class="btn" id="flash"><span class="badge">FLASH</span><span class="label">書込み</span><span class="meta">STM32_Programmer_CLI</span></button>
		<button class="btn" id="debug"><span class="badge">GDB</span><span class="label">デバッグ開始</span><span class="meta">ST-LINK GDB Server</span></button>
		<button class="btn" id="collab"><span class="badge">COLLAB</span><span class="label">共同作業パネル</span><span class="meta">LAN/WS/Git共有</span></button>
		<button class="btn" id="mcp"><span class="badge">MCP</span><span class="label">MCPオペレーションデスク</span><span class="meta">全操作のRPC化</span></button>
	</div>
<script>
	const vscode = acquireVsCodeApi();
	for (const id of ['studio','board','syncCatalog','pin','svd','build','flash','debug','collab','mcp']) {
		document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
	}
</script>
</body>
</html>`;
}

function getMcpOperationDeskHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e;--ac2:rgba(15,118,110,.14)}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:18px}
		h1{font-size:18px;margin-bottom:4px}
		.sub{font-size:11px;color:var(--mt);margin-bottom:14px}
		.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
		button{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:10px;text-align:left;cursor:pointer;font:inherit}
		button:hover{background:var(--ac2);border-color:rgba(15,118,110,.5)}
		.t{font-weight:700;font-size:12px}
		.d{font-size:10px;color:var(--mt)}
	</style>
</head>
<body>
	<h1>STM32 MCP オペレーションデスク</h1>
	<div class="sub">ここから起動する操作は、同じ内容を MCP JSON-RPC でも呼べるように実装されています。</div>
	<div class="grid">
		<button id="startMcp"><div class="t">MCPサーバー起動</div><div class="d">stm32ai.startMcpServer</div></button>
		<button id="stopMcp"><div class="t">MCPサーバー停止</div><div class="d">stm32ai.stopMcpServer</div></button>
		<button id="build"><div class="t">ビルド</div><div class="d">method: stm32.build</div></button>
		<button id="flash"><div class="t">書込み</div><div class="d">method: stm32.flash</div></button>
		<button id="regen"><div class="t">コード再生成</div><div class="d">method: stm32.regenerateCode</div></button>
		<button id="board"><div class="t">ボード設定</div><div class="d">method: stm32.openBoardConfigurator</div></button>
		<button id="collab"><div class="t">共同作業</div><div class="d">method: stm32.collab.openPanel</div></button>
		<button id="svd"><div class="t">SVD更新</div><div class="d">method: stm32.refreshRegisters</div></button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		for (const id of ['startMcp','stopMcp','build','flash','regen','board','collab','svd']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
	</script>
</body>
</html>`;
}

function getWorkflowStudioHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{
			--bg:var(--vscode-editor-background,#0d0e14);
			--sf:var(--vscode-sideBar-background,#13151e);
			--bd:var(--vscode-panel-border,#1e2030);
			--tx:var(--vscode-editor-foreground,#e8eaed);
			--mt:var(--vscode-descriptionForeground,#6b7280);
			--ac:#0f766e;--ac2:rgba(15,118,110,.14);
		}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:22px 24px;max-width:980px}
		h1{font-size:20px;font-weight:700;margin-bottom:6px}
		.sub{font-size:12px;color:var(--mt);margin-bottom:18px}
		.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
		.card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
		.ttl{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700}
		.badge{font-size:10px;padding:2px 8px;border-radius:999px;background:var(--ac2);color:#99f6e4;border:1px solid rgba(15,118,110,.45)}
		.desc{font-size:12px;color:var(--mt)}
		.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
		button{background:transparent;border:1px solid var(--bd);color:var(--tx);border-radius:7px;padding:8px 10px;font:600 12px var(--vscode-font-family,'Segoe UI',sans-serif);cursor:pointer}
		button:hover{background:var(--ac2);border-color:rgba(15,118,110,.55)}
		button.primary{background:var(--ac);border-color:var(--ac);color:#fff}
		button.primary:hover{background:#0d9488;border-color:#0d9488}
		.tip{margin-top:16px;font-size:11px;color:var(--mt)}
	</style>
</head>
<body>
	<h1>STM32 ワークフロースタジオ</h1>
	<p class="sub">作業文脈ごとに画面を分離: 新規作成・コーディング・設定の3モードから開始できます。</p>
	<div class="grid">
		<div class="card">
			<div class="ttl">1) 新規作成 <span class="badge">Create</span></div>
			<p class="desc">ボード選択、クロック、ミドルウェア、メモリ設定までを1画面で実施します。必要ならCubeMX DBからMCUカタログを同期します。</p>
			<div class="actions">
				<button class="primary" id="create">ボード設定スタジオを開く</button>
				<button id="syncCatalog">CubeMX カタログ同期</button>
				<button id="tutorial">Lチカチュートリアル</button>
			</div>
		</div>
		<div class="card">
			<div class="ttl">2) コーディング <span class="badge">Code</span></div>
			<p class="desc">ビルド/書き込み/AI支援/ピン編集へ直接アクセスし、実装作業に集中します。</p>
			<div class="actions">
				<button class="primary" id="coding">STM32 コマンドセンター</button>
				<button id="pins">ピンビジュアライザ</button>
			</div>
		</div>
		<div class="card">
			<div class="ttl">3) 設定 <span class="badge">Setup</span></div>
			<p class="desc">ツール検出、パス確認、環境診断を実行し、開発環境の不整合を即時解決します。</p>
			<div class="actions">
				<button class="primary" id="settings">環境チェックを実行</button>
			</div>
		</div>
	</div>
	<p class="tip">最初に迷ったら「新規作成」から開始すると、CubeMX相当の初期設定フローへ移動します。</p>
	<script>
		const vscode = acquireVsCodeApi();
		for (const id of ['create', 'coding', 'settings', 'tutorial', 'pins', 'syncCatalog']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
	</script>
</body>
</html>`;
}

function getWelcomeHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box}
		body{font:13px/1.65 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);margin:0;padding:24px 28px}
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
		<h1>TovaIDE-STM ウェルカム</h1>
<p class="sub">最初に使う操作をテキスト中心でまとめています。必要な項目を選択して開発を開始してください。</p>

<h2>Quick Start</h2>
<ul class="action-list" aria-label="クイックスタート操作">
	<li class="action-item">
		<div class="action-name">チュートリアル</div>
		<div class="action-desc">Lチカの手順を順番に実行して、ビルドから書込みまで確認します。</div>
		<button class="action-btn" id="tutorial" aria-label="チュートリアルを開始">開始</button>
	</li>
	<li class="action-item">
		<div class="action-name">CubeIDE から移行</div>
		<div class="action-desc">既存の STM32CubeIDE プロジェクトをインポートします。</div>
		<button class="action-btn" id="import" aria-label="CubeIDEインポート">インポート</button>
	</li>
	<li class="action-item">
		<div class="action-name">テンプレート作成</div>
		<div class="action-desc">用途別テンプレートから新規プロジェクトを生成します。</div>
		<button class="action-btn" id="templates" aria-label="テンプレートギャラリー">開く</button>
	</li>
	<li class="action-item">
		<div class="action-name">基板設定</div>
		<div class="action-desc">基板を選択し、クロックやデバッグ設定を行ってプロジェクトを作成します。</div>
		<button class="action-btn" id="board" aria-label="ボード設定スタジオ">開く</button>
	</li>
	<li class="action-item">
		<div class="action-name">作業フロー</div>
		<div class="action-desc">新規作成 / コーディング / 設定をモード別に起動します。</div>
		<div>
			<button class="action-btn" id="studio" aria-label="ワークフロースタジオ">スタジオを開く</button>
			<button class="action-btn" id="syncCatalog" aria-label="CubeMXカタログ同期">カタログ同期</button>
		</div>
	</li>
</ul>

<div class="links">
	<button class="link-btn" id="env" aria-label="環境チェック">環境チェック</button>
	<button class="link-btn" id="env2" aria-label="環境チェック 2">環境チェック (同機能)</button>
	<button class="link-btn" id="pin" aria-label="ピンビジュアライザ">ピンビジュアライザ</button>
	<button class="link-btn" id="error" aria-label="エラー解説">エラー自動解説</button>
</div>

<script>
	const vscode = acquireVsCodeApi();
	document.getElementById('studio').addEventListener('click', () => vscode.postMessage({ type: 'studio' }));
	document.getElementById('syncCatalog').addEventListener('click', () => vscode.postMessage({ type: 'syncCatalog' }));
	document.getElementById('tutorial').addEventListener('click', () => vscode.postMessage({ type: 'tutorial' }));
	document.getElementById('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));
	document.getElementById('templates').addEventListener('click', () => vscode.postMessage({ type: 'templates' }));
	document.getElementById('board').addEventListener('click', () => vscode.postMessage({ type: 'board' }));
	document.getElementById('env').addEventListener('click', () => vscode.postMessage({ type: 'env' }));
	document.getElementById('env2').addEventListener('click', () => vscode.postMessage({ type: 'env' }));
	document.getElementById('pin').addEventListener('click', () => vscode.postMessage({ type: 'pin' }));
	document.getElementById('error').addEventListener('click', () => vscode.postMessage({ type: 'error' }));
</script>
</body>
</html>`;
}

function getTutorialHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	const stepsJson = JSON.stringify(TUTORIAL_STEPS);
	const stepCount = TUTORIAL_STEPS.length;
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e;--ac2:rgba(15,118,110,.14);--ok:#22c55e}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:24px 28px;max-width:700px}
		h1{font-size:18px;font-weight:700;margin-bottom:4px}
		.sub{font-size:12px;color:var(--mt);margin-bottom:20px}
		.tracker{display:flex;gap:4px;margin-bottom:20px;align-items:center}
		.dot{width:28px;height:4px;border-radius:2px;background:var(--bd);transition:background .2s,width .2s;flex-shrink:0}
		.dot.done{background:var(--ok)}
		.dot.active{background:var(--ac);width:36px}
		.step-card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:20px 22px;margin-bottom:16px;min-height:80px}
		.step-num{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mt);margin-bottom:6px}
		.step-text{font-size:14px;line-height:1.6;color:var(--tx)}
		.nav{display:flex;gap:8px;margin-bottom:20px}
		.btn{padding:7px 16px;border-radius:6px;cursor:pointer;font:600 12px/1 var(--vscode-font-family,'Segoe UI',sans-serif);border:1px solid var(--bd);transition:background .1s}
		.btn:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
		.btn-pri{background:var(--ac);color:#fff;border-color:var(--ac)}
		.btn-pri:hover{background:#0d9488;border-color:#0d9488}
		.btn-sec{background:transparent;color:var(--tx)}
		.btn-sec:hover{background:var(--ac2);border-color:rgba(15,118,110,.45)}
		.btn-sec:disabled{opacity:.4;cursor:default}
		.actions-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mt);margin-bottom:8px}
		.action-row{display:flex;gap:8px;flex-wrap:wrap}
		.act-btn{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;border:1px solid var(--bd);background:transparent;color:var(--tx);cursor:pointer;font:12px/1 var(--vscode-font-family,'Segoe UI',sans-serif);transition:background .1s}
		.act-btn:hover{background:var(--ac2);border-color:rgba(99,102,241,.4)}
		.act-btn:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
	</style>
</head>
<body>
	<h1>Lチカ インタラクティブチュートリアル</h1>
	<p class="sub">STM32でLEDを点滅させる基本的な開発フローを学びます</p>

	<div class="tracker" id="tracker" aria-label="進捗"></div>

	<div class="step-card" role="region" aria-label="現在のステップ">
		<div class="step-num" id="stepNum"></div>
		<div class="step-text" id="stepText" role="status" aria-live="polite"></div>
	</div>

	<div class="nav">
		<button class="btn btn-sec" id="prev" aria-label="前のステップ">← 前へ</button>
		<button class="btn btn-pri" id="next" aria-label="次のステップ">次へ →</button>
	</div>

	<div class="actions-title">このステップで使うアクション</div>
	<div class="action-row">
		<button class="act-btn" id="openPin" aria-label="ピンビジュアライザを開く">◉ ピンを確認</button>
		<button class="act-btn" id="runBuild" aria-label="ビルドを実行">▶ ビルド実行</button>
		<button class="act-btn" id="runFlash" aria-label="書込みを実行">⬇ 書込み実行</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		const steps = ${stepsJson};
		let idx = 0;
		const tracker = document.getElementById('tracker');
		const stepNum = document.getElementById('stepNum');
		const stepText = document.getElementById('stepText');
		const prevBtn = document.getElementById('prev');
		const nextBtn = document.getElementById('next');

		for (let i = 0; i < ${stepCount}; i++) {
			const d = document.createElement('div');
			d.className = 'dot';
			d.id = 'dot' + i;
			tracker.appendChild(d);
		}

		function render() {
			stepNum.textContent = 'Step ' + (idx + 1) + ' / ' + steps.length;
			stepText.textContent = steps[idx];
			prevBtn.disabled = idx === 0;
			nextBtn.textContent = idx === steps.length - 1 ? '完了 ✓' : '次へ →';
			for (let i = 0; i < steps.length; i++) {
				const d = document.getElementById('dot' + i);
				d.className = 'dot' + (i < idx ? ' done' : i === idx ? ' active' : '');
			}
		}

		prevBtn.addEventListener('click', () => { if (idx > 0) { idx--; render(); } });
		nextBtn.addEventListener('click', () => {
			if (idx < steps.length - 1) { idx++; render(); }
			else { vscode.postMessage({ type: 'complete' }); }
		});

		for (const id of ['runBuild','runFlash','openPin']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
		render();
	</script>
</body>
</html>`;
}

function getTemplateGalleryHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;

	const categories: Record<string, { icon: string; items: string[] }> = {
		'初級 — GPIO / UART': { icon: '🌱', items: ['GPIO Blinky (F4)', 'UART Hello (F4)', 'EXTI Button IRQ', 'ADC Polling', 'DAC Wave Output'] },
		'中級 — 通信 / タイマー': { icon: '⚙', items: ['I2C Sensor Read (F4)', 'SPI IMU (F4)', 'Timer PWM Basic', 'ADC + DMA', 'CAN Loopback', 'RTC Calendar'] },
		'上級 — USB / RTOS': { icon: '🚀', items: ['USB CDC Device', 'USB HID Device', 'FreeRTOS 2 Tasks', 'FreeRTOS Queue', 'FreeRTOS Mutex', 'LwIP TCP Echo', 'LwIP HTTP Basic'] },
		'ストレージ / フラッシュ': { icon: '💾', items: ['FatFS SD Card', 'QSPI External Flash', 'Bootloader UART'] },
		'電源 / セキュリティ': { icon: '🔒', items: ['Low Power STOP Mode', 'Watchdog IWDG', 'Crypto AES (L5)', 'CMSIS-DSP FIR'] },
		'産業 / モーター': { icon: '🔧', items: ['Modbus RTU Slave', 'Motor PWM + Encoder', 'Hall Sensor Capture'] },
		'ワイヤレス / マルチボード': { icon: '📡', items: ['BLE UART Bridge (WB)', 'Multi-board Workspace Sample'] },
		'H7 / L4 / WB ターゲット': { icon: '🎯', items: ['Ethernet TCP (H7)', 'FMC SDRAM (H7)', 'Low Power LPUART (L4)', 'Touch Sense (L4)', 'BLE Custom Profile (WB)'] },
		'F1 / G0 エントリ': { icon: '🔵', items: ['Blue Pill Blinky (F1)', 'Blue Pill UART (F1)', 'G0 Nucleo Blinky', 'G0 Low Power'] },
		'U5 / C0 最新シリーズ': { icon: '⚡', items: ['U5 TrustZone Blinky', 'U5 Low Power LPUART', 'C0 Minimal Blinky', 'C0 UART Echo'] },
	};

	const sections = Object.entries(categories).map(([cat, { icon, items }]) => {
		const cards = items.map(name =>
			`<button class="tcard" data-template="${escapeHtml(name)}" aria-label="テンプレート ${escapeHtml(name)} を選択">${escapeHtml(name)}</button>`
		).join('');
		return `<div class="cat-section"><div class="cat-hd"><span class="cat-ic">${icon}</span>${escapeHtml(cat)}</div><div class="tgrid">${cards}</div></div>`;
	}).join('');

	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e;--ac2:rgba(15,118,110,.14)}
		body{font:13px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:24px 28px}
		.page-hd{margin-bottom:20px}
		h1{font-size:18px;font-weight:700;margin-bottom:4px}
		.sub{font-size:12px;color:var(--mt)}
		.search-row{margin-bottom:18px}
		#search{width:100%;padding:7px 12px;border-radius:7px;border:1px solid var(--bd);background:var(--sf);color:var(--tx);font:13px var(--vscode-font-family,'Segoe UI',sans-serif);outline:none;transition:border-color .15s}
		#search:focus{border-color:rgba(15,118,110,.6)}
		#search::placeholder{color:var(--mt)}
		.cat-section{margin-bottom:20px}
		.cat-hd{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mt);margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--bd)}
		.cat-ic{font-size:14px}
		.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:7px}
		.tcard{text-align:left;border:1px solid var(--bd);border-radius:7px;padding:9px 11px;background:var(--sf);color:var(--tx);cursor:pointer;font:13px var(--vscode-font-family,'Segoe UI',sans-serif);transition:background .1s,border-color .1s;line-height:1.3}
		.tcard:hover{background:var(--ac2);border-color:rgba(15,118,110,.48)}
		.tcard:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
		.tcard.hidden{display:none}
	</style>
</head>
<body>
	<div class="page-hd">
		<h1>テンプレートギャラリー</h1>
		<p class="sub">30種のプロジェクト雛形から選択してプロジェクトを作成します</p>
	</div>
	<div class="search-row">
		<input id="search" type="text" placeholder="テンプレートを検索..." aria-label="テンプレート検索" />
	</div>
	<div id="gallery">${sections}</div>
	<script>
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('.tcard').forEach(node => {
			node.addEventListener('click', () => vscode.postMessage({ template: node.dataset.template }));
		});
		document.getElementById('search').addEventListener('input', function() {
			const q = this.value.toLowerCase();
			document.querySelectorAll('.tcard').forEach(c => {
				c.classList.toggle('hidden', q.length > 0 && !c.textContent.toLowerCase().includes(q));
			});
			document.querySelectorAll('.cat-section').forEach(s => {
				const visible = Array.from(s.querySelectorAll('.tcard')).some(c => !c.classList.contains('hidden'));
				s.style.display = visible ? '' : 'none';
			});
		});
	</script>
</body>
</html>`;
}

function buildLqfpSvg(pins: Array<{ pin: string; mode: string }>): string {
	const sorted = [...pins].sort(comparePinNames);
	const n = sorted.length;
	if (n === 0) { return '<text x="10" y="20" fill="#6B7280" font-size="12">ピンなし</text>'; }

	const perSide = Math.ceil(n / 4);
	const PIN_PITCH = n > 120 ? 18 : n > 80 ? 20 : 22;
	const PIN_LEN = n > 120 ? 14 : 16;
	const PIN_W = n > 120 ? 5 : 6;
	const CHIP_SIZE = perSide * PIN_PITCH + 14;
	const OFFSET = PIN_LEN + 2;
	const TOTAL = CHIP_SIZE + OFFSET * 2;

	const sides: Array<{ pin: string; mode: string }[]> = [[], [], [], []];
	for (let i = 0; i < sorted.length; i++) {
		sides[Math.min(3, Math.floor(i / perSide))].push(sorted[i]);
	}

	let elements = '';

	// chip body
	elements += `<rect x="${OFFSET}" y="${OFFSET}" width="${CHIP_SIZE}" height="${CHIP_SIZE}" rx="4" fill="#1a1d2e" stroke="#374151" stroke-width="1.2"/>`;
	// notch top-left
	elements += `<path d="M${OFFSET + 12},${OFFSET} A12,12 0 0,0 ${OFFSET},${OFFSET + 12}" fill="#0d0e14" stroke="#374151" stroke-width="1"/>`;
	// chip label
	elements += `<text x="${OFFSET + CHIP_SIZE / 2}" y="${OFFSET + CHIP_SIZE / 2 - 6}" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="Segoe UI,sans-serif">STM32</text>`;
	elements += `<text x="${OFFSET + CHIP_SIZE / 2}" y="${OFFSET + CHIP_SIZE / 2 + 6}" text-anchor="middle" fill="#6b7280" font-size="8" font-family="Segoe UI,sans-serif">LQFP${n}</text>`;

	const renderPin = (item: { pin: string; mode: string }, index: number, side: number) => {
		const isUnused = item.mode === '未使用';
		const fill = isUnused ? '#161820' : colorForMode(item.mode);
		const stroke = isUnused ? '#2a2d3a' : colorForModeBorder(item.mode);
		const label = item.pin.length > 6 ? item.pin.slice(0, 5) + '…' : item.pin;
		const pos = 7 + index * PIN_PITCH + PIN_PITCH / 2;

		let rx = 0, ry = 0, anchor = 'middle', lx = 0, ly = 0;
		if (side === 0) { // bottom
			rx = OFFSET + pos - PIN_W / 2; ry = OFFSET + CHIP_SIZE; lx = OFFSET + pos; ly = OFFSET + CHIP_SIZE + PIN_LEN + 12; anchor = 'middle';
		} else if (side === 1) { // left
			rx = 0; ry = OFFSET + pos - PIN_W / 2; lx = PIN_LEN - 4; ly = OFFSET + pos + 4; anchor = 'end';
		} else if (side === 2) { // top
			rx = OFFSET + CHIP_SIZE - pos - PIN_W / 2; ry = 0; lx = OFFSET + CHIP_SIZE - pos; ly = PIN_LEN - 4; anchor = 'middle';
		} else { // right
			rx = OFFSET + CHIP_SIZE; ry = OFFSET + CHIP_SIZE - pos - PIN_W / 2; lx = TOTAL - PIN_LEN + 4; ly = OFFSET + CHIP_SIZE - pos + 4; anchor = 'start';
		}

		const pinRect = (side === 0 || side === 2)
			? `<rect x="${rx}" y="${ry}" width="${PIN_W}" height="${PIN_LEN}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`
			: `<rect x="${rx}" y="${ry}" width="${PIN_LEN}" height="${PIN_W}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;

		const pinNum = sides.slice(0, side).reduce((a, s) => a + s.length, 0) + index + 1;
		let nx = 0, ny = 0, nanchor = 'middle';
		if (side === 0) { nx = rx + PIN_W / 2; ny = ry + PIN_LEN - 3; nanchor = 'middle'; }
		else if (side === 1) { nx = rx + PIN_LEN - 3; ny = ry + PIN_W / 2 + 3; nanchor = 'end'; }
		else if (side === 2) { nx = rx + PIN_W / 2; ny = ry + 7; nanchor = 'middle'; }
		else { nx = rx + 3; ny = ry + PIN_W / 2 + 3; nanchor = 'start'; }

		return `<g class="lqfp-pin" data-pin="${escapeHtml(item.pin)}" data-mode="${escapeHtml(item.mode)}" data-num="${pinNum}" role="button" tabindex="0" aria-label="${pinNum}: ${escapeHtml(item.pin)}: ${escapeHtml(item.mode)}">`
			+ pinRect
			+ `<text x="${nx}" y="${ny}" text-anchor="${nanchor}" fill="rgba(255,255,255,.75)" font-size="5" font-family="Segoe UI,sans-serif" pointer-events="none">${pinNum}</text>`
			+ `<text x="${lx}" y="${ly}" text-anchor="${anchor}" fill="#d1d5db" font-size="7" font-family="Segoe UI,sans-serif" pointer-events="none">${escapeHtml(label)}</text>`
			+ `</g>`;
	};

	for (let s = 0; s < 4; s++) {
		for (let i = 0; i < sides[s].length; i++) {
			elements += renderPin(sides[s][i], i, s);
		}
	}

	return `<svg viewBox="0 0 ${TOTAL} ${TOTAL}" width="${TOTAL}" height="${TOTAL}" aria-label="LQFP チップ図" role="img">${elements}</svg>`;
}

function comparePinNames(a: { pin: string }, b: { pin: string }): number {
	const re = /^([A-Za-z]+)(\d+)$/;
	const ma = a.pin.match(re);
	const mb = b.pin.match(re);
	if (!ma || !mb) { return a.pin.localeCompare(b.pin); }
	const portCmp = ma[1].localeCompare(mb[1]);
	return portCmp !== 0 ? portCmp : parseInt(ma[2], 10) - parseInt(mb[2], 10);
}

function getPinVisualizerHtml(webview: vscode.Webview, pins: Array<{ pin: string; mode: string }>, iocPath: string | undefined, iocSettings: IocFullSettings = { pinAssignments: {}, pinGpioConfigs: {}, nvicSettings: {}, dmaLines: [], paramSettings: {}, userConstants: [], systemSettings: {} }): string {
	const csp = webview.cspSource;

	const sorted = [...pins].sort(comparePinNames);

	const groupMap = new Map<string, Array<{ pin: string; mode: string }>>();
	for (const item of sorted) {
		const portMatch = item.pin.match(/^([A-Za-z]+)/);
		const portKey = portMatch ? portMatch[1].toUpperCase() : '?';
		let arr = groupMap.get(portKey);
		if (!arr) { arr = []; groupMap.set(portKey, arr); }
		arr.push(item);
	}

	const cardHtml = Array.from(groupMap.entries()).map(([port, items]) => {
		const cards = items.map(item => {
			const color = colorForMode(item.mode);
			const border = colorForModeBorder(item.mode);
			const modeShort = item.mode.length > 20 ? item.mode.slice(0, 19) + '…' : item.mode;
			return `<button class="pin-card" data-pin="${escapeHtml(item.pin)}"
				style="background:${color};border-color:${border}"
				aria-label="${escapeHtml(item.pin)}: ${escapeHtml(item.mode)}"
				title="${escapeHtml(item.mode)}">
				<span class="pin-name">${escapeHtml(item.pin)}</span>
				<span class="pin-mode">${escapeHtml(modeShort)}</span>
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
		{ color: '#1f4d7a', border: '#38bdf8', label: 'SPI' },
		{ color: '#7c1d1d', border: '#ef4444', label: 'ADC' },
		{ color: '#1a3050', border: '#3b82f6', label: 'TIM/PWM' },
		{ color: '#1e2030', border: '#4b5563', label: 'その他' },
	];
	const legendHtml = legend.map(l =>
		`<span class="lg-item"><span class="lg-dot" style="background:${l.color};border-color:${l.border}"></span>${escapeHtml(l.label)}</span>`
	).join('');

	const chipSvg = buildLqfpSvg(sorted);

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
				<td><input class="s-inp" type="text" data-key="${escapeHtml(labelKey)}" value="${escapeHtml(cfg['GPIO_Label'] ?? '')}" placeholder="ラベル" /></td>
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
	const nvicEmpty = nvicRows ? '' : '<tr><td colspan="4" class="s-empty">.ioc に NVIC 設定がありません。CubeMX でペリフェラルを有効化してから同期してください。</td></tr>';

	// DMA Settings tab
	const dmaRows = iocSettings.dmaLines.map(({ key, value }) =>
		`<tr>
			<td><code class="s-code">${escapeHtml(key)}</code></td>
			<td><input class="s-inp" type="text" data-key="${escapeHtml(key)}" value="${escapeHtml(value)}" /></td>
			<td><button class="s-del-btn" data-removekey="${escapeHtml(key)}" title="削除">✕</button></td>
		</tr>`
	).join('');
	const dmaEmpty = dmaRows ? '' : '<tr><td colspan="3" class="s-empty">DMA 設定はありません。</td></tr>';

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
					<td><button class="s-del-btn" data-removekey="${escapeHtml(key)}" title="削除">✕</button></td>
				</tr>`;
			}).join('');
			return `<div class="s-pgrp">
				<div class="s-pgrp-hd">${escapeHtml(grp)}</div>
				<table class="s-table"><tbody>${rows}</tbody></table>
			</div>`;
		}).join('');
	const paramEmpty = paramGroupsHtml ? '' : '<p class="s-empty-p">パラメータ設定はありません。</p>';

	// User Constants tab
	const constRows = iocSettings.userConstants.map((c, i) =>
		`<tr>
			<td><input class="s-inp s-const-name" type="text" data-idx="${i}" value="${escapeHtml(c.name)}" placeholder="定数名" /></td>
			<td><input class="s-inp s-const-val" type="text" data-idx="${i}" value="${escapeHtml(c.value)}" placeholder="値" /></td>
			<td><button class="s-del-btn s-const-del" data-idx="${i}" title="削除">✕</button></td>
		</tr>`
	).join('');

	// Serialize iocSettings for JS usage
	const modeOptionsHtml = Object.entries(PIN_MODE_GROUPS)
		.map(([grp, modes]) =>
			`<optgroup label="${escapeHtml(grp)}">` +
			modes.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('') +
			`</optgroup>`
		).join('');

	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#0f766e}
		body{font:13px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:16px 20px}
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
		.pin-grid{display:flex;flex-wrap:wrap;gap:3px}
		.pin-card{display:flex;flex-direction:column;align-items:flex-start;padding:3px 6px;border:1.2px solid;border-radius:5px;cursor:pointer;min-width:76px;text-align:left;transition:filter .1s,box-shadow .1s}
		.pin-card:hover{filter:brightness(1.18);box-shadow:0 0 0 2px rgba(255,255,255,.08)}
		.pin-card:focus{outline:2px solid #fff;outline-offset:2px}
		.pin-name{font-size:11px;font-weight:700;color:#e8eaed;line-height:1.15}
		.pin-mode{font-size:9px;color:rgba(232,234,237,.65);margin-top:0;line-height:1.1}
		.empty-msg{color:var(--mt);font-size:13px;margin-top:20px}
		.hint{font-size:11px;color:var(--mt);margin-bottom:14px}
		#chipView{overflow:auto;border:1px solid var(--bd);border-radius:8px;background:#13151e;padding:6px;display:block}
		#chipView .lqfp-pin{cursor:pointer}
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
		<button class="stab-btn active" data-show="tab-pins" role="tab" aria-selected="true">📌 ピン設定</button>
		<button class="stab-btn" data-show="tab-gpio" role="tab" aria-selected="false">⚡ GPIO設定</button>
		<button class="stab-btn" data-show="tab-nvic" role="tab" aria-selected="false">🔔 NVIC設定</button>
		<button class="stab-btn" data-show="tab-dma" role="tab" aria-selected="false">↔ DMA設定</button>
		<button class="stab-btn" data-show="tab-param" role="tab" aria-selected="false">⚙ パラメータ設定</button>
		<button class="stab-btn" data-show="tab-const" role="tab" aria-selected="false">🔑 ユーザー定数</button>
	</div>

	<!-- ===== Pin Visualizer Panel ===== -->
	<div id="tab-pins" class="stab-panel active">
		<div class="toolbar">
			<div class="chip-hdr">
				<h1>STM32 ピンビジュアライザ</h1>
				<div class="path">${iocPath ? escapeHtml(iocPath) : '.ioc ファイルなし — MCU パッケージ JSON フォールバック'}</div>
			</div>
			<div class="search-wrap">
				<span class="ic">🔍</span>
				<input id="filterInput" type="search" placeholder="ピン名 / モードで絞込み" aria-label="ピン絞込み" />
			</div>
			<div class="view-toggle" role="group" aria-label="表示切替">
				<button id="btnList" class="vtbtn" aria-pressed="false">リスト</button>
				<button id="btnChip" class="vtbtn active" aria-pressed="true">チップ図</button>
			</div>
			<button id="btnAddPin" class="vtbtn" style="border-color:rgba(15,118,110,.45)" aria-label="ピンを追加">+ ピン追加</button>
			<span class="pin-count" id="pinCount">${sorted.length} ピン</span>
		</div>
		<div class="hint">ピンをクリックするとモードを変更して .ioc に反映できます</div>
		<div class="legend" aria-label="カラーレジェンド">${legendHtml}</div>
		<div id="groupsView">${cardHtml || '<p class="empty-msg">.ioc ファイルが見つからないか、ピン情報を解析できませんでした。</p>'}</div>
		<div id="chipView">
			<div class="zoom-row">
				<button class="zbtn" id="zoomIn" title="拡大 (+)" aria-label="拡大">+</button>
				<span class="zoom-label" id="zoomLabel">100%</span>
				<button class="zbtn" id="zoomOut" title="縮小 (-)" aria-label="縮小">−</button>
				<button class="zbtn" id="zoomReset" title="リセット" aria-label="リセット" style="width:auto;padding:0 8px;font-size:11px">リセット</button>
			</div>
			<div id="chipWrap"><div id="chipSvg">${chipSvg}</div></div>
		</div>
	</div>
	<div id="pinTooltip"><div class="tt-num"></div><div class="tt-pin"></div><div class="tt-mode"></div></div>

	<!-- ===== GPIO Settings Panel ===== -->
	<div id="tab-gpio" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title">GPIO 詳細設定</span>
			<button class="s-save-btn" id="saveGpio">💾 保存</button>
		</div>
		<table class="s-table">
			<thead><tr><th>ピン</th><th>割当モード</th><th>GPIO Mode</th><th>Speed</th><th>Pull</th><th>ユーザーラベル</th></tr></thead>
			<tbody>${gpioRows || '<tr><td colspan="6" class="s-empty">GPIO 設定可能なピンがありません。まずピン設定タブでピンを割り当ててください。</td></tr>'}</tbody>
		</table>
	</div>

	<!-- ===== NVIC Settings Panel ===== -->
	<div id="tab-nvic" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title">NVIC 割込み設定</span>
			<button class="s-save-btn" id="saveNvic">💾 保存</button>
		</div>
		<table class="s-table">
			<thead><tr><th>割込み名 (IRQ)</th><th>有効</th><th>PreemptPriority</th><th>SubPriority</th></tr></thead>
			<tbody>${nvicRows}${nvicEmpty}</tbody>
		</table>
	</div>

	<!-- ===== DMA Settings Panel ===== -->
	<div id="tab-dma" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title">DMA 設定</span>
			<button class="s-save-btn" id="saveDma">💾 保存</button>
		</div>
		<table class="s-table">
			<thead><tr><th>キー</th><th>値</th><th></th></tr></thead>
			<tbody>${dmaRows}${dmaEmpty}</tbody>
		</table>
	</div>

	<!-- ===== Parameter Settings Panel ===== -->
	<div id="tab-param" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title">パラメータ設定</span>
			<button class="s-save-btn" id="saveParam">💾 保存</button>
		</div>
		${paramGroupsHtml}${paramEmpty}
	</div>

	<!-- ===== User Constants Panel ===== -->
	<div id="tab-const" class="stab-panel">
		<div class="s-panel-hd">
			<span class="s-panel-title">ユーザー定数 (ProjectManager.UserConstants)</span>
			<button class="s-save-btn" id="saveConst">💾 保存</button>
		</div>
		<table class="s-table">
			<thead><tr><th>定数名</th><th>値</th><th></th></tr></thead>
			<tbody id="constBody">${constRows}</tbody>
		</table>
		<button class="s-add-btn" id="addConst">+ 定数を追加</button>
	</div>

	<!-- ===== Dialogs ===== -->
	<div id="addDlgBackdrop" role="dialog" aria-modal="true" aria-labelledby="addDlgTitle">
		<div id="addDlgBox">
			<div id="addDlgTitle">ピンを追加</div>
			<div class="add-row">
				<label class="add-lbl" for="addPinInput">ピン名 (PA0 — PK15)</label>
				<input id="addPinInput" type="text" placeholder="例: PA5" autocomplete="off" spellcheck="false" />
				<div id="addPinErr"></div>
			</div>
			<div class="add-row">
				<label class="add-lbl" for="addModeSelect">モード</label>
				<select id="addModeSelect">${modeOptionsHtml}</select>
			</div>
			<div id="addDlgActions">
				<button id="addDlgCancel" class="dlg-btn" style="background:transparent;border-color:#374151;color:#9ca3af">キャンセル</button>
				<button id="addDlgApply" class="dlg-btn" style="background:#0f766e;border-color:#0f766e;color:#fff">追加</button>
			</div>
		</div>
	</div>

	<div id="dlgBackdrop" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
		<div id="dlgBox">
			<div id="dlgTitle">ピン編集</div>
			<div id="dlgCur">現在のモード: —</div>
			<input id="dlgSearch" type="search" placeholder="モードを検索..." aria-label="モード検索" />
			<div id="dlgGroups"></div>
			<div id="dlgActions">
				<button id="dlgCancel" class="dlg-btn">キャンセル</button>
				<button id="dlgApply" class="dlg-btn" disabled>適用</button>
			</div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

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
			if (confirm('キー「' + key + '」を削除しますか？')) {
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
			tr.innerHTML = '<td><input class="s-inp s-const-name" type="text" value="' + (name || '').replace(/"/g, '&quot;') + '" placeholder="定数名" /></td>' +
				'<td><input class="s-inp s-const-val" type="text" value="' + (value || '').replace(/"/g, '&quot;') + '" placeholder="値" /></td>' +
				'<td><button class="s-del-btn s-const-del" title="削除">✕</button></td>';
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
			btn.addEventListener('click', () => vscode.postMessage({ type: 'editPin', pin: btn.dataset.pin }));
			btn.addEventListener('keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vscode.postMessage({ type: 'editPin', pin: btn.dataset.pin }); }
			});
		}
		for (const g of document.querySelectorAll('.lqfp-pin')) {
			g.addEventListener('click', () => vscode.postMessage({ type: 'editPin', pin: g.dataset.pin }));
			g.addEventListener('keydown', e => {
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
			dlgTitle.textContent = 'ピン編集 — ' + pin;
			dlgCur.textContent = '現在のモード: ' + (currentMode || '未設定');
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
		function openAddDialog() {
			addPinInput.value = ''; addPinErr.textContent = '';
			addPinInput.classList.remove('invalid'); addModeSelect.selectedIndex = 0;
			addDlgBackdrop.classList.add('open');
			setTimeout(() => addPinInput.focus(), 60);
		}
		document.getElementById('btnAddPin').addEventListener('click', openAddDialog);
		addDlgCancel.addEventListener('click', closeAddDialog);
		addDlgBackdrop.addEventListener('click', e => { if (e.target === addDlgBackdrop) { closeAddDialog(); } });
		addPinInput.addEventListener('input', () => {
			const ok = PIN_RE.test(addPinInput.value.trim());
			addPinInput.classList.toggle('invalid', addPinInput.value.length > 0 && !ok);
			addPinErr.textContent = (addPinInput.value.length > 0 && !ok) ? '形式エラー: PA0–PK15 の形式で入力してください' : '';
		});
		addDlgApply.addEventListener('click', () => {
			const pin = addPinInput.value.trim().toUpperCase();
			if (!PIN_RE.test(pin)) { addPinErr.textContent = '有効なピン名を入力してください。'; addPinInput.classList.add('invalid'); return; }
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
					const pin = (card.dataset.pin || '').toLowerCase();
					const mode = (card.getAttribute('title') || '').toLowerCase();
					const show = !q || pin.includes(q) || mode.includes(q);
					card.style.display = show ? '' : 'none';
					if (show) { groupVisible++; visible++; }
				}
				group.classList.toggle('hidden', groupVisible === 0);
			}
			const hasQ = q.length > 0;
			for (const g of document.querySelectorAll('.lqfp-pin')) {
				const pin = (g.dataset.pin || '').toLowerCase();
				const mode = (g.dataset.mode || '').toLowerCase();
				const matches = !hasQ || pin.includes(q) || mode.includes(q);
				g.classList.toggle('dim', hasQ && !matches);
				g.classList.toggle('match', hasQ && matches);
			}
			pinCountEl.textContent = q ? visible + ' ピン (絞込み中)' : visible + ' ピン';
		}
		filterInput.addEventListener('input', () => applyFilter(filterInput.value.trim().toLowerCase()));
	</script>
</body>
</html>`;
}

function colorForMode(mode: string): string {
	const value = mode.toLowerCase();
	if (value.includes('gpio_output')) { return '#0f4c5c'; }
	if (value.includes('gpio_input')) { return '#1a4731'; }
	if (value.includes('usart') || value.includes('uart')) { return '#7c3a00'; }
	if (value.includes('i2c')) { return '#6d1a4c'; }
	if (value.includes('spi')) { return '#1f4d7a'; }
	if (value.includes('adc')) { return '#7c1d1d'; }
	if (value.includes('tim') || value.includes('pwm')) { return '#1a3050'; }
	return '#1e2030';
}

function colorForModeBorder(mode: string): string {
	const value = mode.toLowerCase();
	if (value.includes('gpio_output')) { return '#14b8a6'; }
	if (value.includes('gpio_input')) { return '#22c55e'; }
	if (value.includes('usart') || value.includes('uart')) { return '#f59e0b'; }
	if (value.includes('i2c')) { return '#ec4899'; }
	if (value.includes('spi')) { return '#38bdf8'; }
	if (value.includes('adc')) { return '#ef4444'; }
	if (value.includes('tim') || value.includes('pwm')) { return '#3b82f6'; }
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
