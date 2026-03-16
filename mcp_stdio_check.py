"""MCP STDIOサーバー診断スクリプト

使い方:
  python mcp_stdio_check.py
  python mcp_stdio_check.py --workspace E:\path\to\workspace
  python mcp_stdio_check.py --server E:\path\to\mcp-server\index.js
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from typing import Any

TIMEOUT = 12  # 秒
NPX_CMD = 'npx.cmd' if os.name == 'nt' else 'npx'


def section(title: str) -> None:
    print(f"\n{'='*50}")
    print(f"  {title}")
    print('='*50)


def ok(msg: str) -> None:
    print(f"  [OK]  {msg}")


def ng(msg: str) -> None:
    print(f"  [NG]  {msg}")


def info(msg: str) -> None:
    print(f"  [--]  {msg}")


def resolve_paths(args: argparse.Namespace) -> tuple[str, str]:
    workspace = os.path.abspath(args.workspace or os.getcwd())
    server = os.path.abspath(args.server or os.path.join(workspace, 'mcp-server', 'index.js'))
    return workspace, server


def check_prerequisites(workspace: str, server_js: str) -> None:
    section('1. 前提条件チェック')

    if os.path.exists(server_js):
        ok(f'index.js が存在する: {server_js}')
    else:
        ng(f'index.js が見つからない: {server_js}')
        print('\n  ⚠ このファイルがないと何も動きません。--workspace または --server を指定してください。')
        sys.exit(1)

    if os.path.isdir(workspace):
        ok(f'workspace が存在する: {workspace}')
    else:
        ng(f'workspace が見つからない: {workspace}')
        sys.exit(1)

    try:
        r = subprocess.run([NPX_CMD, '--version'], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            ok(f"npx バージョン: {r.stdout.strip()}")
        else:
            ng(f"npx の実行に失敗: {r.stderr.strip()[:120]}")
            sys.exit(1)
    except FileNotFoundError:
        ng('npx が見つかりません。Node.jsをインストールしてください。')
        sys.exit(1)


class McpStdioClient:
    def __init__(self, command: list[str], cwd: str):
        self.command = command
        self.cwd = cwd
        self.proc: subprocess.Popen[bytes] | None = None
        self.stderr_lines: list[str] = []
        self._responses: queue.Queue[dict[str, Any]] = queue.Queue()

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            shell=False,
        )

        threading.Thread(target=self._read_stderr, daemon=True).start()
        threading.Thread(target=self._read_stdout_frames, daemon=True).start()

    def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for line in self.proc.stderr:
            self.stderr_lines.append(line.decode('utf-8', errors='replace').rstrip())

    def _read_stdout_frames(self) -> None:
        assert self.proc and self.proc.stdout
        buffer = b''
        while True:
            chunk = self.proc.stdout.read(1)
            if not chunk:
                return
            buffer += chunk

            while True:
                sep = buffer.find(b'\r\n\r\n')
                if sep < 0:
                    break
                header = buffer[:sep].decode('utf-8', errors='replace')
                m = None
                for line in header.split('\r\n'):
                    if line.lower().startswith('content-length:'):
                        m = line.split(':', 1)[1].strip()
                        break
                if not m:
                    buffer = b''
                    break
                try:
                    length = int(m)
                except ValueError:
                    buffer = b''
                    break

                frame_end = sep + 4 + length
                if len(buffer) < frame_end:
                    break

                body = buffer[sep + 4:frame_end]
                buffer = buffer[frame_end:]
                try:
                    payload = json.loads(body.decode('utf-8', errors='replace'))
                    if isinstance(payload, dict):
                        self._responses.put(payload)
                except Exception:
                    pass

    def send(self, payload: dict[str, Any]) -> None:
        assert self.proc and self.proc.stdin
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        header = f'Content-Length: {len(body)}\r\n\r\n'.encode('ascii')
        self.proc.stdin.write(header + body)
        self.proc.stdin.flush()

    def wait_response(self, msg_id: int, timeout: float = TIMEOUT) -> dict[str, Any] | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                return None
            try:
                item = self._responses.get(timeout=0.2)
            except queue.Empty:
                continue
            if item.get('id') == msg_id:
                return item
        return None

    def stop(self) -> None:
        if not self.proc:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            pass


def check_server_startup(workspace: str, server_js: str) -> McpStdioClient | None:
    section('2. サーバー起動チェック')
    command = [NPX_CMD, '--yes', 'tsx', server_js, '--stdio', '--workspace', workspace]
    info(f"コマンド: {' '.join(command)}")

    client = McpStdioClient(command, workspace)
    try:
        client.start()
    except Exception as exc:
        ng(f'プロセス起動失敗: {exc}')
        return None

    time.sleep(1.2)
    if client.proc and client.proc.poll() is not None:
        ng(f'サーバーがすぐに終了しました (終了コード: {client.proc.returncode})')
        if client.stderr_lines:
            print('\n  --- stderr ---')
            for line in client.stderr_lines[:25]:
                print(f'    {line}')
        return None

    ok('サーバープロセスが起動・継続中')
    return client


def check_initialize(client: McpStdioClient) -> bool:
    section('3. MCP ハンドシェイク (initialize)')
    req = {
        'jsonrpc': '2.0',
        'id': 1,
        'method': 'initialize',
        'params': {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'diagnostic', 'version': '1.0'}
        }
    }
    client.send(req)
    resp = client.wait_response(1)

    if not resp:
        ng(f'{TIMEOUT}秒待っても initialize のレスポンスがありません')
        if client.stderr_lines:
            print('\n  --- stderr ---')
            for line in client.stderr_lines[:30]:
                print(f'    {line}')
        return False

    if 'error' in resp:
        ng(f"initialize エラー: {resp['error']}")
        return False

    result = resp.get('result', {})
    ok('initialize 成功')
    info(f"server: {result.get('serverInfo', {}).get('name', '不明')}")
    info(f"protocolVersion: {result.get('protocolVersion', '不明')}")

    # initialized notification (responseなし)
    client.send({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}})
    return True


def check_tools_list(client: McpStdioClient) -> bool:
    section('4. ツール一覧取得 (tools/list)')
    client.send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
    resp = client.wait_response(2)
    if not resp:
        ng('tools/list のレスポンスがありません')
        return False
    if 'error' in resp:
        ng(f"tools/list エラー: {resp['error']}")
        return False

    tools = resp.get('result', {}).get('tools', [])
    ok(f'ツール数: {len(tools)}')
    for tool in tools[:8]:
        info(f"  - {tool.get('name', 'unknown')}")
    return True


def check_tools_call(client: McpStdioClient) -> bool:
    section('5. ツール実行 (tools/call)')
    req = {
        'jsonrpc': '2.0',
        'id': 3,
        'method': 'tools/call',
        'params': {
            'name': 'stm32.listWorkspaceFiles',
            'arguments': {}
        }
    }
    client.send(req)
    resp = client.wait_response(3)
    if not resp:
        ng('tools/call のレスポンスがありません')
        return False
    if 'error' in resp:
        ng(f"tools/call エラー: {resp['error']}")
        return False
    ok('tools/call 成功')
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='MCP STDIO server diagnostic')
    parser.add_argument('--workspace', help='workspace path (default: current working directory)')
    parser.add_argument('--server', help='path to mcp-server/index.js')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workspace, server_js = resolve_paths(args)

    print('\n🔍 MCP STDIOサーバー診断ツール')
    print(f'   対象: {server_js}')

    check_prerequisites(workspace, server_js)
    client = check_server_startup(workspace, server_js)
    if client is None:
        section('結果サマリー')
        ng('サーバー起動に失敗しました')
        sys.exit(1)

    success_init = check_initialize(client)
    success_list = check_tools_list(client) if success_init else False
    success_call = check_tools_call(client) if success_list else False

    section('結果サマリー')
    if success_init and success_list and success_call:
        ok('MCP STDIO診断は成功しました（initialize/tools/list/tools/call）')
    else:
        ng('MCP STDIO診断に失敗しました')
        if client.stderr_lines:
            info('stderr末尾:')
            for line in client.stderr_lines[-20:]:
                print(f'    {line}')

    client.stop()


if __name__ == '__main__':
    main()
