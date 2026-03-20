/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { diagnoseProject, autoFixIssues } from './diagnostics';

export async function autoCheckProjectHealth(
	workspaceRoot: string | undefined,
	outputChannel: vscode.OutputChannel
): Promise<void> {
	if (!workspaceRoot) {
		return;
	}

	outputChannel.appendLine('[TovaIDE] 🔍 Auto-checking project health...');
	const result = await diagnoseProject(workspaceRoot, outputChannel);

	if (!result.healthy) {
		const criticalIssues = result.issues.filter(i => i.severity === 'critical');
		if (criticalIssues.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				`TovaIDE detected ${criticalIssues.length} critical project issue(s). Auto-fix?`,
				'Fix Now',
				'Show Details',
				'Ignore'
			);

			if (choice === 'Fix Now') {
				const fixed = await autoFixIssues(result.issues, outputChannel);
				if (fixed > 0) {
					vscode.window.showInformationMessage(`TovaIDE fixed ${fixed} issue(s). Rebuild recommended.`);
				}
			} else if (choice === 'Show Details') {
				await vscode.commands.executeCommand('stm32.healthCheck');
			}
		}
	}
}

export async function diagnoseAndFixProject(
	workspaceRoot: string | undefined,
	outputChannel: vscode.OutputChannel
): Promise<void> {
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('Open a workspace first.');
		return;
	}

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'TovaIDE: Diagnosing project...', cancellable: false },
		async () => {
			return await diagnoseProject(workspaceRoot, outputChannel);
		}
	);

	if (result.healthy) {
		vscode.window.showInformationMessage('✅ Project is healthy!');
		return;
	}

	const fixableCount = result.issues.filter(i => i.autoFixable).length;
	const message = `Found ${result.issues.length} issue(s), ${fixableCount} auto-fixable.`;

	const choice = await vscode.window.showWarningMessage(
		message,
		'Auto-Fix',
		'Show Details',
		'Cancel'
	);

	if (choice === 'Auto-Fix') {
		const fixed = await autoFixIssues(result.issues, outputChannel);
		if (fixed > 0) {
			vscode.window.showInformationMessage(`TovaIDE fixed ${fixed} issue(s).`);
		} else {
			vscode.window.showWarningMessage('No issues could be auto-fixed. Manual intervention required.');
		}
	} else if (choice === 'Show Details') {
		showDiagnosticReport(result, outputChannel);
	}
}

export async function healthCheckCommand(
	workspaceRoot: string | undefined,
	outputChannel: vscode.OutputChannel
): Promise<void> {
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('Open a workspace first.');
		return;
	}

	outputChannel.show();
	outputChannel.appendLine('[TovaIDE] =====================================');
	outputChannel.appendLine('[TovaIDE] 🏥 Project Health Check');
	outputChannel.appendLine('[TovaIDE] =====================================');

	const result = await diagnoseProject(workspaceRoot, outputChannel);

	outputChannel.appendLine('[TovaIDE] =====================================');
	outputChannel.appendLine(`[TovaIDE] ${result.summary}`);
	outputChannel.appendLine('[TovaIDE] =====================================');

	if (!result.healthy) {
		const choice = await vscode.window.showWarningMessage(
			result.summary,
			'Auto-Fix Issues',
			'OK'
		);

		if (choice === 'Auto-Fix Issues') {
			await diagnoseAndFixProject(workspaceRoot, outputChannel);
		}
	} else {
		vscode.window.showInformationMessage(result.summary);
	}
}

function showDiagnosticReport(result: any, outputChannel: vscode.OutputChannel): void {
	outputChannel.show();
	outputChannel.appendLine('[TovaIDE] =====================================');
	outputChannel.appendLine('[TovaIDE] 📊 Diagnostic Report');
	outputChannel.appendLine('[TovaIDE] =====================================');

	const criticalIssues = result.issues.filter((i: any) => i.severity === 'critical');
	const warningIssues = result.issues.filter((i: any) => i.severity === 'warning');
	const infoIssues = result.issues.filter((i: any) => i.severity === 'info');

	if (criticalIssues.length > 0) {
		outputChannel.appendLine('[TovaIDE] 🔴 Critical Issues:');
		for (const issue of criticalIssues) {
			outputChannel.appendLine(`[TovaIDE]   - [${issue.category}] ${issue.description}`);
			if (issue.autoFixable) {
				outputChannel.appendLine(`[TovaIDE]     ✅ Auto-fixable`);
			} else {
				outputChannel.appendLine(`[TovaIDE]     ⚠️ Manual fix required`);
			}
		}
		outputChannel.appendLine('[TovaIDE]');
	}

	if (warningIssues.length > 0) {
		outputChannel.appendLine('[TovaIDE] ⚠️ Warnings:');
		for (const issue of warningIssues) {
			outputChannel.appendLine(`[TovaIDE]   - [${issue.category}] ${issue.description}`);
		}
		outputChannel.appendLine('[TovaIDE]');
	}

	if (infoIssues.length > 0) {
		outputChannel.appendLine('[TovaIDE] ℹ️ Info:');
		for (const issue of infoIssues) {
			outputChannel.appendLine(`[TovaIDE]   - [${issue.category}] ${issue.description}`);
		}
		outputChannel.appendLine('[TovaIDE]');
	}

	outputChannel.appendLine('[TovaIDE] =====================================');
	outputChannel.appendLine(`[TovaIDE] Total: ${result.issues.length} issue(s)`);
	outputChannel.appendLine('[TovaIDE] =====================================');
}
