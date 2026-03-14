/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DebugFrameInfo, DebugSnapshot, DebugVariableInfo } from './types';

interface StackFrameDto {
	id: number;
	name: string;
	line: number;
	source?: {
		path?: string;
		name?: string;
	};
}

interface StackTraceResponse {
	stackFrames?: StackFrameDto[];
}

interface ScopeDto {
	name: string;
	variablesReference: number;
}

interface ScopesResponse {
	scopes?: ScopeDto[];
}

interface VariableDto {
	name: string;
	value: string;
	type?: string;
}

interface VariablesResponse {
	variables?: VariableDto[];
}

export async function captureReadOnlyDebugSnapshot(outputChannel: vscode.OutputChannel): Promise<DebugSnapshot | undefined> {
	const session = vscode.debug.activeDebugSession;
	if (!session) {
		return undefined;
	}

	try {
		const stack = await session.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 8 }) as StackTraceResponse;
		const frames = (stack.stackFrames ?? []).map(toFrameInfo);

		const variables: DebugVariableInfo[] = [];
		if (stack.stackFrames && stack.stackFrames.length > 0) {
			const top = stack.stackFrames[0];
			const scopes = await session.customRequest('scopes', { frameId: top.id }) as ScopesResponse;
			const localScope = (scopes.scopes ?? []).find(scope => scope.name.toLowerCase().includes('local'));
			if (localScope) {
				const response = await session.customRequest('variables', { variablesReference: localScope.variablesReference }) as VariablesResponse;
				for (const variable of response.variables ?? []) {
					variables.push({ name: variable.name, value: variable.value, type: variable.type });
				}
			}
		}

		const snapshot: DebugSnapshot = {
			sessionName: session.name,
			capturedAt: new Date().toISOString(),
			frames,
			variables
		};
		outputChannel.appendLine(`[STM32-COLLAB] Debug snapshot captured: ${snapshot.sessionName}`);
		return snapshot;
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown error';
		outputChannel.appendLine(`[STM32-COLLAB] Debug snapshot failed: ${message}`);
		return undefined;
	}
}

function toFrameInfo(frame: StackFrameDto): DebugFrameInfo {
	return {
		name: frame.name,
		source: frame.source?.path ?? frame.source?.name,
		line: frame.line
	};
}
