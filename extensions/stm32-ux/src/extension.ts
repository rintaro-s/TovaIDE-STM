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
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('stm32-ux.onboardingView', new OnboardingViewProvider()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openWelcomeWizard', () => openWelcomeWizard()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.startBlinkTutorial', () => openBlinkTutorial()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openTemplateGallery', () => openTemplateGallery()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.runEnvironmentCheck', () => runEnvironmentCheck()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.explainLatestError', () => explainLatestError()));
	context.subscriptions.push(vscode.commands.registerCommand('stm32ux.openPinVisualizer', () => openPinVisualizer()));

	const shouldOpenWelcome = vscode.workspace.getConfiguration('stm32ux').get<boolean>('autoOpenWelcome', true);
	const hasShown = context.workspaceState.get<boolean>('stm32ux.welcomeShown', false);
	if (shouldOpenWelcome && !hasShown) {
		void openWelcomeWizard();
		void context.workspaceState.update('stm32ux.welcomeShown', true);
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
				case 'welcome':
					await openWelcomeWizard();
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

async function openWelcomeWizard(): Promise<void> {
	const panel = vscode.window.createWebviewPanel('stm32ux.welcome', 'STM32 ウェルカム', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = getWelcomeHtml(panel.webview);
	panel.webview.onDidReceiveMessage(async message => {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
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

async function runEnvironmentCheck(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const configuredCubeMx = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	const configuredMetadata = vscode.workspace.getConfiguration('stm32').get<string>('cubeclt.metadataPath', '').trim();

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
		rows.push(`- ${tool.id}: ${foundPath ? `✅ ${foundPath}` : '❌ 未検出 (PATH に含まれていません)'}`);
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
		'- STM32_Programmer_CLI が未検出の場合、CubeCLT メタデータ検出を実行してください',
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

function resolveMcuJsonName(mcuKey: string): string {
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
	return map[mcuKey] ?? 'STM32F446RE';
}

async function loadMcuPackagePins(mcuName?: string): Promise<Array<{ pin: string; mode: string }>> {
	const fileName = resolveMcuJsonName(mcuName ?? 'STM32F446RE');
	try {
		const jsonUri = vscode.Uri.joinPath(extensionUri, '..', '..', 'resources', 'stm32', 'mcu', `${fileName}.json`);
		const bytes = await vscode.workspace.fs.readFile(jsonUri);
		let text = '';
		for (const value of bytes) { text += String.fromCharCode(value); }
		const data = JSON.parse(text) as { pins?: Array<{ pin: string; mode: string }> };
		return (data.pins ?? []).slice(0, 64);
	} catch {
		return [];
	}
}

async function openPinVisualizer(): Promise<void> {
	const iocUri = await findIocFile();
	const panel = vscode.window.createWebviewPanel('stm32ux.pinVisualizer', 'STM32 ピンビジュアライザ', vscode.ViewColumn.Active, { enableScripts: true });
	const render = async (): Promise<void> => {
		let pins: Array<{ pin: string; mode: string }> = [];
		let detectedMcu: string | undefined;
		if (iocUri) {
			const bytes = await vscode.workspace.fs.readFile(iocUri);
			let text = '';
			for (const value of bytes) {
				text += String.fromCharCode(value);
			}
			pins = parsePinLines(text);
			detectedMcu = detectMcuFromIocText(text);
			panel.title = `STM32 ピンビジュアライザ — ${detectedMcu}`;
		} else {
			pins = await loadMcuPackagePins();
			panel.title = 'STM32 ピンビジュアライザ — STM32F446RE (デフォルト)';
		}
		panel.webview.html = getPinVisualizerHtml(panel.webview, pins, iocUri?.fsPath);
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
					'# Generated by CubeForge Pin Visualizer',
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
			if (activeIocUri) {
				const bytes = await vscode.workspace.fs.readFile(activeIocUri);
				let text = '';
				for (const value of bytes) { text += String.fromCharCode(value); }
				const m = text.match(new RegExp(`^${message.pin}=([^\\r\\n]+)`, 'm'));
				if (m) { currentMode = m[1]; }
			}
			await panel.webview.postMessage({ type: 'openDialog', pin: message.pin, currentMode, groups: PIN_MODE_GROUPS });
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
					'# Generated by CubeForge Pin Visualizer',
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
	const oldBytes = await vscode.workspace.fs.readFile(iocUri);
	let oldText = '';
	for (const value of oldBytes) {
		oldText += String.fromCharCode(value);
	}

	const linePattern = new RegExp(`^${pin}=[^\\r\\n]*$`, 'm');
	const newLine = `${pin}=${mode}`;
	let newText = oldText;
	if (linePattern.test(oldText)) {
		newText = oldText.replace(linePattern, newLine);
	} else {
		const suffix = oldText.endsWith('\n') ? '' : '\n';
		newText = `${oldText}${suffix}${newLine}\n`;
	}

	if (newText === oldText) {
		return false;
	}

	await writeTextFile(iocUri, newText);
	return true;
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
	const result: Array<{ pin: string; mode: string }> = [];
	for (const line of text.split(/\r?\n/)) {
		const matched = line.match(/^(P[A-K][0-9]{1,2})=([^\r\n]+)/);
		if (!matched) {
			continue;
		}
		result.push({ pin: matched[1], mode: matched[2] });
	}
	return result.slice(0, 64);
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

function getOnboardingHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	const items = [
		{ id: 'welcome', ic: '⬡', label: 'ウェルカムウィザード', desc: '初回セットアップ' },
		{ id: 'tutorial', ic: '▶', label: 'Lチカチュートリアル', desc: '7ステップ入門ガイド' },
		{ id: 'templates', ic: '◫', label: 'テンプレートギャラリー', desc: '30種のプロジェクト雛形' },
		{ id: 'env', ic: '✓', label: '環境チェック', desc: 'ツール検出レポート' },
		{ id: 'pin', ic: '◉', label: 'ピンビジュアライザ', desc: 'IOCピン配置を可視化' },
		{ id: 'error', ic: '⚑', label: 'エラー自動解説', desc: 'ビルドエラーを日本語で' },
	];
	const cards = items.map(it =>
		`<button class="card" id="${it.id}" aria-label="${escapeHtml(it.label)}">` +
		`<span class="ic">${it.ic}</span>` +
		`<span class="body"><span class="lbl">${escapeHtml(it.label)}</span>` +
		`<span class="desc">${escapeHtml(it.desc)}</span></span>` +
		`<span class="arr">›</span></button>`
	).join('');
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
			--ac:#6366f1;--ac2:rgba(99,102,241,.12);
		}
		body{font:12px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);padding:6px;background:var(--sf);color:var(--tx)}
		.card{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;margin-bottom:3px;background:transparent;border:1px solid var(--bd);border-radius:7px;color:var(--tx);cursor:pointer;font:inherit;text-align:left;transition:background .1s,border-color .1s}
		.card:hover{background:var(--ac2);border-color:rgba(99,102,241,.4)}
		.card:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
		.ic{width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--ac2);color:var(--ac);font-size:12px;flex-shrink:0}
		.body{flex:1;display:flex;flex-direction:column;gap:1px;min-width:0}
		.lbl{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.desc{font-size:10px;color:var(--mt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.arr{color:var(--mt);font-size:14px;flex-shrink:0}
	</style>
</head>
<body>
${cards}
<script>
	const vscode = acquireVsCodeApi();
	for (const id of ['welcome','tutorial','templates','env','pin','error']) {
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
		*{box-sizing:border-box;margin:0;padding:0}
		:root{
			--bg:var(--vscode-editor-background,#0d0e14);
			--sf:var(--vscode-sideBar-background,#13151e);
			--bd:var(--vscode-panel-border,#1e2030);
			--tx:var(--vscode-editor-foreground,#e8eaed);
			--mt:var(--vscode-descriptionForeground,#6b7280);
			--ac:#6366f1;--ac2:rgba(99,102,241,.12);
			--ok:#22c55e;--wn:#f59e0b;
		}
		body{font:13px/1.6 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:0;min-height:100vh}
		.hero{background:linear-gradient(135deg,#0d0e14 0%,#131630 100%);border-bottom:1px solid var(--bd);padding:32px 28px 24px}
		.hero-logo{display:flex;align-items:center;gap:10px;margin-bottom:14px}
		.logo-mark{width:36px;height:36px;border-radius:8px;background:var(--ac);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;flex-shrink:0}
		.logo-text{font-size:20px;font-weight:700;letter-spacing:-.01em}
		.logo-sub{font-size:11px;color:var(--mt);letter-spacing:.04em;text-transform:uppercase;margin-top:1px}
		.hero p{font-size:13px;color:var(--mt);max-width:480px;line-height:1.6}
		.content{padding:24px 28px;max-width:900px}
		.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:24px}
		.card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s}
		.card:hover{border-color:rgba(99,102,241,.5)}
		.card-icon{font-size:22px;line-height:1}
		.card h3{font-size:14px;font-weight:600}
		.card p{font-size:12px;color:var(--mt);line-height:1.5;flex:1}
		.btn{padding:7px 14px;border-radius:6px;border:none;cursor:pointer;font:600 12px/1 var(--vscode-font-family,'Segoe UI',sans-serif);transition:background .1s}
		.btn:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
		.btn-pri{background:var(--ac);color:#fff}
		.btn-pri:hover{background:#4f52d9}
		.btn-sec{background:transparent;color:var(--tx);border:1px solid var(--bd)}
		.btn-sec:hover{background:var(--ac2);border-color:rgba(99,102,241,.4)}
		.btns{display:flex;flex-direction:column;gap:6px}
		.divider{height:1px;background:var(--bd);margin:8px 0 20px}
		.links{display:flex;gap:16px;flex-wrap:wrap}
		.link{background:none;border:none;color:var(--ac);cursor:pointer;font:12px var(--vscode-font-family,'Segoe UI',sans-serif);padding:0;text-decoration:underline;text-underline-offset:2px}
		.link:hover{color:#8183f4}
	</style>
</head>
<body>
<div class="hero">
	<div class="hero-logo">
		<div class="logo-mark">⬡</div>
		<div>
			<div class="logo-text">CubeForge IDE</div>
			<div class="logo-sub">STM32 Development Environment</div>
		</div>
	</div>
	<p>STM32マイコン開発のための統合開発環境です。<br>初心者からCubeIDEユーザーまで、すぐに開発を始められます。</p>
</div>

<div class="content">
	<div class="grid">
		<div class="card">
			<div class="card-icon">🌱</div>
			<h3>はじめて使う</h3>
			<p>STM32開発が初めての方向け。7ステップのLチカチュートリアルで基本的な開発フローを学べます。</p>
			<div class="btns">
				<button class="btn btn-pri" id="tutorial" aria-label="チュートリアルを開始">チュートリアルを開始 →</button>
				<button class="btn btn-sec" id="env" aria-label="環境チェック">環境チェックを実行</button>
			</div>
		</div>
		<div class="card">
			<div class="card-icon">🔄</div>
			<h3>CubeIDE から移行</h3>
			<p>STM32CubeIDEからの移行ユーザー向け。既存プロジェクトをインポートしてすぐに使い始められます。</p>
			<div class="btns">
				<button class="btn btn-pri" id="import" aria-label="CubeIDEインポート">CubeIDEプロジェクトをインポート →</button>
			</div>
		</div>
		<div class="card">
			<div class="card-icon">⚡</div>
			<h3>すぐに始める</h3>
			<p>テンプレートから新規プロジェクトを素早く作成。GPIO/UART/I2C/FreeRTOS等の30種類以上から選択できます。</p>
			<div class="btns">
				<button class="btn btn-pri" id="templates" aria-label="テンプレートギャラリー">テンプレートギャラリーを開く →</button>
			</div>
		</div>
	</div>

	<div class="divider"></div>

	<div class="links">
		<button class="link" id="env2" aria-label="環境チェック">ツール環境チェック</button>
		<button class="link" id="pin" aria-label="ピンビジュアライザ">ピンビジュアライザ</button>
		<button class="link" id="error" aria-label="エラー解説">エラー自動解説</button>
	</div>
</div>

<script>
	const vscode = acquireVsCodeApi();
	document.getElementById('tutorial').addEventListener('click', () => vscode.postMessage({ type: 'tutorial' }));
	document.getElementById('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));
	document.getElementById('templates').addEventListener('click', () => vscode.postMessage({ type: 'templates' }));
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
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#6366f1;--ac2:rgba(99,102,241,.12);--ok:#22c55e}
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
		.btn-pri:hover{background:#4f52d9;border-color:#4f52d9}
		.btn-sec{background:transparent;color:var(--tx)}
		.btn-sec:hover{background:var(--ac2);border-color:rgba(99,102,241,.4)}
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
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#6366f1;--ac2:rgba(99,102,241,.12)}
		body{font:13px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:24px 28px}
		.page-hd{margin-bottom:20px}
		h1{font-size:18px;font-weight:700;margin-bottom:4px}
		.sub{font-size:12px;color:var(--mt)}
		.search-row{margin-bottom:18px}
		#search{width:100%;padding:7px 12px;border-radius:7px;border:1px solid var(--bd);background:var(--sf);color:var(--tx);font:13px var(--vscode-font-family,'Segoe UI',sans-serif);outline:none;transition:border-color .15s}
		#search:focus{border-color:rgba(99,102,241,.6)}
		#search::placeholder{color:var(--mt)}
		.cat-section{margin-bottom:20px}
		.cat-hd{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mt);margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--bd)}
		.cat-ic{font-size:14px}
		.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:7px}
		.tcard{text-align:left;border:1px solid var(--bd);border-radius:7px;padding:9px 11px;background:var(--sf);color:var(--tx);cursor:pointer;font:13px var(--vscode-font-family,'Segoe UI',sans-serif);transition:background .1s,border-color .1s;line-height:1.3}
		.tcard:hover{background:var(--ac2);border-color:rgba(99,102,241,.45)}
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
	const PIN_PITCH = 28;
	const PIN_LEN = 22;
	const PIN_W = 8;
	const CHIP_SIZE = perSide * PIN_PITCH + 24;
	const OFFSET = PIN_LEN + 4;
	const TOTAL = CHIP_SIZE + OFFSET * 2;

	const sides: Array<{ pin: string; mode: string }[]> = [[], [], [], []];
	for (let i = 0; i < sorted.length; i++) {
		sides[Math.min(3, Math.floor(i / perSide))].push(sorted[i]);
	}

	let elements = '';

	// chip body
	elements += `<rect x="${OFFSET}" y="${OFFSET}" width="${CHIP_SIZE}" height="${CHIP_SIZE}" rx="6" fill="#1a1d2e" stroke="#374151" stroke-width="1.5"/>`;
	// notch top-left
	elements += `<path d="M${OFFSET + 12},${OFFSET} A12,12 0 0,0 ${OFFSET},${OFFSET + 12}" fill="#0d0e14" stroke="#374151" stroke-width="1"/>`;
	// chip label
	elements += `<text x="${OFFSET + CHIP_SIZE / 2}" y="${OFFSET + CHIP_SIZE / 2 - 8}" text-anchor="middle" fill="#9ca3af" font-size="11" font-family="Segoe UI,sans-serif">STM32</text>`;
	elements += `<text x="${OFFSET + CHIP_SIZE / 2}" y="${OFFSET + CHIP_SIZE / 2 + 8}" text-anchor="middle" fill="#6b7280" font-size="9" font-family="Segoe UI,sans-serif">LQFP${n}</text>`;

	const renderPin = (item: { pin: string; mode: string }, index: number, side: number) => {
		const fill = colorForMode(item.mode);
		const stroke = colorForModeBorder(item.mode);
		const label = item.pin.length > 6 ? item.pin.slice(0, 5) + '…' : item.pin;
		const pos = 12 + index * PIN_PITCH + PIN_PITCH / 2;

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
			+ `<text x="${nx}" y="${ny}" text-anchor="${nanchor}" fill="rgba(255,255,255,.75)" font-size="6" font-family="Segoe UI,sans-serif" pointer-events="none">${pinNum}</text>`
			+ `<text x="${lx}" y="${ly}" text-anchor="${anchor}" fill="#d1d5db" font-size="8" font-family="Segoe UI,sans-serif" pointer-events="none">${escapeHtml(label)}</text>`
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

function getPinVisualizerHtml(webview: vscode.Webview, pins: Array<{ pin: string; mode: string }>, iocPath: string | undefined): string {
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
		{ color: '#4f51b5', border: '#6366f1', label: 'GPIO Output' },
		{ color: '#1a4731', border: '#22c55e', label: 'GPIO Input' },
		{ color: '#7c3a00', border: '#f59e0b', label: 'UART/USART' },
		{ color: '#6d1a4c', border: '#ec4899', label: 'I2C' },
		{ color: '#4a1d8a', border: '#8b5cf6', label: 'SPI' },
		{ color: '#7c1d1d', border: '#ef4444', label: 'ADC' },
		{ color: '#1a3050', border: '#3b82f6', label: 'TIM/PWM' },
		{ color: '#1e2030', border: '#4b5563', label: 'その他' },
	];
	const legendHtml = legend.map(l =>
		`<span class="lg-item"><span class="lg-dot" style="background:${l.color};border-color:${l.border}"></span>${escapeHtml(l.label)}</span>`
	).join('');

	const chipSvg = buildLqfpSvg(sorted);

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
		:root{--bg:var(--vscode-editor-background,#0d0e14);--sf:var(--vscode-sideBar-background,#13151e);--bd:var(--vscode-panel-border,#1e2030);--tx:var(--vscode-editor-foreground,#e8eaed);--mt:var(--vscode-descriptionForeground,#6b7280);--ac:#6366f1}
		body{font:13px/1.5 var(--vscode-font-family,'Segoe UI',sans-serif);background:var(--bg);color:var(--tx);padding:18px 22px}
		.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
		.chip-hdr{flex:1;min-width:0}
		.chip-hdr h1{font-size:16px;font-weight:700;margin-bottom:2px}
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
		.port-group{margin-bottom:18px}
		.port-group.hidden{display:none}
		.port-hd{display:flex;align-items:center;gap:8px;margin-bottom:7px}
		.port-badge{font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:4px;background:var(--sf);border:1px solid var(--bd);color:var(--mt)}
		.port-count{font-size:11px;color:var(--mt)}
		.pin-grid{display:flex;flex-wrap:wrap;gap:6px}
		.pin-card{display:flex;flex-direction:column;align-items:flex-start;padding:6px 9px;border:1.5px solid;border-radius:7px;cursor:pointer;min-width:104px;text-align:left;transition:filter .1s,box-shadow .1s}
		.pin-card:hover{filter:brightness(1.18);box-shadow:0 0 0 2px rgba(255,255,255,.08)}
		.pin-card:focus{outline:2px solid #fff;outline-offset:2px}
		.pin-name{font-size:12px;font-weight:700;color:#e8eaed}
		.pin-mode{font-size:10px;color:rgba(232,234,237,.65);margin-top:1px}
		.empty-msg{color:var(--mt);font-size:13px;margin-top:20px}
		.hint{font-size:11px;color:var(--mt);margin-bottom:14px}
		#chipView{overflow:auto;border:1px solid var(--bd);border-radius:10px;background:#13151e;padding:12px;display:none}
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
		#groupsView{display:block}
		/* ---- pin edit dialog ---- */
		#dlgBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100}
		#dlgBackdrop.open{display:flex}
		#dlgBox{background:#1a1d2e;border:1px solid #374151;border-radius:12px;padding:20px 22px;width:min(520px,94vw);max-height:82vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
		#dlgTitle{font-size:14px;font-weight:700;color:#e8eaed}
		#dlgCur{font-size:11px;color:#9ca3af}
		#dlgSearch{background:#0d0e14;border:1px solid #374151;color:#e8eaed;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:100%}
		#dlgSearch:focus{border-color:#6366f1}
		#dlgGroups{overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px}
		.dg-hd{font-size:10px;font-weight:700;letter-spacing:.06em;color:#6b7280;text-transform:uppercase;margin-bottom:4px}
		.dg-chips{display:flex;flex-wrap:wrap;gap:5px}
		.dg-chip{padding:4px 10px;border-radius:6px;border:1.5px solid #374151;background:#0d0e14;color:#9ca3af;font-size:11px;cursor:pointer;transition:background .1s,border-color .1s}
		.dg-chip:hover{background:#1e2030;border-color:#6366f1;color:#e8eaed}
		.dg-chip.selected{background:#4f46e5;border-color:#6366f1;color:#fff;font-weight:600}
		.dg-chip.current{border-color:#22c55e;color:#86efac}
		.dg-section.hidden{display:none}
		.dg-chip.chip-hidden{display:none}
		#dlgActions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
		.dlg-btn{padding:6px 18px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid}
		#dlgCancel{background:transparent;border-color:#374151;color:#9ca3af}
		#dlgCancel:hover{border-color:#6b7280;color:#e8eaed}
		#dlgApply{background:#4f46e5;border-color:#6366f1;color:#fff}
		#dlgApply:hover{background:#4338ca}
		#dlgApply:disabled{opacity:.4;cursor:not-allowed}
		/* ---- add pin dialog ---- */
		#addDlgBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100}
		#addDlgBackdrop.open{display:flex}
		#addDlgBox{background:#1a1d2e;border:1px solid #374151;border-radius:12px;padding:20px 22px;width:min(420px,94vw);display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
		#addDlgTitle{font-size:14px;font-weight:700;color:#e8eaed}
		.add-row{display:flex;flex-direction:column;gap:4px}
		.add-lbl{font-size:11px;color:#9ca3af}
		#addPinInput{background:#0d0e14;border:1px solid #374151;color:#e8eaed;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:100%;font-family:monospace}
		#addPinInput:focus{border-color:#6366f1}
		#addPinInput.invalid{border-color:#ef4444}
		#addModeSelect{background:#0d0e14;border:1px solid #374151;color:#e8eaed;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:100%}
		#addModeSelect:focus{border-color:#6366f1}
		#addPinErr{font-size:11px;color:#ef4444;min-height:14px}
		#addDlgActions{display:flex;gap:8px;justify-content:flex-end}
	</style>
</head>
<body>
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
			<button id="btnList" class="vtbtn active" aria-pressed="true">リスト</button>
			<button id="btnChip" class="vtbtn" aria-pressed="false">チップ図</button>
		</div>
		<button id="btnAddPin" class="vtbtn" style="border-color:rgba(99,102,241,.4)" aria-label="ピンを追加">+ ピン追加</button>
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
	<div id="pinTooltip"><div class="tt-num"></div><div class="tt-pin"></div><div class="tt-mode"></div></div>

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
				<button id="addDlgApply" class="dlg-btn" style="background:#4f46e5;border-color:#6366f1;color:#fff">追加</button>
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
		const zoomLabel = document.getElementById('zoomLabel');
		let zoom = 1;
		const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
		function applyZoom(z) {
			zoom = Math.max(0.5, Math.min(3, z));
			chipSvgEl.style.transform = 'scale(' + zoom + ')';
			chipSvgEl.style.transformOrigin = 'top left';
			zoomLabel.textContent = Math.round(zoom * 100) + '%';
		}
		document.getElementById('zoomIn').addEventListener('click', () => {
			const idx = ZOOM_STEPS.findIndex(z => z > zoom);
			applyZoom(idx >= 0 ? ZOOM_STEPS[idx] : 3);
		});
		document.getElementById('zoomOut').addEventListener('click', () => {
			const idx = [...ZOOM_STEPS].reverse().findIndex(z => z < zoom);
			applyZoom(idx >= 0 ? [...ZOOM_STEPS].reverse()[idx] : 0.5);
		});
		document.getElementById('zoomReset').addEventListener('click', () => applyZoom(1));
		chipSvgEl.addEventListener('wheel', e => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				applyZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
			}
		}, { passive: false });
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
		// ---- end zoom/tooltip ----

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

		dlgCancel.addEventListener('click', closeDialog);
		dlgBackdrop.addEventListener('click', e => { if (e.target === dlgBackdrop) { closeDialog(); } });
		document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDialog(); } });

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
			if (msg && msg.type === 'openDialog') {
				openDialog(msg.pin, msg.currentMode, msg.groups);
			}
		});
		// ---- end dialog ----

		// ---- add pin dialog ----
		const addDlgBackdrop = document.getElementById('addDlgBackdrop');
		const addPinInput = document.getElementById('addPinInput');
		const addPinErr = document.getElementById('addPinErr');
		const addModeSelect = document.getElementById('addModeSelect');
		const addDlgApply = document.getElementById('addDlgApply');
		const addDlgCancel = document.getElementById('addDlgCancel');
		const PIN_RE = /^P[A-Ka-k][0-9]{1,2}$/;
		function openAddDialog() {
			addPinInput.value = '';
			addPinErr.textContent = '';
			addPinInput.classList.remove('invalid');
			addModeSelect.selectedIndex = 0;
			addDlgBackdrop.classList.add('open');
			setTimeout(() => addPinInput.focus(), 60);
		}
		function closeAddDialog() { addDlgBackdrop.classList.remove('open'); }
		document.getElementById('btnAddPin').addEventListener('click', openAddDialog);
		addDlgCancel.addEventListener('click', closeAddDialog);
		addDlgBackdrop.addEventListener('click', e => { if (e.target === addDlgBackdrop) { closeAddDialog(); } });
		document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAddDialog(); } });
		addPinInput.addEventListener('input', () => {
			const ok = PIN_RE.test(addPinInput.value.trim());
			addPinInput.classList.toggle('invalid', addPinInput.value.length > 0 && !ok);
			addPinErr.textContent = (addPinInput.value.length > 0 && !ok) ? '形式エラー: PA0–PK15 の形式で入力してください' : '';
		});
		addDlgApply.addEventListener('click', () => {
			const pin = addPinInput.value.trim().toUpperCase();
			if (!PIN_RE.test(pin)) { addPinErr.textContent = '有効なピン名を入力してください。'; addPinInput.classList.add('invalid'); return; }
			const mode = addModeSelect.value;
			vscode.postMessage({ type: 'addPin', pin, mode });
			closeAddDialog();
		});
		// ---- end add pin dialog ----

		const filterInput = document.getElementById('filterInput');
		const pinCountEl = document.getElementById('pinCount');
		const groupsView = document.getElementById('groupsView');
		const chipView = document.getElementById('chipView');
		const btnList = document.getElementById('btnList');
		const btnChip = document.getElementById('btnChip');

		btnList.addEventListener('click', () => {
			groupsView.style.display = ''; chipView.style.display = 'none';
			btnList.classList.add('active'); btnList.setAttribute('aria-pressed','true');
			btnChip.classList.remove('active'); btnChip.setAttribute('aria-pressed','false');
			filterInput.disabled = false;
		});
		btnChip.addEventListener('click', () => {
			groupsView.style.display = 'none'; chipView.style.display = '';
			btnChip.classList.add('active'); btnChip.setAttribute('aria-pressed','true');
			btnList.classList.remove('active'); btnList.setAttribute('aria-pressed','false');
			filterInput.disabled = true;
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
	if (value.includes('gpio_output')) { return '#4f51b5'; }
	if (value.includes('gpio_input')) { return '#1a4731'; }
	if (value.includes('usart') || value.includes('uart')) { return '#7c3a00'; }
	if (value.includes('i2c')) { return '#6d1a4c'; }
	if (value.includes('spi')) { return '#4a1d8a'; }
	if (value.includes('adc')) { return '#7c1d1d'; }
	if (value.includes('tim') || value.includes('pwm')) { return '#1a3050'; }
	return '#1e2030';
}

function colorForModeBorder(mode: string): string {
	const value = mode.toLowerCase();
	if (value.includes('gpio_output')) { return '#6366f1'; }
	if (value.includes('gpio_input')) { return '#22c55e'; }
	if (value.includes('usart') || value.includes('uart')) { return '#f59e0b'; }
	if (value.includes('i2c')) { return '#ec4899'; }
	if (value.includes('spi')) { return '#8b5cf6'; }
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
