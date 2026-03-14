/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;
declare const process: { platform: string };

const childProcess = require('child_process') as {
	execFile: (command: string, args: string[], options: { cwd?: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
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

const TEMPLATE_ITEMS = [
	'GPIO Blinky (F4)',
	'UART Hello (F4)',
	'I2C Sensor Read (F4)',
	'SPI IMU (F4)',
	'Timer PWM Basic',
	'ADC Polling',
	'ADC + DMA',
	'EXTI Button IRQ',
	'RTC Calendar',
	'DAC Wave Output',
	'CAN Loopback',
	'USB CDC Device',
	'USB HID Device',
	'FreeRTOS 2 Tasks',
	'FreeRTOS Queue',
	'FreeRTOS Mutex',
	'LwIP TCP Echo',
	'LwIP HTTP Basic',
	'FatFS SD Card',
	'QSPI External Flash',
	'Low Power STOP Mode',
	'Watchdog IWDG',
	'Bootloader UART',
	'Modbus RTU Slave',
	'Motor PWM + Encoder',
	'Hall Sensor Capture',
	'BLE UART Bridge (WB)',
	'Crypto AES (L5)',
	'CMSIS-DSP FIR',
	'Multi-board Workspace Sample'
];

const PIN_MODE_CHOICES = [
	'GPIO_Output',
	'GPIO_Input',
	'USART2_TX',
	'USART2_RX',
	'I2C1_SCL',
	'I2C1_SDA',
	'SPI1_SCK',
	'SPI1_MISO',
	'SPI1_MOSI',
	'ADC1_IN0',
	'TIM2_CH1'
];

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('STM32 UX');
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
	const tools = [
		{ id: 'STM32CubeMX', command: 'STM32CubeMX' },
		{ id: 'STM32CubeCLT_metadata', command: 'STM32CubeCLT_metadata' },
		{ id: 'STM32_Programmer_CLI', command: 'STM32_Programmer_CLI' },
		{ id: 'arm-none-eabi-gcc', command: 'arm-none-eabi-gcc' },
		{ id: 'git', command: 'git' }
	];

	const rows: string[] = [];
	for (const tool of tools) {
		const foundPath = await resolveCommandPath(tool.command, workspaceRoot);
		rows.push(`- ${tool.id}: ${foundPath ? `✅ ${foundPath}` : '❌ 未検出'}`);
	}

	const configuredCubeMx = vscode.workspace.getConfiguration('stm32').get<string>('cubemx.path', '').trim();
	const configuredMetadata = vscode.workspace.getConfiguration('stm32').get<string>('cubeclt.metadataPath', '').trim();

	const report = [
		'# STM32 環境チェック',
		'',
		'## ツール検出',
		...rows,
		'',
		'## 設定値',
		`- stm32.cubemx.path: ${configuredCubeMx.length > 0 ? configuredCubeMx : '(未設定)'}`,
		`- stm32.cubeclt.metadataPath: ${configuredMetadata.length > 0 ? configuredMetadata : '(未設定)'}`,
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

async function openPinVisualizer(): Promise<void> {
	const iocUri = await findIocFile();
	const panel = vscode.window.createWebviewPanel('stm32ux.pinVisualizer', 'STM32 ピンビジュアライザ', vscode.ViewColumn.Active, { enableScripts: true });
	const render = async (): Promise<void> => {
		let pins: Array<{ pin: string; mode: string }> = [];
		if (iocUri) {
			const bytes = await vscode.workspace.fs.readFile(iocUri);
			let text = '';
			for (const value of bytes) {
				text += String.fromCharCode(value);
			}
			pins = parsePinLines(text);
		}
		panel.webview.html = getPinVisualizerHtml(panel.webview, pins, iocUri?.fsPath);
	};

	panel.webview.onDidReceiveMessage(async message => {
		if (!iocUri || !isRecord(message) || message.type !== 'editPin' || typeof message.pin !== 'string') {
			return;
		}
		const selectedMode = await vscode.window.showQuickPick(PIN_MODE_CHOICES, {
			title: vscode.l10n.t('ピン {0} のモードを選択', message.pin),
			placeHolder: vscode.l10n.t('選択したモードを .ioc に反映します')
		});
		if (!selectedMode) {
			return;
		}

		const updated = await updateIocPinMode(iocUri, message.pin, selectedMode);
		if (updated) {
			vscode.window.showInformationMessage(vscode.l10n.t('{0} を {1} に更新しました。', message.pin, selectedMode));
			await render();
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

	await writeTextFile(vscode.Uri.joinPath(projectUri, `${projectName}.ioc`), iocText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Src', 'main.c'), mainText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'Core', 'Inc', 'main.h'), headerText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, 'README.md'), readmeText);
	await writeTextFile(vscode.Uri.joinPath(projectUri, '.vscode', 'extensions.json'), extJson);

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

function getTemplateDefinition(templateName: string): TemplateDefinition {
	if (templateName === 'GPIO Blinky (F4)') {
		return {
			name: templateName,
			category: '初級',
			mcu: 'STM32F446RETx',
			pinModes: [{ pin: 'PA5', mode: 'GPIO_Output' }],
			userCodeLines: ['HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);', 'HAL_Delay(500);']
		};
	}
	if (templateName === 'UART Hello (F4)') {
		return {
			name: templateName,
			category: '初級',
			mcu: 'STM32F446RETx',
			pinModes: [{ pin: 'PA2', mode: 'USART2_TX' }, { pin: 'PA3', mode: 'USART2_RX' }],
			userCodeLines: ['const char *msg = "Hello STM32\\r\\n";', 'HAL_Delay(1000);', '(void)msg;']
		};
	}
	return {
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
		childProcess.execFile(command, args, { cwd }, (error, stdout, stderr) => {
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
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		body { font-family: var(--vscode-font-family); margin: 0; padding: 10px; }
		button { width: 100%; margin-bottom: 6px; padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); }
	</style>
</head>
<body>
	<button id="welcome" aria-label="ウェルカムを開く">ウェルカムウィザード</button>
	<button id="tutorial" aria-label="チュートリアルを開く">Lチカチュートリアル</button>
	<button id="templates" aria-label="テンプレートギャラリーを開く">テンプレートギャラリー</button>
	<button id="env" aria-label="環境チェックを実行">環境チェック</button>
	<button id="pin" aria-label="ピンビジュアライザを開く">ピンビジュアライザ</button>
	<button id="error" aria-label="エラー解説を開く">エラー自動解説</button>
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
		body { font-family: var(--vscode-font-family); padding: 20px; max-width: 960px; margin: 0 auto; }
		h1 { font-size: 24px; margin-bottom: 8px; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
		.card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 12px; }
		button { margin-top: 10px; width: 100%; padding: 8px; border-radius: 6px; border: 1px solid transparent; }
	</style>
</head>
<body>
	<h1>CubeForge STM32 ウェルカム</h1>
	<p role="status" aria-live="polite">初めての方も、CubeIDE移行ユーザーも、ここから開始できます。</p>
	<div class="grid">
		<div class="card">
			<h2>🌱 はじめて使う</h2>
			<p>7ステップのLチカチュートリアルを開始します。</p>
			<button id="tutorial" aria-label="チュートリアルを開始">チュートリアルを開始</button>
		</div>
		<div class="card">
			<h2>🔄 CubeIDEから移行</h2>
			<p>既存プロジェクトのインポートを開始します。</p>
			<button id="import" aria-label="CubeIDEプロジェクトをインポート">CubeIDEプロジェクトをインポート</button>
		</div>
		<div class="card">
			<h2>⚡ すぐ始める</h2>
			<p>テンプレート作成と環境チェックを実行します。</p>
			<button id="templates" aria-label="テンプレートギャラリーを開く">テンプレートギャラリーを開く</button>
			<button id="env" aria-label="環境チェックを実行">環境チェックを実行</button>
		</div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		for (const id of ['tutorial','import','templates','env']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
	</script>
</body>
</html>`;
}

function getTutorialHtml(webview: vscode.Webview): string {
	const csp = webview.cspSource;
	const steps = JSON.stringify(TUTORIAL_STEPS);
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		body { font-family: var(--vscode-font-family); padding: 20px; max-width: 840px; margin: 0 auto; }
		.panel { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 14px; }
		.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
		button { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); }
	</style>
</head>
<body>
	<h1>Lチカ インタラクティブチュートリアル</h1>
	<div class="panel" role="region" aria-label="チュートリアルステップ">
		<p id="progress"></p>
		<p id="step" role="status" aria-live="polite"></p>
	</div>
	<div class="actions">
		<button id="prev" aria-label="前のステップ">前へ</button>
		<button id="next" aria-label="次のステップ">次へ</button>
		<button id="openPin" aria-label="ピンビジュアライザを開く">ピンを確認</button>
		<button id="runBuild" aria-label="ビルドを実行">ビルド実行</button>
		<button id="runFlash" aria-label="書込みを実行">書込み実行</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const steps = ${steps};
		let index = 0;
		const render = () => {
			document.getElementById('progress').textContent = 'Step ' + (index + 1) + ' / ' + steps.length;
			document.getElementById('step').textContent = steps[index];
		};
		document.getElementById('prev').addEventListener('click', () => { index = Math.max(0, index - 1); render(); });
		document.getElementById('next').addEventListener('click', () => { index = Math.min(steps.length - 1, index + 1); render(); });
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
	const cards = TEMPLATE_ITEMS.map(name => `<button class="card" data-template="${escapeHtml(name)}" aria-label="テンプレート ${escapeHtml(name)} を選択">${escapeHtml(name)}</button>`).join('');
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		body { font-family: var(--vscode-font-family); padding: 16px; }
		.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
		.card { text-align: left; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; background: var(--vscode-editor-background); }
	</style>
</head>
<body>
	<h1>テンプレートギャラリー (30種)</h1>
	<div class="grid" role="list">${cards}</div>
	<script>
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('.card').forEach(node => {
			node.addEventListener('click', () => vscode.postMessage({ template: node.dataset.template }));
		});
	</script>
</body>
</html>`;
}

function getPinVisualizerHtml(webview: vscode.Webview, pins: Array<{ pin: string; mode: string }>, iocPath: string | undefined): string {
	const csp = webview.cspSource;
	const nodes = pins.length > 0
		? pins.map((item, index) => {
			const x = 20 + (index % 8) * 110;
			const y = 20 + Math.floor(index / 8) * 60;
			const color = colorForMode(item.mode);
			return `<g class="pinNode" data-pin="${escapeHtml(item.pin)}" role="button" tabindex="0" aria-label="${escapeHtml(item.pin)} ${escapeHtml(item.mode)}"><rect x="${x}" y="${y}" width="100" height="46" rx="6" fill="${color}" /><text x="${x + 8}" y="${y + 18}" fill="#E8EAED" font-size="12">${escapeHtml(item.pin)}</text><text x="${x + 8}" y="${y + 34}" fill="#E8EAED" font-size="10">${escapeHtml(item.mode.slice(0, 18))}</text></g>`;
		}).join('')
		: '<text x="20" y="40" fill="#9196A8">.ioc が見つからないか、ピン情報を解析できませんでした。</text>';
	return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style>
		body { font-family: var(--vscode-font-family); padding: 12px; margin: 0; }
		svg { width: 100%; height: 540px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: #13151E; }
		.pinNode { cursor: pointer; }
		.pinNode:focus rect { stroke: #FFFFFF; stroke-width: 2; }
	</style>
</head>
<body>
	<h1>STM32 ピンビジュアライザ</h1>
	<p role="status" aria-live="polite">${iocPath ? `対象: ${escapeHtml(iocPath)}` : 'CubeMX設定の主要ピンを簡易SVGで表示しています。'}</p>
	<p>ピンをクリックしてモードを変更すると、.iocへ反映されます。</p>
	<svg viewBox="0 0 920 540" aria-label="ピン配置図" role="img">${nodes}</svg>
	<script>
		const vscode = acquireVsCodeApi();
		for (const node of document.querySelectorAll('.pinNode')) {
			node.addEventListener('click', () => vscode.postMessage({ type: 'editPin', pin: node.dataset.pin }));
			node.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					vscode.postMessage({ type: 'editPin', pin: node.dataset.pin });
				}
			});
		}
	</script>
</body>
</html>`;
}

function colorForMode(mode: string): string {
	const value = mode.toLowerCase();
	if (value.includes('gpio_output')) {
		return '#6366F1';
	}
	if (value.includes('gpio_input')) {
		return '#22C55E';
	}
	if (value.includes('uart')) {
		return '#F59E0B';
	}
	if (value.includes('i2c')) {
		return '#EC4899';
	}
	if (value.includes('spi')) {
		return '#8B5CF6';
	}
	if (value.includes('adc')) {
		return '#EF4444';
	}
	return '#2A2D3E';
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
