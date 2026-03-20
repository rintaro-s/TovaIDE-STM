/*---------------------------------------------------------------------------------------------
 *  TovaIDE Auto-Diagnostics and Self-Healing System
 *  Automatically detects and fixes common STM32 project issues
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => any;
const fsModule = require('fs') as {
	promises: {
		access: (path: string) => Promise<void>;
		readFile: (path: string, encoding: string) => Promise<string>;
		readdir: (path: string, options?: { withFileTypes: boolean }) => Promise<Array<{ isFile: () => boolean; isDirectory: () => boolean; name: string }>>;
	};
};
const pathModule = require('path') as {
	join: (...parts: string[]) => string;
	extname: (path: string) => string;
};

const fs = fsModule.promises;
const join = pathModule.join;
const extname = pathModule.extname;

interface ProjectIssue {
	severity: 'critical' | 'warning' | 'info';
	category: 'build' | 'hal' | 'cubemx' | 'environment';
	description: string;
	autoFixable: boolean;
	fix?: () => Promise<boolean>;
}

interface DiagnosticResult {
	healthy: boolean;
	issues: ProjectIssue[];
	summary: string;
}

export async function diagnoseProject(
	workspaceRoot: string,
	outputChannel: vscode.OutputChannel
): Promise<DiagnosticResult> {
	const issues: ProjectIssue[] = [];

	outputChannel.appendLine('[TovaIDE] 🔍 Starting comprehensive project diagnosis...');

	// Check 1: Makefile existence
	const makefileIssue = await checkMakefile(workspaceRoot);
	if (makefileIssue) {
		issues.push(makefileIssue);
	}

	// Check 2: HAL library presence
	const halIssue = await checkHALLibrary(workspaceRoot);
	if (halIssue) {
		issues.push(halIssue);
	}

	// Check 3: .ioc file validity
	const iocIssue = await checkIocFile(workspaceRoot);
	if (iocIssue) {
		issues.push(iocIssue);
	}

	// Check 4: Project structure
	const structureIssue = await checkProjectStructure(workspaceRoot);
	if (structureIssue) {
		issues.push(structureIssue);
	}

	const criticalCount = issues.filter(i => i.severity === 'critical').length;
	const warningCount = issues.filter(i => i.severity === 'warning').length;
	const healthy = criticalCount === 0;

	let summary = '';
	if (healthy) {
		summary = `✅ Project is healthy (${warningCount} warnings)`;
	} else {
		summary = `❌ ${criticalCount} critical issue(s) found, ${warningCount} warning(s)`;
	}

	outputChannel.appendLine(`[TovaIDE] ${summary}`);
	for (const issue of issues) {
		const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
		outputChannel.appendLine(`[TovaIDE] ${icon} [${issue.category}] ${issue.description}`);
	}

	return { healthy, issues, summary };
}

async function checkMakefile(workspaceRoot: string): Promise<ProjectIssue | null> {
	const makefilePath = join(workspaceRoot, 'Makefile');
	try {
		await fs.access(makefilePath);
		return null; // Makefile exists
	} catch {
		return {
			severity: 'critical',
			category: 'build',
			description: 'Makefile not found. Project cannot be built.',
			autoFixable: true,
			fix: async () => {
				const choice = await vscode.window.showWarningMessage(
					'Makefile not found. Regenerate project with STM32CubeMX?',
					'Regenerate Now',
					'Show Instructions',
					'Cancel'
				);
				if (choice === 'Regenerate Now') {
					await vscode.commands.executeCommand('stm32.regenerateWithCubeMX');
					return true;
				} else if (choice === 'Show Instructions') {
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(workspaceRoot, 'REGENERATE_PROJECT.md')));
					await vscode.window.showTextDocument(doc);
					return false;
				}
				return false;
			}
		};
	}
}

async function checkHALLibrary(workspaceRoot: string): Promise<ProjectIssue | null> {
	const driversPath = join(workspaceRoot, 'Drivers');
	try {
		const entries = await fs.readdir(driversPath, { withFileTypes: true });
		const hasHAL = entries.some(e => e.isDirectory() && e.name.includes('HAL_Driver'));
		const hasCMSIS = entries.some(e => e.isDirectory() && e.name === 'CMSIS');

		if (!hasHAL || !hasCMSIS) {
			return {
				severity: 'critical',
				category: 'hal',
				description: 'HAL/CMSIS libraries incomplete. Build will fail with undefined symbols.',
				autoFixable: true,
				fix: async () => {
					const choice = await vscode.window.showErrorMessage(
						'HAL libraries missing. Regenerate project with STM32CubeMX?',
						'Regenerate Now',
						'Cancel'
					);
					if (choice === 'Regenerate Now') {
						await vscode.commands.executeCommand('stm32.regenerateWithCubeMX');
						return true;
					}
					return false;
				}
			};
		}
		return null;
	} catch {
		return {
			severity: 'critical',
			category: 'hal',
			description: 'Drivers folder not found. HAL libraries missing.',
			autoFixable: true,
			fix: async () => {
				const choice = await vscode.window.showErrorMessage(
					'Drivers folder missing. Regenerate project with STM32CubeMX?',
					'Regenerate Now',
					'Cancel'
				);
				if (choice === 'Regenerate Now') {
					await vscode.commands.executeCommand('stm32.regenerateWithCubeMX');
					return true;
				}
				return false;
			}
		};
	}
}

async function checkIocFile(workspaceRoot: string): Promise<ProjectIssue | null> {
	try {
		const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
		const iocFiles = entries.filter(e => e.isFile() && extname(e.name) === '.ioc');

		if (iocFiles.length === 0) {
			return {
				severity: 'warning',
				category: 'cubemx',
				description: '.ioc file not found. Cannot regenerate code.',
				autoFixable: false
			};
		}

		if (iocFiles.length > 1) {
			return {
				severity: 'warning',
				category: 'cubemx',
				description: `Multiple .ioc files found (${iocFiles.length}). May cause confusion.`,
				autoFixable: false
			};
		}

		// Validate .ioc content
		const iocPath = join(workspaceRoot, iocFiles[0].name);
		const content = await fs.readFile(iocPath, 'utf8');
		
		if (!content.includes('Mcu.') && !content.includes('ProjectManager.')) {
			return {
				severity: 'critical',
				category: 'cubemx',
				description: '.ioc file appears corrupted or invalid.',
				autoFixable: false
			};
		}

		// Check if Toolchain is set to Makefile
		if (!content.includes('ProjectManager.ToolChain=Makefile')) {
			return {
				severity: 'critical',
				category: 'cubemx',
				description: '.ioc file Toolchain is not set to "Makefile". Build will fail.',
				autoFixable: true,
				fix: async () => {
					await vscode.window.showWarningMessage(
						'Open .ioc file in STM32CubeMX and set Toolchain/IDE to "Makefile" in Project Manager.',
						'Open Instructions'
					).then(choice => {
						if (choice === 'Open Instructions') {
							vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(workspaceRoot, 'REGENERATE_PROJECT.md')));
						}
					});
					return false;
				}
			};
		}

		return null;
	} catch {
		return {
			severity: 'warning',
			category: 'cubemx',
			description: 'Cannot check .ioc file.',
			autoFixable: false
		};
	}
}

async function checkProjectStructure(workspaceRoot: string): Promise<ProjectIssue | null> {
	try {
		const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
		const hasCore = entries.some(e => e.isDirectory() && e.name === 'Core');
		const hasDrivers = entries.some(e => e.isDirectory() && e.name === 'Drivers');

		if (!hasCore || !hasDrivers) {
			return {
				severity: 'critical',
				category: 'build',
				description: 'Core or Drivers directory missing. Project structure incomplete.',
				autoFixable: true,
				fix: async () => {
					const choice = await vscode.window.showErrorMessage(
						'Project structure incomplete. Regenerate with STM32CubeMX?',
						'Regenerate Now',
						'Cancel'
					);
					if (choice === 'Regenerate Now') {
						await vscode.commands.executeCommand('stm32.regenerateWithCubeMX');
						return true;
					}
					return false;
				}
			};
		}

		// Check for main.c
		const mainPaths = [
			join(workspaceRoot, 'Core', 'Src', 'main.c'),
			join(workspaceRoot, 'Src', 'main.c'),
		];

		let mainExists = false;
		for (const mainPath of mainPaths) {
			try {
				await fs.access(mainPath);
				mainExists = true;
				break;
			} catch {
				// continue
			}
		}

		if (!mainExists) {
			return {
				severity: 'critical',
				category: 'build',
				description: 'main.c not found. Cannot build project.',
				autoFixable: true,
				fix: async () => {
					const choice = await vscode.window.showErrorMessage(
						'main.c not found. Regenerate with STM32CubeMX?',
						'Regenerate Now',
						'Cancel'
					);
					if (choice === 'Regenerate Now') {
						await vscode.commands.executeCommand('stm32.regenerateWithCubeMX');
						return true;
					}
					return false;
				}
			};
		}

		return null;
	} catch {
		return {
			severity: 'warning',
			category: 'build',
			description: 'Cannot check project structure.',
			autoFixable: false
		};
	}
}

export async function autoFixIssues(
	issues: ProjectIssue[],
	outputChannel: vscode.OutputChannel
): Promise<number> {
	const fixableIssues = issues.filter(i => i.autoFixable && i.fix);
	if (fixableIssues.length === 0) {
		return 0;
	}

	outputChannel.appendLine(`[TovaIDE] 🔧 Auto-fixing ${fixableIssues.length} issue(s)...`);

	let fixedCount = 0;
	for (const issue of fixableIssues) {
		if (issue.fix) {
			const fixed = await issue.fix();
			if (fixed) {
				fixedCount++;
				outputChannel.appendLine(`[TovaIDE] ✅ Fixed: ${issue.description}`);
			}
		}
	}

	return fixedCount;
}
