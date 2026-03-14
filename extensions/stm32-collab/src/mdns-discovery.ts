/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CollaborationSessionInfo } from './types';

declare const require: (moduleName: string) => unknown;

const osModule = require('os') as {
	hostname: () => string;
	networkInterfaces: () => Record<string, Array<{ family: string; internal: boolean; address: string }> | undefined>;
};

const dgramModule = require('dgram') as {
	createSocket: (type: 'udp4') => {
		on: {
			(event: 'message', listener: (message: Buffer, remote: { address: string; port: number }) => void): void;
			(event: 'error', listener: (error: Error) => void): void;
		};
		bind: (port: number, callback?: () => void) => void;
		close: () => void;
		addMembership: (multicastAddress: string) => void;
		setBroadcast: (flag: boolean) => void;
		setMulticastTTL: (ttl: number) => void;
		send: (buffer: Buffer, port: number, address: string) => void;
	};
};

const BROADCAST_GROUP = '224.0.0.251';
const PACKET_PREFIX = 'cubeforge-stm32-discovery';

export class MdnsDiscoveryService implements vscode.Disposable {
	private socket: ReturnType<typeof dgramModule.createSocket> | undefined;

	public constructor(
		private readonly outputChannel: vscode.OutputChannel,
		private readonly onSessionDiscovered: (session: CollaborationSessionInfo) => void
	) {
	}

	public startListening(port: number): void {
		if (this.socket) {
			return;
		}

		const socket = dgramModule.createSocket('udp4');
		socket.on('message', (message, remote) => {
			const decoded = this.parsePacket(message, remote.address);
			if (decoded) {
				this.onSessionDiscovered(decoded);
			}
		});
		socket.on('error', err => {
			this.outputChannel.appendLine(`[STM32-COLLAB] mDNS socket error: ${err.message}`);
		});
		socket.bind(port, () => {
			socket.setBroadcast(true);
			socket.setMulticastTTL(1);
			socket.addMembership(BROADCAST_GROUP);
			this.outputChannel.appendLine(`[STM32-COLLAB] mDNS listening on ${BROADCAST_GROUP}:${port}`);
		});

		this.socket = socket;
	}

	public announce(port: number, session: CollaborationSessionInfo): void {
		if (!this.socket) {
			this.startListening(port);
		}
		if (!this.socket) {
			return;
		}

		const packet = `${PACKET_PREFIX}:${JSON.stringify(session)}`;
		const payload = Buffer.from(packet, 'utf8');
		this.socket.send(payload, port, BROADCAST_GROUP);
		this.outputChannel.appendLine(`[STM32-COLLAB] mDNS announced: ${session.sessionCode}`);
	}

	public createLocalSession(sessionCode: string, sharePort: number): CollaborationSessionInfo {
		return {
			sessionCode,
			hostName: osModule.hostname(),
			hostAddress: getLocalIpv4Address(),
			workspaceName: vscode.workspace.name ?? 'workspace',
			sharePort,
			timestamp: new Date().toISOString()
		};
	}

	public dispose(): void {
		if (this.socket) {
			this.socket.close();
			this.socket = undefined;
		}
	}

	private parsePacket(message: Buffer, remoteAddress: string): CollaborationSessionInfo | undefined {
		const value = message.toString('utf8');
		if (!value.startsWith(`${PACKET_PREFIX}:`)) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(value.slice(PACKET_PREFIX.length + 1)) as Partial<CollaborationSessionInfo>;
			if (!parsed.sessionCode || !parsed.hostName || !parsed.workspaceName || typeof parsed.sharePort !== 'number') {
				return undefined;
			}
			return {
				sessionCode: parsed.sessionCode,
				hostName: parsed.hostName,
				hostAddress: parsed.hostAddress ?? remoteAddress,
				workspaceName: parsed.workspaceName,
				sharePort: parsed.sharePort,
				timestamp: parsed.timestamp ?? new Date().toISOString()
			};
		} catch {
			return undefined;
		}
	}
}

function getLocalIpv4Address(): string {
	const interfaces = osModule.networkInterfaces();
	for (const key of Object.keys(interfaces)) {
		const values = interfaces[key] ?? [];
		for (const value of values) {
			if (!value.internal && value.family === 'IPv4') {
				return value.address;
			}
		}
	}
	return '127.0.0.1';
}
