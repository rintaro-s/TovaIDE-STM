#!/usr/bin/env node
/**
 * CubeForge IDE — Standalone MCP Server
 * JSON-RPC 2.0 over HTTP, port 3737 (configurable)
 * Compatible with GitHub Copilot MCP and external AI clients.
 *
 * Endpoints:
 *   POST /mcp          — JSON-RPC tool dispatch
 *   GET  /health       — Health check
 *   GET  /tools        — List available tools (convenience)
 */

'use strict';

const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// ─── Config ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const PORT = parseInt(getArg(args, '--port') ?? '3737', 10);
const HOST = getArg(args, '--host') ?? '127.0.0.1';
const VERBOSE = args.includes('--verbose');
const WORKSPACE = getArg(args, '--workspace') ?? process.cwd();

function getArg(arr, flag) {
  const i = arr.indexOf(flag);
  return i >= 0 && i + 1 < arr.length ? arr[i + 1] : null;
}

// Shared bearer token (written to .mcp-token on startup)
const TOKEN_FILE = path.join(WORKSPACE, '.mcp-token');
let SERVER_TOKEN = '';

function initToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      SERVER_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (SERVER_TOKEN.length > 0) return;
    }
  } catch (_) {}
  SERVER_TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, SERVER_TOKEN, { mode: 0o600 });
  log(`Token written to ${TOKEN_FILE}`);
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(...args) {
  console.log(`[MCP ${new Date().toISOString()}]`, ...args);
}
function verbose(...args) {
  if (VERBOSE) log(...args);
}

// ─── Tool Definitions ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'stm32.getProjectInfo',
    description: 'Read and parse the .ioc file in the workspace root. Returns MCU name, board, peripherals, and clock hints.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Workspace root path (optional, defaults to server workspace)' }
      }
    }
  },
  {
    name: 'stm32.build',
    description: 'Run make to build the STM32 Debug target. Returns exit code, stdout, and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        jobs: { type: 'number', description: 'Parallel make jobs (default: 8)' },
        workspacePath: { type: 'string', description: 'Workspace root path (optional)' }
      }
    }
  },
  {
    name: 'stm32.flash',
    description: 'Flash the latest built ELF to the connected STM32 device via ST-LINK.',
    inputSchema: {
      type: 'object',
      properties: {
        elfPath: { type: 'string', description: 'Path to ELF file (auto-detected if omitted)' },
        frequencyKHz: { type: 'number', description: 'SWD frequency in kHz (default: 4000)' },
        workspacePath: { type: 'string', description: 'Workspace root path (optional)' }
      }
    }
  },
  {
    name: 'stm32.regenerateCode',
    description: 'Run STM32CubeMX CLI to regenerate code from the .ioc file.',
    inputSchema: {
      type: 'object',
      properties: {
        iocPath: { type: 'string', description: 'Path to .ioc file (auto-detected if omitted)' },
        cubemxPath: { type: 'string', description: 'Path to STM32CubeMX executable (optional)' }
      }
    }
  },
  {
    name: 'stm32.analyzeHardFault',
    description: 'Decode STM32 HardFault/BusFault/UsageFault registers (CFSR, HFSR, MMFAR, BFAR) and return human-readable diagnosis.',
    inputSchema: {
      type: 'object',
      required: ['cfsr'],
      properties: {
        cfsr:  { type: 'string', description: 'ConfigurableFaultStatus Register value (e.g. 0x00008200)' },
        hfsr:  { type: 'string', description: 'HardFault Status Register (optional)' },
        mmfar: { type: 'string', description: 'MemManage Fault Address Register (optional)' },
        bfar:  { type: 'string', description: 'BusFault Address Register (optional)' }
      }
    }
  },
  {
    name: 'stm32.listElfSymbols',
    description: 'Run arm-none-eabi-nm on the ELF file and return the 20 largest symbols for code size analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        elfPath: { type: 'string', description: 'Path to ELF file (auto-detected if omitted)' },
        topN: { type: 'number', description: 'Number of largest symbols to return (default: 20)' }
      }
    }
  },
  {
    name: 'stm32.checkStLink',
    description: 'Run STM32_Programmer_CLI to detect connected ST-LINK devices.',
    inputSchema: {
      type: 'object',
      properties: {
        programmerPath: { type: 'string', description: 'Path to STM32_Programmer_CLI (optional)' }
      }
    }
  },
  {
    name: 'stm32.readRegister',
    description: 'Read a peripheral register value from a running/halted STM32 via ST-LINK.',
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Register address in hex (e.g. 0x40020010)' },
        programmerPath: { type: 'string', description: 'Path to STM32_Programmer_CLI (optional)' }
      }
    }
  }
];

// ─── Tool Implementations ────────────────────────────────────────────────────

async function toolGetProjectInfo(params) {
  const wsRoot = params.workspacePath ?? WORKSPACE;
  const entries = fs.readdirSync(wsRoot);
  const iocFile = entries.find(e => e.toLowerCase().endsWith('.ioc'));
  if (!iocFile) {
    return { found: false, message: '.ioc file not found in workspace root' };
  }
  const iocPath = path.join(wsRoot, iocFile);
  const content = fs.readFileSync(iocPath, 'utf8');
  const lines = content.split('\n');

  function getVal(key) {
    const line = lines.find(l => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() : undefined;
  }

  const mcu = getVal('Mcu.UserName') ?? getVal('MCU.Name') ?? getVal('Mcu.Family') ?? 'Unknown';
  const board = getVal('board') ?? getVal('BoardName') ?? 'Custom Board';
  const projectName = getVal('ProjectManager.ProjectName') ?? path.basename(wsRoot);

  const peripherals = [];
  const clockHints = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)\.(Mode|Signal)=(.+)$/);
    if (m && !m[1].startsWith('Mcu') && !peripherals.includes(m[1])) {
      peripherals.push(m[1]);
    }
    if (/HCLK.*=\s*(\d+)/.test(line)) {
      const hz = line.match(/=\s*(\d+)/)?.[1];
      if (hz) clockHints.push(`HCLK: ${Math.round(Number(hz) / 1000000)} MHz`);
    }
  }

  return {
    found: true,
    iocPath,
    mcu,
    board,
    projectName,
    usedPeripherals: peripherals.slice(0, 32),
    clockHints: [...new Set(clockHints)].slice(0, 8),
    lineCount: lines.length
  };
}

async function toolBuild(params) {
  const wsRoot = params.workspacePath ?? WORKSPACE;
  const jobs = params.jobs ?? 8;
  try {
    const { stdout, stderr } = await execFileAsync('make', [`-j${jobs}`, 'all', '-C', './Debug'], {
      cwd: wsRoot,
      timeout: 120000
    });
    return { success: true, exitCode: 0, stdout, stderr };
  } catch (err) {
    return {
      success: false,
      exitCode: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? ''
    };
  }
}

async function toolFlash(params) {
  const wsRoot = params.workspacePath ?? WORKSPACE;
  const freq = params.frequencyKHz ?? 4000;
  let elfPath = params.elfPath;

  if (!elfPath) {
    elfPath = findElfFile(wsRoot);
    if (!elfPath) {
      return { success: false, error: 'ELF file not found. Build the project first.' };
    }
  }

  const programmer = findExecutable('STM32_Programmer_CLI');
  try {
    const { stdout, stderr } = await execFileAsync(
      programmer,
      ['-c', 'port=SWD', `freq=${freq}`, '-w', elfPath, '0x08000000', '-v'],
      { cwd: wsRoot, timeout: 60000 }
    );
    return { success: true, elfPath, stdout, stderr };
  } catch (err) {
    return { success: false, elfPath, exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  }
}

async function toolRegenerateCode(params) {
  const cubemxPath = params.cubemxPath ?? findExecutable('STM32CubeMX');
  let iocPath = params.iocPath;

  if (!iocPath) {
    const wsRoot = WORKSPACE;
    const entries = fs.readdirSync(wsRoot);
    const iocFile = entries.find(e => e.toLowerCase().endsWith('.ioc'));
    if (iocFile) iocPath = path.join(wsRoot, iocFile);
  }

  if (!iocPath) {
    return { success: false, error: '.ioc file not found' };
  }

  const scriptContent = `config load "${iocPath}"\ngenerate code\nexit\n`;
  const scriptPath = path.join(require('os').tmpdir(), `cubemx-script-${Date.now()}.txt`);
  fs.writeFileSync(scriptPath, scriptContent, 'utf8');

  try {
    const { stdout, stderr } = await execFileAsync(cubemxPath, ['-s', scriptPath], { timeout: 120000 });
    return { success: true, iocPath, stdout, stderr };
  } catch (err) {
    return { success: false, iocPath, exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  } finally {
    fs.unlink(scriptPath, () => {});
  }
}

function toolAnalyzeHardFault(params) {
  const cfsr = parseInt(params.cfsr, 16);
  const hfsr = params.hfsr ? parseInt(params.hfsr, 16) : null;
  const mmfar = params.mmfar ?? null;
  const bfar = params.bfar ?? null;
  const issues = [];

  // UFSR (Usage Fault) bits 15:0 of CFSR
  if (cfsr & 0x0001) issues.push({ type: 'UsageFault', bit: 'UNDEFINSTR', desc: '未定義命令を実行しました。不正なメモリ番地へのジャンプの可能性があります。' });
  if (cfsr & 0x0002) issues.push({ type: 'UsageFault', bit: 'INVSTATE',   desc: '不正なEPSR状態。Thumbビット未設定でジャンプした可能性があります。' });
  if (cfsr & 0x0004) issues.push({ type: 'UsageFault', bit: 'INVPC',      desc: '不正なPC値によるEXC_RETURNエラーです。' });
  if (cfsr & 0x0008) issues.push({ type: 'UsageFault', bit: 'NOCP',       desc: 'コプロセッサ(FPU等)が無効なのに使用されました。' });
  if (cfsr & 0x0100) issues.push({ type: 'UsageFault', bit: 'UNALIGNED',  desc: '非アラインアクセス。SCB->CCR の UNALIGN_TRP が設定されています。' });
  if (cfsr & 0x0200) issues.push({ type: 'UsageFault', bit: 'DIVBYZERO',  desc: 'ゼロ除算が発生しました。SCB->CCR の DIV_0_TRP が設定されています。' });

  // BFSR bits 15:8 of CFSR
  if (cfsr & 0x0100_0000 >> 16) {}  // alias correction — use direct bit test
  const bfsr = (cfsr >> 8) & 0xFF;
  if (bfsr & 0x01) issues.push({ type: 'BusFault', bit: 'IBUSERR',    desc: '命令フェッチBusエラー。PCが不正なFlash/RAM番地を指しています。' });
  if (bfsr & 0x02) issues.push({ type: 'BusFault', bit: 'PRECISERR',  desc: `正確なデータBusエラー。アドレス: ${bfar ?? '不明'}`, address: bfar });
  if (bfsr & 0x04) issues.push({ type: 'BusFault', bit: 'IMPRECISERR', desc: 'バッファリングによる不正確なBusエラー。DMAや非同期アクセスを確認してください。' });
  if (bfsr & 0x08) issues.push({ type: 'BusFault', bit: 'UNSTKERR',   desc: 'スタック復元中にBusエラー。スタックオーバーフローの可能性があります。' });
  if (bfsr & 0x10) issues.push({ type: 'BusFault', bit: 'STKERR',     desc: 'スタック保存中にBusエラー。スタックポインタが不正です。' });

  // MMFSR bits 7:0 of CFSR
  const mmfsr = cfsr & 0xFF;
  if (mmfsr & 0x01) issues.push({ type: 'MemManage', bit: 'IACCVIOL',  desc: '命令フェッチでMPU違反。MPUの設定を確認してください。' });
  if (mmfsr & 0x02) issues.push({ type: 'MemManage', bit: 'DACCVIOL',  desc: `データアクセスでMPU違反。アドレス: ${mmfar ?? '不明'}`, address: mmfar });
  if (mmfsr & 0x08) issues.push({ type: 'MemManage', bit: 'MUNSTKERR', desc: 'スタック復元中にMPU違反。' });
  if (mmfsr & 0x10) issues.push({ type: 'MemManage', bit: 'MSTKERR',   desc: 'スタック保存中にMPU違反。' });

  // HFSR
  const hfsrIssues = [];
  if (hfsr !== null) {
    if (hfsr & 0x40000000) hfsrIssues.push('FORCED: 他のフォルトが昇格してHardFaultになりました。CFSR の詳細を確認してください。');
    if (hfsr & 0x00000002) hfsrIssues.push('VECTTBL: ベクターテーブルフェッチエラー。ベクターテーブルのアドレスが不正です。');
    if (hfsr & 0x80000000) hfsrIssues.push('DEBUGEVT: デバッガイベントが原因です。');
  }

  const priority = issues.length > 0
    ? issues.map(i => `[${i.type}/${i.bit}] ${i.desc}`).join('\n')
    : 'CFSR=0x00000000: 明示的なフォルトビットなし。HFSRのFORCEDビットを確認してください。';

  return {
    cfsr: `0x${cfsr.toString(16).padStart(8, '0').toUpperCase()}`,
    hfsr: hfsr !== null ? `0x${hfsr.toString(16).padStart(8, '0').toUpperCase()}` : null,
    faults: issues,
    hfsrFaults: hfsrIssues,
    diagnosis: priority,
    recommendations: buildRecommendations(issues)
  };
}

function buildRecommendations(issues) {
  const recs = [];
  if (issues.some(i => i.bit === 'UNDEFINSTR' || i.bit === 'INVSTATE')) {
    recs.push('関数ポインタのThumbビット(LSB=1)を確認してください。');
    recs.push('スタックオーバーフローでPCが破損している可能性があります。スタックサイズを確認してください。');
  }
  if (issues.some(i => i.type === 'BusFault' && i.bit === 'PRECISERR')) {
    recs.push(`BFARアドレス(${issues.find(i=>i.bit==='PRECISERR')?.address ?? '不明'})を確認してください。NULLポインタや範囲外アクセスの可能性があります。`);
  }
  if (issues.some(i => i.bit === 'STKERR' || i.bit === 'UNSTKERR')) {
    recs.push('FreeRTOSタスクのスタックサイズを増やし、uxTaskGetStackHighWaterMark()で残量を確認してください。');
  }
  if (issues.some(i => i.bit === 'DIVBYZERO')) {
    recs.push('除算前に除数が0でないことを確認してください。');
  }
  if (issues.length === 0) {
    recs.push('CubeProgrammer または GDB で SCB->CFSR/HFSR/MMFAR/BFAR を直接読んでください。');
  }
  return recs;
}

async function toolListElfSymbols(params) {
  const wsRoot = WORKSPACE;
  let elfPath = params.elfPath ?? findElfFile(wsRoot);
  if (!elfPath) return { success: false, error: 'ELF file not found' };

  const topN = params.topN ?? 20;
  try {
    const { stdout } = await execFileAsync('arm-none-eabi-nm', ['-S', '--size-sort', elfPath], { timeout: 30000 });
    const lines = stdout.trim().split('\n').reverse().slice(0, topN);
    const symbols = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        address: parts[0] ?? '',
        size: parseInt(parts[1] ?? '0', 16),
        type: parts[2] ?? '',
        name: parts.slice(3).join(' ')
      };
    });
    return { success: true, elfPath, symbols };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function toolCheckStLink(params) {
  const programmer = params.programmerPath ?? findExecutable('STM32_Programmer_CLI');
  try {
    const { stdout, stderr } = await execFileAsync(programmer, ['-l', 'usb'], { timeout: 15000 });
    const connected = /ST-?LINK/i.test(stdout + stderr);
    return { success: true, connected, stdout, stderr };
  } catch (err) {
    return { success: false, connected: false, error: err.message };
  }
}

async function toolReadRegister(params) {
  const programmer = params.programmerPath ?? findExecutable('STM32_Programmer_CLI');
  const address = params.address;
  try {
    const { stdout, stderr } = await execFileAsync(
      programmer,
      ['-c', 'port=SWD', '-rw', address, '0x1'],
      { timeout: 15000 }
    );
    const match = stdout.match(/0x([0-9A-Fa-f]+)/);
    return { success: true, address, value: match ? `0x${match[1].toUpperCase()}` : null, stdout, stderr };
  } catch (err) {
    return { success: false, address, error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findElfFile(wsRoot) {
  for (const sub of ['Debug', 'Release']) {
    const dir = path.join(wsRoot, sub);
    try {
      const files = fs.readdirSync(dir);
      const elf = files.find(f => f.toLowerCase().endsWith('.elf'));
      if (elf) return path.join(dir, elf);
    } catch (_) {}
  }
  return null;
}

function findExecutable(name) {
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  return name + ext;
}

// ─── JSON-RPC Dispatch ────────────────────────────────────────────────────────

async function dispatch(method, params) {
  params = params ?? {};
  switch (method) {
    case 'tools/list':
      return { tools: TOOLS };
    case 'stm32.getProjectInfo':
      return await toolGetProjectInfo(params);
    case 'stm32.build':
      return await toolBuild(params);
    case 'stm32.flash':
      return await toolFlash(params);
    case 'stm32.regenerateCode':
      return await toolRegenerateCode(params);
    case 'stm32.analyzeHardFault':
      return toolAnalyzeHardFault(params);
    case 'stm32.listElfSymbols':
      return await toolListElfSymbols(params);
    case 'stm32.checkStLink':
      return await toolCheckStLink(params);
    case 'stm32.readRegister':
      return await toolReadRegister(params);
    default:
      throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJson(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  verbose(`${req.method} ${req.url}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    writeJson(res, 200, { status: 'ok', version: '1.0.0', workspace: WORKSPACE });
    return;
  }

  // Tool list convenience endpoint
  if (req.method === 'GET' && req.url === '/tools') {
    writeJson(res, 200, { tools: TOOLS });
    return;
  }

  // Main MCP endpoint
  if (req.method === 'POST' && req.url === '/mcp') {
    // Auth check
    const auth = req.headers['authorization'] ?? '';
    if (SERVER_TOKEN && auth !== `Bearer ${SERVER_TOKEN}`) {
      writeJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }

    let payload;
    try {
      const body = await readBody(req);
      payload = JSON.parse(body);
    } catch {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const id = payload.id ?? null;
    try {
      const result = await dispatch(payload.method, payload.params);
      writeJson(res, 200, { jsonrpc: '2.0', id, result });
    } catch (err) {
      const code = typeof err.code === 'number' ? err.code : -32000;
      writeJson(res, 500, { jsonrpc: '2.0', id, error: { code, message: err.message } });
    }
    return;
  }

  writeJson(res, 404, { error: 'Not found' });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[MCP] Port ${PORT} already in use. Use --port <N> to change.`);
  } else {
    console.error('[MCP] Server error:', err.message);
  }
  process.exit(1);
});

// ─── Start ────────────────────────────────────────────────────────────────────
initToken();
server.listen(PORT, HOST, () => {
  log(`CubeForge MCP Server listening on http://${HOST}:${PORT}/mcp`);
  log(`Workspace: ${WORKSPACE}`);
  log(`Token file: ${TOKEN_FILE}`);
  log(`Tools: ${TOOLS.map(t => t.name).join(', ')}`);
});
