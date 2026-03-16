const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const token = fs.readFileSync(path.join(ws, '.mcp-token'), 'utf8').trim();
const endpoint = 'http://127.0.0.1:3741/mcp';

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
  'stm32.writeFile': { filePath: '.tmp/mcp-smoke-http.txt', content: 'ok', workspacePath: null },
  'stm32.patchUserCode': { filePath: '.tmp/mcp-smoke-user-http.c', patches: [{ sectionName: '0', content: 'int y = 2;' }], workspacePath: null },
  'stm32.createIocFromPins': { mcuName: 'STM32F446RETx', projectName: 'mcp_smoke_http', pins: null, workspacePath: path.join(ws, '.tmp', 'mcp-http') },
  'stm32.parseBuildErrors': { buildOutput: 'main.c:1:1: error: smoke', topN: null },
  'stm32.autoWorkflow': { mcuName: 'STM32F446RETx', goal: 'smoke', projectName: 'awf_http', pins: null, userCodePatches: null, workspacePath: path.join(ws, '.tmp', 'mcp-http'), skipRegenerate: true }
};

fs.mkdirSync(path.join(ws, '.tmp', 'mcp-http'), { recursive: true });
fs.writeFileSync(path.join(ws, '.tmp', 'mcp-smoke-user-http.c'), '/* USER CODE BEGIN 0 */\n/* USER CODE END 0 */\n', 'utf8');

async function rpc(id, method, params) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

(async () => {
  const list = await rpc(2, 'tools/list', {});
  const names = (list?.result?.tools || []).map(t => t.name);
  const results = [];
  let id = 100;
  for (const name of names) {
    const res = await rpc(id, 'tools/call', { name, arguments: payloads[name] ?? {} });
    if (res?.error) {
      results.push({ tool: name, ok: false, code: res.error.code, message: res.error.message });
    } else {
      const structured = res?.result?.structuredContent;
      const short = structured?.success === false && structured?.error ? structured.error : undefined;
      results.push({ tool: name, ok: true, detail: short });
    }
    id += 1;
  }
  console.log(JSON.stringify({ toolCount: names.length, results }, null, 2));
})();
