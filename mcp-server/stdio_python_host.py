#!/usr/bin/env python3
"""Run the Node MCP server under a stable Python host process.

This wrapper keeps stdin/stdout/stderr as raw pipes and avoids shell quoting issues
that can happen with long command lines on Windows MCP clients.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description='Python host wrapper for Node MCP stdio server')
    parser.add_argument('--server', required=True, help='Absolute path to mcp-server/index.js')
    parser.add_argument('--workspace', required=True, help='Target workspace path')
    parser.add_argument('--node', default='node', help='Node executable (default: node)')
    args = parser.parse_args()

    server_path = os.path.abspath(args.server)
    workspace_path = os.path.abspath(args.workspace)

    cmd = [args.node, server_path, '--stdio', '--workspace', workspace_path]

    proc = subprocess.Popen(
        cmd,
        cwd=workspace_path,
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr.buffer,
        shell=False,
    )

    try:
        return proc.wait()
    except KeyboardInterrupt:
        try:
            proc.terminate()
        except Exception:
            pass
        return 130


if __name__ == '__main__':
    sys.exit(main())
