"""Bundled MCP stdio diagnostic script.

Usage:
  python mcp_stdio_check.py --workspace <workspace> --server <server.js>
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from queue import Queue, Empty
from typing import Any

TIMEOUT = 12.0


def resolve_node_command() -> str:
    if os.name == 'nt':
        return 'node.exe'
    return 'node'


class Client:
    def __init__(self, command: list[str], cwd: str):
        self.command = command
        self.cwd = cwd
        self.proc: subprocess.Popen[bytes] | None = None
        self.responses: Queue[dict[str, Any]] = Queue()
        self.stderr: list[str] = []

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.command,
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for line in self.proc.stderr:
            self.stderr.append(line.decode('utf-8', errors='replace').rstrip())

    def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        buf = b''
        while True:
            chunk = self.proc.stdout.read(1)
            if not chunk:
                return
            buf += chunk
            while True:
                sep = buf.find(b'\r\n\r\n')
                if sep < 0:
                    sep = buf.find(b'\n\n')
                    sep_len = 2
                else:
                    sep_len = 4
                if sep < 0:
                    break

                header = buf[:sep].decode('utf-8', errors='replace')
                length = None
                for line in header.splitlines():
                    if line.lower().startswith('content-length:'):
                        try:
                            length = int(line.split(':', 1)[1].strip())
                        except ValueError:
                            length = None
                        break

                if length is None:
                    buf = b''
                    break

                end = sep + sep_len + length
                if len(buf) < end:
                    break

                body = buf[sep + sep_len:end]
                buf = buf[end:]
                try:
                    payload = json.loads(body.decode('utf-8', errors='replace'))
                    if isinstance(payload, dict):
                        self.responses.put(payload)
                except json.JSONDecodeError:
                    pass

    def send(self, payload: dict[str, Any]) -> None:
        assert self.proc and self.proc.stdin
        body = json.dumps(payload).encode('utf-8')
        header = f'Content-Length: {len(body)}\r\n\r\n'.encode('ascii')
        self.proc.stdin.write(header + body)
        self.proc.stdin.flush()

    def wait_for(self, req_id: int, timeout: float = TIMEOUT) -> dict[str, Any] | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                return None
            try:
                item = self.responses.get(timeout=0.2)
            except Empty:
                continue
            if item.get('id') == req_id:
                return item
        return None

    def stop(self) -> None:
        if not self.proc:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=2)
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--server', required=True)
    args = parser.parse_args()

    workspace = os.path.abspath(args.workspace)
    server = os.path.abspath(args.server)

    if not os.path.isdir(workspace):
        print('workspace not found', file=sys.stderr)
        return 2
    if not os.path.exists(server):
        print('server not found', file=sys.stderr)
        return 2

    cmd = [resolve_node_command(), server, '--stdio', '--workspace', workspace]
    client = Client(cmd, workspace)
    try:
        client.start()
        time.sleep(0.5)

        client.send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}})
        init = client.wait_for(1)
        if not init or 'result' not in init:
            print('initialize failed', file=sys.stderr)
            return 1

        client.send({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}})
        client.send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        tools = client.wait_for(2)
        if not tools or 'result' not in tools:
            print('tools/list failed', file=sys.stderr)
            return 1

        print('MCP STDIO diagnostic success')
        return 0
    finally:
        client.stop()


if __name__ == '__main__':
    sys.exit(main())
