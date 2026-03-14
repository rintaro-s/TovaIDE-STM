/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;

const dgramModule = require('dgram') as {
	createSocket: (type: 'udp4') => {
		on: {
			(event: 'message', listener: (message: Buffer) => void): void;
			(event: 'error', listener: (error: Error) => void): void;
		};
		bind: (port: number, callback?: () => void) => void;
		close: () => void;
		addMembership: (multicastAddress: string) => void;
		setMulticastTTL: (ttl: number) => void;
		send: (buffer: Buffer, port: number, address: string) => void;
	};
};

interface SyncPayload {
	sessionCode: string;
	peerId: string;
	uri: string;
	text: string;
	version: number;
}

const SYNC_GROUP = '239.255.23.32';
const PACKET_PREFIX = 'cubeforge-stm32-sync';

export class YjsSyncProvider implements vscode.Disposable {
	private socket: ReturnType<typeof dgramModule.createSocket> | undefined;
	private readonly peerId = createPeerId();
	private suppressEdits = false;
	private readonly sentVersionByUri = new Map<string, number>();
	private readonly disposables: vscode.Disposable[] = [];
	private activeSessionCode: string | undefined;
	private port: number | undefined;

	public constructor(private readonly outputChannel: vscode.OutputChannel) {
	}

	public start(sessionCode: string, port: number): void {
		if (this.socket && this.activeSessionCode === sessionCode && this.port === port) {
			return;
		}
		this.stop();

		this.activeSessionCode = sessionCode;
		this.port = port;

		const socket = dgramModule.createSocket('udp4');
		socket.on('message', payload => this.applyIncomingPayload(payload));
		socket.on('error', err => this.outputChannel.appendLine(`[STM32-COLLAB] Sync socket error: ${err.message}`));
		socket.bind(port, () => {
			socket.setMulticastTTL(1);
			socket.addMembership(SYNC_GROUP);
			this.outputChannel.appendLine(`[STM32-COLLAB] Realtime sync started: ${sessionCode} (${SYNC_GROUP}:${port})`);
		});
		this.socket = socket;

		this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
			if (this.suppressEdits || !this.activeSessionCode || !this.port) {
				return;
			}
			if (event.document.uri.scheme !== 'file') {
				return;
			}
			this.broadcastDocument(event.document);
		}));
	}

	public stop(): void {
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		if (this.socket) {
			this.socket.close();
			this.socket = undefined;
		}
		this.activeSessionCode = undefined;
		this.port = undefined;
	}

	public dispose(): void {
		this.stop();
	}

	private broadcastDocument(document: vscode.TextDocument): void {
		if (!this.socket || !this.activeSessionCode || !this.port) {
			return;
		}
		const uri = document.uri.toString();
		const version = (this.sentVersionByUri.get(uri) ?? 0) + 1;
		this.sentVersionByUri.set(uri, version);

		const payload: SyncPayload = {
			sessionCode: this.activeSessionCode,
			peerId: this.peerId,
			uri,
			text: document.getText(),
			version
		};
		const raw = `${PACKET_PREFIX}:${JSON.stringify(payload)}`;
		this.socket.send(Buffer.from(raw, 'utf8'), this.port, SYNC_GROUP);
	}

	private applyIncomingPayload(data: Buffer): void {
		if (!this.activeSessionCode) {
			return;
		}
		const raw = data.toString('utf8');
		if (!raw.startsWith(`${PACKET_PREFIX}:`)) {
			return;
		}
		try {
			const payload = JSON.parse(raw.slice(PACKET_PREFIX.length + 1)) as SyncPayload;
			if (payload.sessionCode !== this.activeSessionCode || payload.peerId === this.peerId) {
				return;
			}
			void this.applyDocumentText(payload.uri, payload.text, payload.version);
		} catch {
			// ignore malformed packets
		}
	}

	private async applyDocumentText(uriString: string, text: string, version: number): Promise<void> {
		const currentVersion = this.sentVersionByUri.get(uriString) ?? 0;
		if (version <= currentVersion) {
			return;
		}

		const uri = vscode.Uri.parse(uriString);
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(uri);
		} catch {
			return;
		}

		if (document.getText() === text) {
			this.sentVersionByUri.set(uriString, version);
			return;
		}

		this.suppressEdits = true;
		try {
			const edit = new vscode.WorkspaceEdit();
			const end = document.lineAt(Math.max(0, document.lineCount - 1)).range.end;
			edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), text);
			await vscode.workspace.applyEdit(edit);
			this.sentVersionByUri.set(uriString, version);
		} finally {
			this.suppressEdits = false;
		}
	}
}

function createPeerId(): string {
	const random = Math.floor(100000 + Math.random() * 900000);
	return `peer-${random}`;
}
