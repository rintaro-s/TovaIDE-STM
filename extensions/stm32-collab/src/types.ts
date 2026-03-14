/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface CollaborationSessionInfo {
	sessionCode: string;
	hostName: string;
	hostAddress: string;
	workspaceName: string;
	sharePort: number;
	timestamp: string;
}

export interface DebugFrameInfo {
	name: string;
	source?: string;
	line?: number;
}

export interface DebugVariableInfo {
	name: string;
	value: string;
	type?: string;
}

export interface DebugSnapshot {
	sessionName: string;
	capturedAt: string;
	frames: DebugFrameInfo[];
	variables: DebugVariableInfo[];
}
