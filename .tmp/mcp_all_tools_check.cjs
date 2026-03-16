const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const tempWs = path.join(ws, '.tmp', 'mcp-toolcheck');
fs.mkdirSync(tempWs, { recursive: true });

const cp = spawn(process.execPath, ['mcp-server/index.js', '--stdio', '--workspace', ws], { cwd: ws, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = Buffer.alloc(0);
const responses = [];

cp.stdout.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const m = buf.slice(0, sep).toString('utf8').match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = Buffer.alloc(0); break; }
    const len = Number(m[1]);
    const end = sep + 4 + len;
    if (buf.length < end) break;
    const body = buf.slice(sep + 4, end).toString('utf8');
    buf = buf.slice(end);
    try { responses.push(JSON.parse(body)); } catch {}
  }
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  cp.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  cp.stdin.write(body);
}

function waitFor(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const i = responses.findIndex(r => r && r.id === id);
      if (i >= 0) {
        const r = responses.splice(i, 1)[0];
        clearInterval(iv);
        resolve(r);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('timeout ' + id));
      }
    }, 20);
  });
}

const payloads = {
  'stm32.getProjectInfo': { workspacePath: null },
  'stm32.build': { jobs: null, workspacePath: null },
  'stm32.flash': { elfPath: null, frequencyKHz: null, workspacePath: null },
  'stm32.regenerateCode': { iocPath: null, cubemxPath: null },
  'stm32.analyzeHardFault': { cfsr: '0x00000000', hfsr: null, mmfar: null, bfar: null },
  'stm32.listElfSymbols': { elfPath: null, topN: null },
  'stm32.checkStLink': { programmerPath: null },
  'stm32.readRegister': { address: '0x40000000', programmerPath: null },
  'stm32.listWorkspaceFiles': { workspacePath: null, extensions: null },
  'stm32.readFile': { filePath: 'README.md', workspacePath: null },
  'stm32.writeFile': { filePath: '.tmp/mcp-smoke.txt', content: 'ok', workspacePath: null },
  'stm32.patchUserCode': { filePath: '.tmp/mcp-smoke-user.c', patches: [{ sectionName: '0', content: 'int x = 1;' }], workspacePath: null },
  'stm32.createIocFromPins': { mcuName: 'STM32F446RETx', projectName: 'mcp_smoke', pins: null, workspacePath: tempWs },
  'stm32.parseBuildErrors': { buildOutput: 'main.c:1:1: error: smoke', topN: null },
  'stm32.autoWorkflow': { mcuName: 'STM32F446RETx', goal: 'smoke', projectName: 'awf', pins: null, userCodePatches: null, workspacePath: tempWs, skipRegenerate: true }
};

// prep file for patchUserCode tool
fs.writeFileSync(path.join(ws, '.tmp', 'mcp-smoke-user.c'), '/* USER CODE BEGIN 0 */\n/* USER CODE END 0 */\n', 'utf8');

(async () => {
  const results = [];
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listResp = await waitFor(2);
  const tools = (listResp.result?.tools || []).map(t => t.name);

  let id = 100;
  for (const name of tools) {
    const params = payloads[name] ?? {};
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: params } });
    try {
      const r = await waitFor(id, 30000);
      if (r.error) {
        results.push({ tool: name, ok: false, code: r.error.code, message: r.error.message });
      } else {
        results.push({ tool: name, ok: true });
      }
    } catch (e) {
      results.push({ tool: name, ok: false, code: 'timeout', message: String(e.message || e) });
    }
    id += 1;
  }

  console.log(JSON.stringify({ count: results.length, results }, null, 2));
  cp.kill();
})();
