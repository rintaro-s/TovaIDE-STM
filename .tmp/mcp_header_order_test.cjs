const { spawn } = require('child_process');
const server = spawn(process.execPath, ['mcp-server/index.js', '--stdio', '--workspace', process.cwd()], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = Buffer.alloc(0);
server.stdout.on('data', d => { out = Buffer.concat([out, d]); });
server.stderr.on('data', () => {});
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
const header = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
server.stdin.write(header);
server.stdin.write(body);
setTimeout(() => {
  const text = out.toString('utf8');
  const ok = text.includes('Content-Length:') && text.includes('"id":1') && text.includes('protocolVersion');
  console.log(JSON.stringify({ ok, sample: text.slice(0, 220) }));
  server.kill();
}, 800);
