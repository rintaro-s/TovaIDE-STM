/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';

declare const require: (moduleName: string) => unknown;

interface HttpModule {
	createServer: (handler: (req: HttpRequest, res: HttpResponse) => void) => HttpServer;
}

interface HttpServer {
	listen: (port: number, host: string, callback: () => void) => void;
	on: (event: 'upgrade', listener: (req: HttpRequest, socket: RawSocket, head: Buffer) => void) => void;
	close: (callback?: () => void) => void;
}

interface HttpRequest {
	headers: Record<string, string | undefined>;
	url?: string;
}

interface HttpResponse {
	writeHead: (code: number) => void;
	end: () => void;
}

interface RawSocket {
	write: (data: Buffer | string) => void;
	on: {
		(event: 'data', listener: (chunk: Buffer) => void): void;
		(event: 'close', listener: () => void): void;
		(event: 'error', listener: (err: Error) => void): void;
	};
	destroy: () => void;
}

const httpModule = require('http') as HttpModule;

interface WsSyncPayload {
	sessionCode: string;
	peerId: string;
	uri: string;
	text: string;
	version: number;
}

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsHandshakeAccept(key: string): string {
	return crypto.createHash('sha1').update(key + WS_MAGIC, 'binary').digest('base64');
}

function wsBuildTextFrame(text: string): Buffer {
	const payload = Buffer.from(text, 'utf8');
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[0] = 0x81; // FIN + opcode text
		header[1] = len;
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

function wsParseFrame(data: Buffer): { opcode: number; payload: Buffer } | undefined {
	if (data.length < 2) { return undefined; }
	const opcode = data[0] & 0x0f;
	const masked = (data[1] & 0x80) !== 0;
	let lenByte = data[1] & 0x7f;
	let offset = 2;

	if (lenByte === 126) {
		if (data.length < 4) { return undefined; }
		lenByte = data.readUInt16BE(2);
		offset = 4;
	} else if (lenByte === 127) {
		if (data.length < 10) { return undefined; }
		lenByte = Number(data.readBigUInt64BE(2));
		offset = 10;
	}

	let payload: Buffer;
	if (masked) {
		if (data.length < offset + 4 + lenByte) { return undefined; }
		const mask = data.slice(offset, offset + 4);
		offset += 4;
		payload = Buffer.alloc(lenByte);
		for (let i = 0; i < lenByte; i++) {
			payload[i] = data[offset + i] ^ mask[i % 4];
		}
	} else {
		payload = data.slice(offset, offset + lenByte);
	}
	return { opcode, payload };
}

export class WsSyncServer implements vscode.Disposable {
	private server: HttpServer | undefined;
	private readonly clients = new Set<RawSocket>();
	private readonly peerId: string;
	private readonly sentVersionByUri = new Map<string, number>();
	private suppressEdits = false;
	private activeSessionCode: string | undefined;
	private readonly textDocDisposables: vscode.Disposable[] = [];
	private onClientChange: (() => void) | undefined;

	public constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.peerId = `ws-peer-${Math.floor(100000 + Math.random() * 900000)}`;
	}

	public start(sessionCode: string, port: number, onClientChange?: () => void): void {
		if (this.server) {
			this.stop();
		}
		this.activeSessionCode = sessionCode;
		this.onClientChange = onClientChange;

		const srv = httpModule.createServer((_req, res) => {
			res.writeHead(426);
			res.end();
		});

		srv.on('upgrade', (req, socket, _head) => {
			const key = req.headers['sec-websocket-key'];
			if (!key) {
				socket.destroy();
				return;
			}
			const accept = wsHandshakeAccept(key);
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
			);
			this.clients.add(socket);
			this.outputChannel.appendLine(`[STM32-COLLAB] WS client connected (total: ${this.clients.size})`);
			this.onClientChange?.();

			socket.on('data', (chunk) => this.handleClientData(socket, chunk));
			socket.on('close', () => {
				this.clients.delete(socket);
				this.outputChannel.appendLine(`[STM32-COLLAB] WS client disconnected (total: ${this.clients.size})`);
				this.onClientChange?.();
			});
			socket.on('error', (err) => {
				this.outputChannel.appendLine(`[STM32-COLLAB] WS socket error: ${err.message}`);
				this.clients.delete(socket);
			});

			this.sendCurrentWorkspaceSnapshot(socket);
		});

		srv.listen(port, '0.0.0.0', () => {
			this.outputChannel.appendLine(`[STM32-COLLAB] WS sync server started on ws://0.0.0.0:${port} (session: ${sessionCode})`);
		});

		this.server = srv;

		this.textDocDisposables.push(
			vscode.workspace.onDidChangeTextDocument(event => {
				if (this.suppressEdits || !this.activeSessionCode) { return; }
				if (event.document.uri.scheme !== 'file') { return; }
				this.broadcastDocument(event.document);
			})
		);
	}

	public stop(): void {
		for (const d of this.textDocDisposables.splice(0)) {
			d.dispose();
		}
		for (const socket of this.clients) {
			socket.destroy();
		}
		this.clients.clear();
		if (this.server) {
			this.server.close(() => {
				this.outputChannel.appendLine('[STM32-COLLAB] WS sync server stopped.');
			});
			this.server = undefined;
		}
		this.activeSessionCode = undefined;
		this.onClientChange = undefined;
		this.sentVersionByUri.clear();
	}

	public dispose(): void {
		this.stop();
	}

	public get isRunning(): boolean {
		return this.server !== undefined;
	}

	public get connectedClients(): number {
		return this.clients.size;
	}

	private broadcastDocument(document: vscode.TextDocument): void {
		if (!this.activeSessionCode || this.clients.size === 0) { return; }
		const uri = document.uri.toString();
		const version = (this.sentVersionByUri.get(uri) ?? 0) + 1;
		this.sentVersionByUri.set(uri, version);

		const payload: WsSyncPayload = {
			sessionCode: this.activeSessionCode,
			peerId: this.peerId,
			uri,
			text: document.getText(),
			version
		};
		const frame = wsBuildTextFrame(JSON.stringify(payload));
		for (const client of this.clients) {
			try {
				client.write(frame);
			} catch {
				this.clients.delete(client);
			}
		}
	}

	private async sendCurrentWorkspaceSnapshot(socket: RawSocket): Promise<void> {
		if (!this.activeSessionCode) { return; }
		const docs = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && !d.isUntitled);
		for (const doc of docs.slice(0, 20)) {
			const uri = doc.uri.toString();
			const version = this.sentVersionByUri.get(uri) ?? 0;
			const payload: WsSyncPayload = {
				sessionCode: this.activeSessionCode,
				peerId: this.peerId,
				uri,
				text: doc.getText(),
				version
			};
			const frame = wsBuildTextFrame(JSON.stringify(payload));
			try {
				socket.write(frame);
			} catch {
				break;
			}
		}
	}

	private handleClientData(socket: RawSocket, data: Buffer): void {
		const frame = wsParseFrame(data);
		if (!frame) { return; }

		if (frame.opcode === 0x8) {
			socket.destroy();
			this.clients.delete(socket);
			return;
		}
		if (frame.opcode === 0x9) {
			const pong = Buffer.alloc(2);
			pong[0] = 0x8a;
			pong[1] = 0;
			socket.write(pong);
			return;
		}
		if (frame.opcode !== 0x1) { return; }

		try {
			const payload = JSON.parse(frame.payload.toString('utf8')) as WsSyncPayload;
			if (payload.sessionCode !== this.activeSessionCode || payload.peerId === this.peerId) {
				return;
			}
			void this.applyDocumentText(payload.uri, payload.text, payload.version);
			const broadcastFrame = wsBuildTextFrame(frame.payload.toString('utf8'));
			for (const client of this.clients) {
				if (client !== socket) {
					try { client.write(broadcastFrame); } catch { this.clients.delete(client); }
				}
			}
		} catch {
			// ignore malformed messages
		}
	}

	private async applyDocumentText(uriString: string, text: string, version: number): Promise<void> {
		const currentVersion = this.sentVersionByUri.get(uriString) ?? 0;
		if (version <= currentVersion) { return; }

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
