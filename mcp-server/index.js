#!/usr/bin/env node
/**
 * TovaIDE-STM — Standalone MCP Server
 * MCP-compatible JSON-RPC server over HTTP or stdio
 * Compatible with GitHub Copilot MCP and external AI clients.
 *
 * Endpoints:
 *   POST /mcp          — JSON-RPC tool dispatch
 *   GET  /health       — Health check
 *   GET  /tools        — List available tools (convenience)
 */

'use strict';

const http = require('http');
const { execFile, spawn, spawnSync } = require('child_process');
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
const STDIO_MODE = args.includes('--stdio');
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
	} catch (_) { }
	SERVER_TOKEN = crypto.randomBytes(24).toString('hex');
	fs.writeFileSync(TOKEN_FILE, SERVER_TOKEN, { mode: 0o600 });
	log(`Token written to ${TOKEN_FILE}`);
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(...args) {
	if (STDIO_MODE) {
		if (VERBOSE) {
			console.error(`[MCP ${new Date().toISOString()}]`, ...args);
		}
		return;
	}
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
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional, defaults to server workspace)' }
			}
		}
	},
	{
		name: 'stm32.build',
		description: 'Run make to build the STM32 Debug target. Returns exit code, stdout, and stderr.',
		inputSchema: {
			type: 'object',
			properties: {
				jobs: { type: ['number', 'null'], description: 'Parallel make jobs (default: 8)' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' },
				makePath: { type: ['string', 'null'], description: 'Path to make executable (optional, auto-detected when omitted)' }
			}
		}
	},
	{
		name: 'stm32.flash',
		description: 'Flash the latest built ELF to the connected STM32 device via ST-LINK.',
		inputSchema: {
			type: 'object',
			properties: {
				elfPath: { type: ['string', 'null'], description: 'Path to ELF file (auto-detected if omitted)' },
				frequencyKHz: { type: ['number', 'null'], description: 'SWD frequency in kHz (default: 4000)' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' }
			}
		}
	},
	{
		name: 'stm32.regenerateCode',
		description: 'Run STM32CubeMX CLI to regenerate code from the .ioc file.',
		inputSchema: {
			type: 'object',
			properties: {
				iocPath: { type: ['string', 'null'], description: 'Path to .ioc file (auto-detected if omitted)' },
				cubemxPath: { type: ['string', 'null'], description: 'Path to STM32CubeMX executable (optional)' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' }
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
				cfsr: { type: 'string', description: 'ConfigurableFaultStatus Register value (e.g. 0x00008200)' },
				hfsr: { type: ['string', 'null'], description: 'HardFault Status Register (optional)' },
				mmfar: { type: ['string', 'null'], description: 'MemManage Fault Address Register (optional)' },
				bfar: { type: ['string', 'null'], description: 'BusFault Address Register (optional)' }
			}
		}
	},
	{
		name: 'stm32.listElfSymbols',
		description: 'Run arm-none-eabi-nm on the ELF file and return the 20 largest symbols for code size analysis.',
		inputSchema: {
			type: 'object',
			properties: {
				elfPath: { type: ['string', 'null'], description: 'Path to ELF file (auto-detected if omitted)' },
				topN: { type: ['number', 'null'], description: 'Number of largest symbols to return (default: 20)' }
			}
		}
	},
	{
		name: 'stm32.checkStLink',
		description: 'Run STM32_Programmer_CLI to detect connected ST-LINK devices.',
		inputSchema: {
			type: 'object',
			properties: {
				programmerPath: { type: ['string', 'null'], description: 'Path to STM32_Programmer_CLI (optional)' }
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
				programmerPath: { type: ['string', 'null'], description: 'Path to STM32_Programmer_CLI (optional)' }
			}
		}
	},
	{
		name: 'stm32.listWorkspaceFiles',
		description: 'List all relevant source files (.c, .h, .ioc, .s, CMakeLists.txt, Makefile) in the workspace. Use this to understand project structure before reading or editing files.',
		inputSchema: {
			type: 'object',
			properties: {
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' },
				extensions: { type: ['array', 'null'], items: { type: 'string' }, description: 'File extensions to include (default: [".c",".h",".ioc",".s",".cmake","Makefile"])' }
			}
		}
	},
	{
		name: 'stm32.readFile',
		description: 'Read the contents of a file in the workspace. Use this to inspect main.c user code sections, .ioc configuration, or build scripts before making changes.',
		inputSchema: {
			type: 'object',
			required: ['filePath'],
			properties: {
				filePath: { type: 'string', description: 'Relative path from workspace root (e.g. Core/Src/main.c)' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' }
			}
		}
	},
	{
		name: 'stm32.writeFile',
		description: 'Write or overwrite a file in the workspace. Only writes files inside the workspace root for safety. Use stm32.patchUserCode for generated files to preserve CubeMX sections.',
		inputSchema: {
			type: 'object',
			required: ['filePath', 'content'],
			properties: {
				filePath: { type: 'string', description: 'Relative path from workspace root (e.g. Core/Src/app.c)' },
				content: { type: 'string', description: 'Full file content to write' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' }
			}
		}
	},
	{
		name: 'stm32.patchUserCode',
		description: 'Patch only the /* USER CODE BEGIN xxx */ ... /* USER CODE END xxx */ sections in a CubeMX-generated file (e.g. main.c). Preserves all generated code outside user sections. Ideal for writing application logic without breaking CubeMX regeneration.',
		inputSchema: {
			type: 'object',
			required: ['filePath', 'patches'],
			properties: {
				filePath: { type: 'string', description: 'Relative path from workspace root (e.g. Core/Src/main.c)' },
				patches: {
					type: 'array',
					description: 'List of sections to patch',
					items: {
						type: 'object',
						required: ['sectionName', 'content'],
						properties: {
							sectionName: { type: 'string', description: 'USER CODE section name (e.g. "Includes", "PV", "0", "2", "BEGIN 3")' },
							content: { type: 'string', description: 'Code to insert between BEGIN and END markers (replaces existing content)' }
						}
					}
				},
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' }
			}
		}
	},
	{
		name: 'stm32.createIocFromPins',
		description: 'Create a minimal .ioc file from scratch given MCU name and pin assignments. Use this to bootstrap a project before running stm32.regenerateCode. The .ioc will be placed at the workspace root.',
		inputSchema: {
			type: 'object',
			required: ['mcuName'],
			properties: {
				mcuName: { type: 'string', description: 'MCU name (e.g. STM32F446RETx, STM32H743ZITx)' },
				projectName: { type: ['string', 'null'], description: 'CubeMX project name (default: project)' },
				pins: {
					type: ['array', 'null'],
					description: 'Pin assignments to write into the .ioc',
					items: {
						type: 'object',
						required: ['pin', 'mode'],
						properties: {
							pin: { type: 'string', description: 'Pin name (e.g. PA5, PB10)' },
							mode: { type: 'string', description: 'Mode string (e.g. GPIO_Output, USART2_TX, TIM2_CH1)' }
						}
					}
				},
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' }
			}
		}
	},
	{
		name: 'stm32.parseBuildErrors',
		description: 'Parse raw make/gcc build output (stdout+stderr) into structured error and warning objects with file, line, column, severity, and message. Use this after stm32.build fails to understand what to fix.',
		inputSchema: {
			type: 'object',
			required: ['buildOutput'],
			properties: {
				buildOutput: { type: 'string', description: 'Raw stdout+stderr from make / arm-none-eabi-gcc build' },
				topN: { type: ['number', 'null'], description: 'Maximum number of diagnostics to return (default: 30)' }
			}
		}
	},
	{
		name: 'stm32.autoWorkflow',
		description: 'End-to-end automation: given a board/MCU, pin assignments, and a natural-language goal, this tool orchestrates createIocFromPins → regenerateCode → patchUserCode (LLM writes code) → build → parseBuildErrors in sequence. Returns each step result so the LLM can iterate on errors. Call this as the entry point for new project generation.',
		inputSchema: {
			type: 'object',
			required: ['mcuName', 'goal'],
			properties: {
				mcuName: { type: 'string', description: 'MCU name (e.g. STM32F446RETx)' },
				projectName: { type: ['string', 'null'], description: 'Project name (default: project)' },
				pins: {
					type: ['array', 'null'],
					description: 'Pin assignments',
					items: {
						type: 'object',
						required: ['pin', 'mode'],
						properties: {
							pin: { type: 'string' },
							mode: { type: 'string' }
						}
					}
				},
				userCodePatches: {
					type: ['array', 'null'],
					description: 'USER CODE section patches to apply to main.c after code generation (LLM-generated application logic)',
					items: {
						type: 'object',
						required: ['sectionName', 'content'],
						properties: {
							sectionName: { type: 'string' },
							content: { type: 'string' }
						}
					}
				},
				goal: { type: 'string', description: 'Natural language description of what the firmware should do (for reference in the response)' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' },
				skipRegenerate: { type: ['boolean', 'null'], description: 'Skip CubeMX code generation step (use if CubeMX is not installed)' },
				cubemxPath: { type: ['string', 'null'], description: 'Path to STM32CubeMX executable (optional)' },
				makePath: { type: ['string', 'null'], description: 'Path to make executable (optional)' }
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

	// Priority: 1. params.makePath, 2. settings, 3. env var, 4. auto-detect
	const settingsMake = getConfigValue('makePath', ['STM32_MAKE_PATH', 'MAKE_PATH'], wsRoot);
	const requestedMake = params.makePath || settingsMake;
	const makeResolution = resolveMakeCommand(requestedMake);
	const makeCmd = makeResolution.makeCmd;
	const gccResolution = resolveArmGccCommand(wsRoot);
	const gccCmd = gccResolution.gccCmd;

	const debugDir = path.join(wsRoot, 'Debug');
	const buildDir = findBuildDirectoryWithMakefile(wsRoot);
	const makeLooksLikePath = typeof makeCmd === 'string' && (path.isAbsolute(makeCmd) || makeCmd.includes('\\') || makeCmd.includes('/'));
	const makeDir = makeLooksLikePath ? path.dirname(makeCmd) : null;
	const gccDir = gccCmd ? path.dirname(gccCmd) : null;
	let childEnv = { ...process.env };
	childEnv = prependPathVariable(childEnv, makeDir);
	childEnv = prependPathVariable(childEnv, gccDir);

	if (!isExistingDirectory(wsRoot)) {
		return {
			success: false,
			exitCode: 1,
			makePath: makeCmd,
			debugDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: '',
			stderr: `workspacePath not found or not a directory: ${wsRoot}`
		};
	}

	if (!buildDir) {
		return {
			success: false,
			exitCode: 1,
			makePath: makeCmd,
			debugDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: '',
			stderr: `No Makefile-based build directory found under workspacePath: ${wsRoot}. Run code generation first (stm32.regenerateCode) or specify a workspacePath containing generated Makefiles.`
		};
	}

	if (makeLooksLikePath && !isExistingFile(makeCmd)) {
		return {
			success: false,
			exitCode: 'ENOENT',
			makePath: makeCmd,
			debugDir,
			buildDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: '',
			stderr: `make path does not exist or is not a file: ${makeCmd}`
		};
	}

	if (makeLooksLikePath) {
		try {
			await execFileAsync(makeCmd, ['--version'], { cwd: wsRoot, timeout: 10000, env: childEnv });
		} catch (versionErr) {
			if (versionErr && versionErr.code === 'ENOENT' && isExistingFile(makeCmd)) {
				return {
					success: false,
					exitCode: 'ENOENT',
					makePath: makeCmd,
					debugDir,
					buildDir,
					resolutionTried: makeResolution.tried,
					gccPath: gccCmd,
					gccResolutionTried: gccResolution.tried,
					stdout: versionErr.stdout ?? '',
					stderr: `make executable exists but cannot be launched: ${makeCmd}. Possible missing runtime DLL/dependency or execution restriction.`
				};
			}
		}
	}

	try {
		const { stdout, stderr } = await execFileAsync(makeCmd, [`-j${jobs}`, 'all'], {
			cwd: buildDir,
			env: childEnv,
			timeout: 120000
		});
		return {
			success: true,
			exitCode: 0,
			makePath: makeCmd,
			debugDir,
			buildDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout,
			stderr
		};
	} catch (err) {
		const detail = err.code === 'ENOENT'
			? `make launch failed: ${makeCmd}. cwd=${buildDir}. Tried=${makeResolution.tried.join(' | ')}.`
			: (typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : (err.message ?? 'build failed'));
		return {
			success: false,
			exitCode: err.code ?? 1,
			makePath: makeCmd,
			debugDir,
			buildDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: err.stdout ?? '',
			stderr: detail
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
	const wsRoot = params.workspacePath ?? WORKSPACE;
	const cubemxResolution = resolveCubeMxCommand(params.cubemxPath, wsRoot);
	const cubemxPath = cubemxResolution.cubemxCmd;

	let iocPath = params.iocPath;

	if (!iocPath) {
		const entries = fs.readdirSync(wsRoot);
		const iocFile = entries.find(e => e.toLowerCase().endsWith('.ioc'));
		if (iocFile) iocPath = path.join(wsRoot, iocFile);
	}

	if (!iocPath) {
		return { success: false, error: '.ioc file not found' };
	}

	const normalizedWsRoot = wsRoot.replace(/\\/g, '/');
	const scriptContent = `config load "${iocPath}"\ngenerate code "${normalizedWsRoot}"\nexit\n`;
	const scriptPath = path.join(require('os').tmpdir(), `cubemx-script-${Date.now()}.txt`);
	fs.writeFileSync(scriptPath, scriptContent, 'utf8');

	try {
		const { stdout, stderr } = await execFileAsync(cubemxPath, ['-s', scriptPath], { cwd: wsRoot, timeout: 120000 });
		return { success: true, iocPath, cubemxPath, resolutionTried: cubemxResolution.tried, stdout, stderr };
	} catch (err) {
		const detail = err.code === 'ENOENT'
			? `STM32CubeMX executable not found: ${cubemxPath}. Tried=${cubemxResolution.tried.join(' | ')}. Set stm32.cubemxPath to the executable file or install STM32CubeMX.`
			: ((typeof err.stderr === 'string' && err.stderr.length > 0) ? err.stderr : (err.message ?? 'regenerate failed'));
		return { success: false, iocPath, cubemxPath, resolutionTried: cubemxResolution.tried, exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: detail };
	} finally {
		fs.unlink(scriptPath, () => { });
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
	if (cfsr & 0x0002) issues.push({ type: 'UsageFault', bit: 'INVSTATE', desc: '不正なEPSR状態。Thumbビット未設定でジャンプした可能性があります。' });
	if (cfsr & 0x0004) issues.push({ type: 'UsageFault', bit: 'INVPC', desc: '不正なPC値によるEXC_RETURNエラーです。' });
	if (cfsr & 0x0008) issues.push({ type: 'UsageFault', bit: 'NOCP', desc: 'コプロセッサ(FPU等)が無効なのに使用されました。' });
	if (cfsr & 0x0100) issues.push({ type: 'UsageFault', bit: 'UNALIGNED', desc: '非アラインアクセス。SCB->CCR の UNALIGN_TRP が設定されています。' });
	if (cfsr & 0x0200) issues.push({ type: 'UsageFault', bit: 'DIVBYZERO', desc: 'ゼロ除算が発生しました。SCB->CCR の DIV_0_TRP が設定されています。' });

	// BFSR bits 15:8 of CFSR
	if (cfsr & 0x0100_0000 >> 16) { }  // alias correction — use direct bit test
	const bfsr = (cfsr >> 8) & 0xFF;
	if (bfsr & 0x01) issues.push({ type: 'BusFault', bit: 'IBUSERR', desc: '命令フェッチBusエラー。PCが不正なFlash/RAM番地を指しています。' });
	if (bfsr & 0x02) issues.push({ type: 'BusFault', bit: 'PRECISERR', desc: `正確なデータBusエラー。アドレス: ${bfar ?? '不明'}`, address: bfar });
	if (bfsr & 0x04) issues.push({ type: 'BusFault', bit: 'IMPRECISERR', desc: 'バッファリングによる不正確なBusエラー。DMAや非同期アクセスを確認してください。' });
	if (bfsr & 0x08) issues.push({ type: 'BusFault', bit: 'UNSTKERR', desc: 'スタック復元中にBusエラー。スタックオーバーフローの可能性があります。' });
	if (bfsr & 0x10) issues.push({ type: 'BusFault', bit: 'STKERR', desc: 'スタック保存中にBusエラー。スタックポインタが不正です。' });

	// MMFSR bits 7:0 of CFSR
	const mmfsr = cfsr & 0xFF;
	if (mmfsr & 0x01) issues.push({ type: 'MemManage', bit: 'IACCVIOL', desc: '命令フェッチでMPU違反。MPUの設定を確認してください。' });
	if (mmfsr & 0x02) issues.push({ type: 'MemManage', bit: 'DACCVIOL', desc: `データアクセスでMPU違反。アドレス: ${mmfar ?? '不明'}`, address: mmfar });
	if (mmfsr & 0x08) issues.push({ type: 'MemManage', bit: 'MUNSTKERR', desc: 'スタック復元中にMPU違反。' });
	if (mmfsr & 0x10) issues.push({ type: 'MemManage', bit: 'MSTKERR', desc: 'スタック保存中にMPU違反。' });

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
		recs.push(`BFARアドレス(${issues.find(i => i.bit === 'PRECISERR')?.address ?? '不明'})を確認してください。NULLポインタや範囲外アクセスの可能性があります。`);
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
		} catch (_) { }
	}
	return null;
}

function findExecutable(name) {
	const isWin = process.platform === 'win32';
	if (path.isAbsolute(name)) {
		return name;
	}
	const ext = isWin ? '.exe' : '';

	if (name === 'STM32CubeMX') {
		const envPath = sanitizePathValue(process.env.STM32_CUBEMX_PATH || process.env.STM32CUBEMX_PATH);
		if (envPath && fs.existsSync(envPath)) {
			const stat = fs.statSync(envPath);
			if (stat.isFile()) {
				return envPath;
			}
			const nestedExe = path.join(envPath, 'STM32CubeMX.exe');
			if (fs.existsSync(nestedExe)) {
				return nestedExe;
			}
		}
		if (isWin) {
			const localAppData = process.env.LOCALAPPDATA;
			const candidates = [
				localAppData ? `${localAppData.replace(/\\/g, '/')}/Programs/STM32CubeMX/STM32CubeMX.exe` : null,
				'C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/STM32CubeMX.exe',
				'C:/ST/STM32CubeMX/STM32CubeMX.exe',
				'C:/Users/s-rin/AppData/Local/Programs/STM32CubeMX/STM32CubeMX.exe'
			];
			for (const candidate of candidates) {
				if (candidate && fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}
	}

	return name + ext;
}

function sanitizePathValue(value) {
	if (typeof value !== 'string') {
		return '';
	}
	let result = value.trim();
	if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
		result = result.slice(1, -1).trim();
	}
	if (process.platform === 'win32') {
		result = result.replace(/^~(?=\\|\/|$)/, process.env.USERPROFILE ?? '~');
		result = result.replace(/%([^%]+)%/g, (_, varName) => process.env[varName] ?? `%${varName}%`);
	}
	return result;
}

function resolveBinaryCandidate(pathValue, binaryNames) {
	const candidate = sanitizePathValue(pathValue);
	if (!candidate) {
		return null;
	}
	if (fs.existsSync(candidate)) {
		const stat = fs.statSync(candidate);
		if (stat.isFile()) {
			return candidate;
		}
		if (stat.isDirectory()) {
			for (const bin of binaryNames) {
				const nested = path.join(candidate, bin);
				if (fs.existsSync(nested) && fs.statSync(nested).isFile()) {
					return nested;
				}
			}
		}
	}
	if (process.platform === 'win32' && !candidate.toLowerCase().endsWith('.exe')) {
		const exeCandidate = `${candidate}.exe`;
		if (fs.existsSync(exeCandidate) && fs.statSync(exeCandidate).isFile()) {
			return exeCandidate;
		}
	}
	return null;
}

/** Load settings from .vscode/settings.json */
function loadVscodeSettings(workspacePath) {
	try {
		const settingsPath = path.join(workspacePath ?? WORKSPACE, '.vscode', 'settings.json');
		if (!fs.existsSync(settingsPath)) {
			return {};
		}
		const content = fs.readFileSync(settingsPath, 'utf8');
		return JSON.parse(content);
	} catch {
		return {};
	}
}

/** Get a configuration value with environment variable fallback */
function getConfigValue(configKey, envVarNames, workspacePath) {
	for (const envVarName of envVarNames ?? []) {
		const envValue = sanitizePathValue(process.env[envVarName]);
		if (envValue) {
			return envValue;
		}
	}

	const primarySettings = loadVscodeSettings(workspacePath);
	const primaryValue = sanitizePathValue(primarySettings[`stm32.${configKey}`]);
	if (primaryValue) {
		return primaryValue;
	}

	if (workspacePath && path.resolve(workspacePath) !== path.resolve(WORKSPACE)) {
		const fallbackSettings = loadVscodeSettings(WORKSPACE);
		const fallbackValue = sanitizePathValue(fallbackSettings[`stm32.${configKey}`]);
		if (fallbackValue) {
			return fallbackValue;
		}
	}

	return null;
}

function findMakeExecutable(configuredPath) {
	const explicit = resolveBinaryCandidate(configuredPath, ['make.exe', 'make']);
	if (explicit) {
		return explicit;
	}

	// 2. Check environment variable
	const envPath = process.env.STM32_MAKE_PATH || process.env.MAKE_PATH;
	const envMake = resolveBinaryCandidate(envPath, ['make.exe', 'make']);
	if (envMake) {
		return envMake;
	}

	if (process.platform !== 'win32') {
		return 'make';
	}

	const roots = [
		sanitizePathValue(process.env.STM32_CUBECLT_PATH || ''),
		'C:/ST/STM32CubeCLT',
		'C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeCLT',
		'E:/installs/cubeCLT',
	].filter(Boolean);

	for (const root of roots) {
		if (!fs.existsSync(root)) {
			continue;
		}
		try {
			const directMake = path.join(root, 'GNU-tools-for-STM32', 'bin', 'make.exe');
			if (fs.existsSync(directMake)) {
				return directMake;
			}

			const entries = fs.readdirSync(root, { withFileTypes: true })
				.filter(entry => entry.isDirectory())
				.map(entry => path.join(root, entry.name, 'GNU-tools-for-STM32', 'bin', 'make.exe'));
			for (const candidate of entries) {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		} catch {
			// ignore and continue
		}
	}

	return 'make.exe';
}

function resolveMakeCommand(configuredPath) {
	const tried = [];

	const explicit = resolveBinaryCandidate(configuredPath, ['make.exe', 'make', 'mingw32-make.exe']);
	if (configuredPath) {
		tried.push(`configured:${sanitizePathValue(configuredPath)}`);
	}
	if (explicit) {
		return { makeCmd: explicit, tried };
	}

	const envMake = resolveBinaryCandidate(process.env.STM32_MAKE_PATH || process.env.MAKE_PATH, ['make.exe', 'make', 'mingw32-make.exe']);
	if (process.env.STM32_MAKE_PATH) {
		tried.push(`env:STM32_MAKE_PATH=${sanitizePathValue(process.env.STM32_MAKE_PATH)}`);
	}
	if (process.env.MAKE_PATH) {
		tried.push(`env:MAKE_PATH=${sanitizePathValue(process.env.MAKE_PATH)}`);
	}
	if (envMake) {
		return { makeCmd: envMake, tried };
	}

	for (const cmdName of ['make.exe', 'make', 'mingw32-make.exe']) {
		tried.push(`path:${cmdName}`);
		try {
			const which = process.platform === 'win32'
				? spawnSync('where', [cmdName], { encoding: 'utf8' })
				: spawnSync('which', [cmdName], { encoding: 'utf8' });
			if (which.status === 0 && typeof which.stdout === 'string') {
				const first = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
				if (first && fs.existsSync(first)) {
					return { makeCmd: first, tried };
				}
			}
		} catch {
			// ignore and continue
		}
	}

	const gitMakeCandidates = [
		'C:/Program Files/Git/usr/bin/make.exe',
		'C:/Program Files (x86)/Git/usr/bin/make.exe'
	];
	for (const candidate of gitMakeCandidates) {
		tried.push(`git:${candidate}`);
		if (fs.existsSync(candidate)) {
			return { makeCmd: candidate, tried };
		}
	}

	const cubeIdeRoots = [
		'C:/ST/STM32CubeIDE',
		'C:/Program Files/STMicroelectronics/STM32CubeIDE'
	];
	for (const root of cubeIdeRoots) {
		if (!fs.existsSync(root)) {
			continue;
		}
		try {
			const entries = fs.readdirSync(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const pluginsDir = path.join(root, entry.name, 'plugins');
				if (!fs.existsSync(pluginsDir)) {
					continue;
				}
				const pluginEntries = fs.readdirSync(pluginsDir, { withFileTypes: true });
				for (const plugin of pluginEntries) {
					if (!plugin.isDirectory() && !plugin.isFile()) {
						continue;
					}
					if (!plugin.name.startsWith('com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.win32_')) {
						continue;
					}
					const candidate = path.join(pluginsDir, plugin.name, 'tools', 'bin', 'make.exe');
					tried.push(`cubeide:${candidate}`);
					if (fs.existsSync(candidate)) {
						return { makeCmd: candidate, tried };
					}
				}
			}
		} catch {
			// ignore and continue
		}
	}

	const autoDetected = findMakeExecutable();
	tried.push(`auto:${autoDetected}`);
	return { makeCmd: autoDetected, tried };
}

function resolveArmGccCommand(workspacePath) {
	const tried = [];

	const configured = getConfigValue('armGccPath', ['STM32_ARM_GCC_PATH', 'ARM_GCC_PATH'], workspacePath);
	const explicit = resolveBinaryCandidate(configured, ['arm-none-eabi-gcc.exe', 'arm-none-eabi-gcc']);
	if (configured) {
		tried.push(`configured:${configured}`);
	}
	if (explicit) {
		return { gccCmd: explicit, tried };
	}

	for (const cmdName of ['arm-none-eabi-gcc.exe', 'arm-none-eabi-gcc']) {
		tried.push(`path:${cmdName}`);
		try {
			const which = process.platform === 'win32'
				? spawnSync('where', [cmdName], { encoding: 'utf8' })
				: spawnSync('which', [cmdName], { encoding: 'utf8' });
			if (which.status === 0 && typeof which.stdout === 'string') {
				const first = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
				if (first && fs.existsSync(first)) {
					return { gccCmd: first, tried };
				}
			}
		} catch {
			// ignore and continue
		}
	}

	const defaultCandidates = [
		'C:/Program Files (x86)/GNU Arm Embedded Toolchain/10 2021.10/bin/arm-none-eabi-gcc.exe',
		'C:/Program Files (x86)/GNU Arm Embedded Toolchain/9 2020-q2-update/bin/arm-none-eabi-gcc.exe',
		'C:/ST/STM32CubeCLT/GNU-tools-for-STM32/bin/arm-none-eabi-gcc.exe'
	];
	for (const candidate of defaultCandidates) {
		tried.push(`candidate:${candidate}`);
		if (fs.existsSync(candidate)) {
			return { gccCmd: candidate, tried };
		}
	}

	return { gccCmd: null, tried };
}

function resolveCubeMxCommand(configuredPath, workspacePath) {
	const tried = [];

	const explicit = resolveBinaryCandidate(configuredPath, ['STM32CubeMX.exe', 'STM32CubeMX']);
	if (configuredPath) {
		tried.push(`configured:${sanitizePathValue(configuredPath)}`);
	}
	if (explicit) {
		return { cubemxCmd: explicit, tried };
	}

	const configuredFromSettings = getConfigValue('cubemxPath', ['STM32_CUBEMX_PATH', 'STM32CUBEMX_PATH'], workspacePath);
	if (configuredFromSettings) {
		tried.push(`settings/env:${configuredFromSettings}`);
		const fromSettings = resolveBinaryCandidate(configuredFromSettings, ['STM32CubeMX.exe', 'STM32CubeMX']);
		if (fromSettings) {
			return { cubemxCmd: fromSettings, tried };
		}
	}

	const autoDetected = findExecutable('STM32CubeMX');
	tried.push(`auto:${autoDetected}`);
	return { cubemxCmd: autoDetected, tried };
}

function prependPathVariable(baseEnv, dirPath) {
	if (!dirPath) {
		return baseEnv;
	}
	const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
	const altPathKey = process.platform === 'win32' ? 'PATH' : 'Path';
	const delim = process.platform === 'win32' ? ';' : ':';
	const original = baseEnv[pathKey] ?? baseEnv[altPathKey] ?? '';
	const parts = original.split(delim).map(p => p.trim()).filter(Boolean);
	const normalized = process.platform === 'win32' ? dirPath.toLowerCase() : dirPath;
	const already = parts.some(p => (process.platform === 'win32' ? p.toLowerCase() : p) === normalized);
	const merged = already ? original : `${dirPath}${delim}${original}`;
	return {
		...baseEnv,
		[pathKey]: merged,
		[altPathKey]: merged,
	};
}

function isExistingFile(filePath) {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isExistingDirectory(dirPath) {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function findBuildDirectoryWithMakefile(wsRoot) {
	const directCandidates = [
		path.join(wsRoot, 'Debug'),
		path.join(wsRoot, 'Release'),
		path.join(wsRoot, 'Build'),
		wsRoot,
	];

	for (const dir of directCandidates) {
		if (isExistingDirectory(dir) && isExistingFile(path.join(dir, 'Makefile'))) {
			return dir;
		}
	}

	try {
		const level1 = fs.readdirSync(wsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
		for (const entry of level1) {
			const dir = path.join(wsRoot, entry.name);
			if (isExistingFile(path.join(dir, 'Makefile'))) {
				return dir;
			}
			try {
				const level2 = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
				for (const entry2 of level2) {
					const dir2 = path.join(dir, entry2.name);
					if (isExistingFile(path.join(dir2, 'Makefile'))) {
						return dir2;
					}
				}
			} catch {
				// ignore nested scan errors
			}
		}
	} catch {
		// ignore scan errors
	}

	return null;
}

// ─── New Tool Implementations ─────────────────────────────────────────────────

function resolveWorkspacePath(params) {
	return params.workspacePath
		? path.resolve(params.workspacePath)
		: WORKSPACE;
}

function safeResolvePath(wsBase, relPath) {
	const normalizedBase = path.resolve(wsBase);
	const resolved = path.resolve(normalizedBase, relPath);

	const baseCmp = process.platform === 'win32' ? normalizedBase.toLowerCase() : normalizedBase;
	const resolvedCmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	const basePrefix = `${baseCmp}${path.sep}`;

	if (!resolvedCmp.startsWith(basePrefix) && resolvedCmp !== baseCmp) {
		throw Object.assign(new Error(`Access denied: path escapes workspace root`), { code: -32600 });
	}
	return resolved;
}

function collectFilesSync(dir, extensions, found = []) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return found; }
	for (const e of entries) {
		if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'Middlewares' || e.name === 'Drivers') continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			collectFilesSync(full, extensions, found);
		} else if (extensions.some(ext => ext === 'Makefile' ? e.name === 'Makefile' : e.name.endsWith(ext))) {
			found.push(full);
		}
	}
	return found;
}

function toolListWorkspaceFiles(params) {
	const base = resolveWorkspacePath(params);
	const exts = params.extensions ?? ['.c', '.h', '.ioc', '.s', 'Makefile'];
	const files = collectFilesSync(base, exts);
	const relative = files.map(f => path.relative(base, f).replace(/\\/g, '/'));
	return { workspacePath: base, count: relative.length, files: relative };
}

function toolReadFile(params) {
	if (!params.filePath) throw Object.assign(new Error('filePath required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const full = safeResolvePath(base, params.filePath);
	if (!fs.existsSync(full)) throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: -32602 });
	const content = fs.readFileSync(full, 'utf8');
	return { filePath: params.filePath, size: content.length, content };
}

function normalizeMcuNameForCubeMx(rawMcuName) {
	if (typeof rawMcuName !== 'string') {
		return '';
	}
	let normalized = rawMcuName.trim().replace(/\.json$/i, '').replace(/\s+/g, '');
	if (!/^STM32/i.test(normalized)) {
		return normalized;
	}
	// CubeMX wildcard suffix style uses lower-case x (e.g. Tx, Rx)
	normalized = normalized.replace(/X$/i, 'x');
	return normalized;
}

function inferMcuFamilyFromName(mcuName) {
	const upper = (mcuName || '').toUpperCase();
	const m = upper.match(/^STM32([A-Z][0-9])/);
	return m ? `STM32${m[1]}` : 'STM32F4';
}

function cubeMxFileNameMatchesMcu(fileStem, mcuName) {
	const pattern = fileStem.replace(/\(([A-Z0-9](?:-[A-Z0-9])+?)\)/gi, (_, chars) => `[${chars.replace(/-/g, '')}]`);
	try {
		return new RegExp(`^${pattern}$`, 'i').test(mcuName);
	} catch {
		return false;
	}
}

function listCubeMxMcuDbCandidates(workspacePath) {
	const configuredDb = getConfigValue('cubemxDbPath', ['STM32_CUBEMX_DB_PATH'], workspacePath);
	const configuredCubeMx = getConfigValue('cubemxPath', ['STM32_CUBEMX_PATH', 'STM32CUBEMX_PATH'], workspacePath);
	const autoCubeMx = findExecutable('STM32CubeMX');
	const dirs = [];

	const pushDir = (value) => {
		const p = sanitizePathValue(value);
		if (!p) {
			return;
		}
		if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
			dirs.push(path.join(p, 'db', 'mcu'));
			dirs.push(path.join(p, 'mcu'));
		}
		if (fs.existsSync(p) && fs.statSync(p).isFile()) {
			const root = path.dirname(p);
			dirs.push(path.join(root, 'db', 'mcu'));
			dirs.push(path.join(root, 'mcu'));
		}
	};

	if (configuredDb) {
		dirs.push(sanitizePathValue(configuredDb));
	}
	pushDir(configuredCubeMx);
	pushDir(autoCubeMx);

	const unique = [];
	const seen = new Set();
	for (const d of dirs) {
		const key = path.resolve(d).toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(d);
		}
	}
	return unique;
}

function resolveCanonicalMcuName(rawMcuName, workspacePath) {
	const normalized = normalizeMcuNameForCubeMx(rawMcuName);
	if (!normalized || !/^STM32/i.test(normalized)) {
		return { canonical: normalized, source: 'input' };
	}

	const variants = [
		normalized,
		normalized.replace(/X$/i, 'x'),
		normalized.replace(/X$/i, 'x').replace(/([A-Z]{2})$/i, '$1Tx'),
		normalized.replace(/([A-Z]{2})$/i, '$1Tx')
	].filter(Boolean);

	for (const dbDir of listCubeMxMcuDbCandidates(workspacePath)) {
		if (!isExistingDirectory(dbDir)) {
			continue;
		}
		let entries = [];
		try {
			entries = fs.readdirSync(dbDir, { withFileTypes: true });
		} catch {
			continue;
		}
		const stems = entries
			.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.xml'))
			.map(e => e.name.slice(0, -4));

		for (const candidate of variants) {
			if (stems.some(stem => stem.toUpperCase() === candidate.toUpperCase())) {
				return { canonical: candidate, source: `db:${dbDir}` };
			}
			if (stems.some(stem => cubeMxFileNameMatchesMcu(stem, candidate))) {
				return { canonical: candidate, source: `db-pattern:${dbDir}` };
			}
		}
	}

	return { canonical: normalized, source: 'input-fallback' };
}

function toolWriteFile(params) {
	if (!params.filePath) throw Object.assign(new Error('filePath required'), { code: -32602 });
	if (params.content === undefined) throw Object.assign(new Error('content required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const full = safeResolvePath(base, params.filePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, params.content, 'utf8');
	return { filePath: params.filePath, bytesWritten: Buffer.byteLength(params.content, 'utf8'), success: true };
}

function toolPatchUserCode(params) {
	if (!params.filePath) throw Object.assign(new Error('filePath required'), { code: -32602 });
	if (!Array.isArray(params.patches) || params.patches.length === 0) throw Object.assign(new Error('patches array required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const full = safeResolvePath(base, params.filePath);
	if (!fs.existsSync(full)) throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: -32602 });
	let content = fs.readFileSync(full, 'utf8');
	const results = [];
	for (const patch of params.patches) {
		const { sectionName, content: newCode } = patch;
		if (!sectionName) { results.push({ sectionName: '?', success: false, error: 'sectionName missing' }); continue; }
		const begin = `/* USER CODE BEGIN ${sectionName} */`;
		const end = `/* USER CODE END ${sectionName} */`;
		const idx1 = content.indexOf(begin);
		const idx2 = content.indexOf(end, idx1 + begin.length);
		if (idx1 === -1 || idx2 === -1) {
			results.push({ sectionName, success: false, error: `Section markers not found in file` });
			continue;
		}
		const prefix = content.slice(0, idx1 + begin.length);
		const suffix = content.slice(idx2);
		const nl = newCode.startsWith('\n') ? '' : '\n';
		const nl2 = newCode.endsWith('\n') ? '' : '\n';
		content = prefix + nl + newCode + nl2 + suffix;
		results.push({ sectionName, success: true });
	}
	fs.writeFileSync(full, content, 'utf8');
	return { filePath: params.filePath, patches: results };
}

function toolCreateIocFromPins(params) {
	if (!params.mcuName) throw Object.assign(new Error('mcuName required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const canonical = resolveCanonicalMcuName(params.mcuName, base);
	const mcuName = canonical.canonical;
	if (!mcuName || !/^STM32/i.test(mcuName)) {
		throw Object.assign(new Error(`Invalid mcuName for CubeMX: ${params.mcuName}`), { code: -32602 });
	}
	const projectName = params.projectName ?? 'project';
	const pins = params.pins ?? [];
	const mcuFamily = inferMcuFamilyFromName(mcuName);

	const pinLines = pins.map(p => `${p.pin}.Signal=${p.mode}`).join('\n');
	const pinGpioLines = pins
		.filter(p => p.mode === 'GPIO_Output' || p.mode === 'GPIO_Input')
		.map(p => `${p.pin}.GPIO_Label=`)
		.join('\n');

	const iocContent = [
		`#MicroXplorer Configuration settings - do not modify`,
		`File.Version=6`,
		`LibraryCopySrc=1`,
		`Mcu.CPN=${mcuName}`,
		`Mcu.Family=${mcuFamily}`,
		`Mcu.Name=${mcuName}`,
		...pins.map((p, i) => `Mcu.Pin${i}=${p.pin}`),
		`Mcu.PinsNb=${pins.length}`,
		`Mcu.UserName=${mcuName}`,
		`MxCube.Version=6.10.0`,
		`MxDb.Version=DB.6.0.110`,
		pinLines,
		pinGpioLines,
		`ProjectManager.ProjectBaudRate=115200`,
		`ProjectManager.ProjectFileName=${projectName}.ioc`,
		`ProjectManager.ProjectName=${projectName}`,
		`ProjectManager.ToolChain=Makefile`,
		`ProjectManager.LibraryCopySrc=1`,
		``
	].filter(l => l !== undefined).join('\n');

	const iocPath = path.join(base, `${projectName}.ioc`);
	fs.writeFileSync(iocPath, iocContent, 'utf8');
	return {
		iocPath: path.relative(base, iocPath).replace(/\\/g, '/'),
		mcuName,
		mcuSource: canonical.source,
		projectName,
		pinCount: pins.length,
		success: true
	};
}

function toolParseBuildErrors(params) {
	if (typeof params.buildOutput !== 'string') {
		throw Object.assign(new Error('buildOutput required'), { code: -32602 });
	}
	const topN = params.topN ?? 30;
	const diagnostics = [];
	const seen = new Set();
	const pushDiag = (diag) => {
		const key = `${diag.file}|${diag.line}|${diag.column}|${diag.severity}|${diag.message}`;
		if (seen.has(key) || diagnostics.length >= topN) {
			return;
		}
		seen.add(key);
		diagnostics.push(diag);
	};
	// GCC error/warning format: file:line:col: severity: message
	const re = /^([^:\n]+):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/gm;
	let m;
	while ((m = re.exec(params.buildOutput)) !== null && diagnostics.length < topN) {
		pushDiag({
			file: m[1].trim(),
			line: parseInt(m[2], 10),
			column: parseInt(m[3], 10),
			severity: m[4],
			message: m[5].trim()
		});
	}
	// Also catch linker errors: e.g. undefined reference
	const linkerRe = /^(.*): undefined reference to `(.+)'$/gm;
	while ((m = linkerRe.exec(params.buildOutput)) !== null && diagnostics.length < topN) {
		pushDiag({ file: m[1].trim(), line: 0, column: 0, severity: 'error', message: `Undefined reference to: ${m[2]}` });
	}

	const makeErrorRe = /^make:\s*\*\*\*\s*(.+)$/gmi;
	while ((m = makeErrorRe.exec(params.buildOutput)) !== null && diagnostics.length < topN) {
		pushDiag({ file: 'make', line: 0, column: 0, severity: 'error', message: m[1].trim() });
	}

	const lines = params.buildOutput.split(/\r?\n/);
	for (const line of lines) {
		if (diagnostics.length >= topN) {
			break;
		}
		const text = line.trim();
		if (!text) {
			continue;
		}
		const lowered = text.toLowerCase();
		if (lowered.includes('arm-none-eabi-gcc') && (
			lowered.includes('not recognized') ||
			lowered.includes('not found') ||
			text.includes('認識されていません') ||
			text.includes('見つかりません')
		)) {
			pushDiag({ file: 'toolchain', line: 0, column: 0, severity: 'error', message: text });
			continue;
		}
		if (lowered.includes('error') || text.includes('エラー') || text.includes('失敗')) {
			pushDiag({ file: 'build', line: 0, column: 0, severity: 'error', message: text });
		}
	}
	const errors = diagnostics.filter(d => d.severity === 'error').length;
	const warnings = diagnostics.filter(d => d.severity === 'warning').length;
	return { errors, warnings, total: diagnostics.length, diagnostics };
}

async function toolAutoWorkflow(params) {
	const base = resolveWorkspacePath(params);
	const steps = [];

	// 1. createIocFromPins
	let iocResult;
	try {
		iocResult = toolCreateIocFromPins({ ...params, workspacePath: base });
		steps.push({ step: 'createIoc', success: true, result: iocResult });
	} catch (e) {
		steps.push({ step: 'createIoc', success: false, error: e.message });
		return { success: false, goal: params.goal, steps };
	}

	// 2. regenerateCode (optional, skip if skipRegenerate)
	if (!params.skipRegenerate) {
		let regenResult;
		try {
			regenResult = await toolRegenerateCode({
				workspacePath: base,
				cubemxPath: params.cubemxPath ?? null,
			});
			steps.push({ step: 'regenerateCode', success: true, result: regenResult });
		} catch (e) {
			steps.push({ step: 'regenerateCode', success: false, error: e.message, note: 'Continue with patchUserCode anyway' });
		}
	} else {
		steps.push({ step: 'regenerateCode', success: true, skipped: true });
	}

	// 3. patchUserCode
	if (Array.isArray(params.userCodePatches) && params.userCodePatches.length > 0) {
		const projectName = params.projectName ?? 'project';
		const mainC = `Core/Src/main.c`;
		try {
			const patchResult = toolPatchUserCode({ filePath: mainC, patches: params.userCodePatches, workspacePath: base });
			steps.push({ step: 'patchUserCode', success: true, result: patchResult });
		} catch (e) {
			steps.push({ step: 'patchUserCode', success: false, error: e.message });
		}
	} else {
		steps.push({ step: 'patchUserCode', success: true, skipped: true, note: 'No userCodePatches provided' });
	}

	// 4. build
	let buildResult;
	try {
		buildResult = await toolBuild({
			workspacePath: base,
			makePath: params.makePath ?? null,
		});
		steps.push({
			step: 'build',
			success: true,
			result: {
				exitCode: buildResult.exitCode,
				makePath: buildResult.makePath,
				stdout: buildResult.stdout?.slice(-2000),
				stderr: buildResult.stderr?.slice(-1000),
			}
		});
	} catch (e) {
		steps.push({ step: 'build', success: false, error: e.message });
		return { success: false, goal: params.goal, steps };
	}

	// 5. parseBuildErrors if build failed
	if (buildResult.exitCode !== 0) {
		const errResult = toolParseBuildErrors({ buildOutput: (buildResult.stdout ?? '') + (buildResult.stderr ?? '') });
		steps.push({ step: 'parseBuildErrors', success: true, result: errResult });
		return { success: false, goal: params.goal, steps, buildFailed: true, buildErrors: errResult };
	}

	return { success: true, goal: params.goal, steps, message: 'Build succeeded! Firmware ready in Debug/' };
}

// ─── JSON-RPC Dispatch ────────────────────────────────────────────────────────

async function dispatch(method, params) {
	params = params ?? {};
	switch (method) {
		case 'initialize':
			return {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'cubeforge-stm32-mcp', version: '1.0.0' }
			};
		case 'notifications/initialized':
			return null;
		case 'ping':
			return { ok: true };
		case 'tools/list':
			return { tools: TOOLS };
		case 'tools/call': {
			const name = params?.name;
			if (!name || typeof name !== 'string') {
				throw Object.assign(new Error('tools/call requires params.name'), { code: -32602 });
			}
			const toolArgs = (params && typeof params.arguments === 'object' && params.arguments !== null) ? params.arguments : {};
			const result = await dispatch(name, toolArgs);
			return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
		}
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
		case 'stm32.listWorkspaceFiles':
			return toolListWorkspaceFiles(params);
		case 'stm32.readFile':
			return toolReadFile(params);
		case 'stm32.writeFile':
			return toolWriteFile(params);
		case 'stm32.patchUserCode':
			return toolPatchUserCode(params);
		case 'stm32.createIocFromPins':
			return toolCreateIocFromPins(params);
		case 'stm32.parseBuildErrors':
			return toolParseBuildErrors(params);
		case 'stm32.autoWorkflow':
			return await toolAutoWorkflow(params);
		default:
			throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
	}
}

async function handleRpcPayload(payload) {
	if (!payload || typeof payload !== 'object') {
		return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
	}

	const id = Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : undefined;
	const method = payload.method;
	const params = payload.params;

	if (typeof method !== 'string' || method.length === 0) {
		return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request: method is required' } };
	}

	// Notifications do not require response
	if (id === undefined && method === 'notifications/initialized') {
		return undefined;
	}

	try {
		const result = await dispatch(method, params);
		return { jsonrpc: '2.0', id: id ?? null, result };
	} catch (err) {
		const code = typeof err?.code === 'number' ? err.code : -32000;
		return { jsonrpc: '2.0', id: id ?? null, error: { code, message: err?.message ?? String(err) } };
	}
}

async function handleRpcInput(payload) {
	if (Array.isArray(payload)) {
		if (payload.length === 0) {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
		}

		const responses = [];
		for (const item of payload) {
			const response = await handleRpcPayload(item);
			if (response !== undefined) {
				responses.push(response);
			}
		}
		return responses.length > 0 ? responses : undefined;
	}

	return handleRpcPayload(payload);
}

function writeStdioMessage(data, mode = 'framed') {
	const json = JSON.stringify(data);
	if (mode === 'line') {
		process.stdout.write(`${json}\n`);
		return;
	}
	const bytes = Buffer.from(json, 'utf8');
	process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
	process.stdout.write(bytes);
}

function findHeaderSeparator(buffer) {
	let sep = buffer.indexOf('\r\n\r\n');
	if (sep >= 0) {
		return { index: sep, length: 4 };
	}

	sep = buffer.indexOf('\n\n');
	if (sep >= 0) {
		return { index: sep, length: 2 };
	}

	return null;
}

function readFramedMessage(buffer) {
	const sep = findHeaderSeparator(buffer);
	if (!sep) {
		return null;
	}

	const headerText = buffer.slice(0, sep.index).toString('utf8');
	if (!/^[A-Za-z-]+\s*:/m.test(headerText)) {
		return { consumed: 0, payload: null, malformedHeader: false, hasFrameHeader: false };
	}

	const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
	if (!lengthMatch) {
		return { consumed: sep.index + sep.length, payload: null, malformedHeader: true, hasFrameHeader: true };
	}

	const contentLength = Number.parseInt(lengthMatch[1], 10);
	if (!Number.isFinite(contentLength) || contentLength < 0) {
		return { consumed: sep.index + sep.length, payload: null, malformedHeader: true };
	}

	const frameStart = sep.index + sep.length;
	const frameEnd = frameStart + contentLength;
	if (buffer.length < frameEnd) {
		return null;
	}

	return {
		consumed: frameEnd,
		payload: buffer.slice(frameStart, frameEnd).toString('utf8'),
		malformedHeader: false,
		hasFrameHeader: true
	};
}

function startsLikeJson(buffer) {
	if (!buffer || buffer.length === 0) {
		return false;
	}
	let i = 0;
	while (i < buffer.length && (buffer[i] === 0x20 || buffer[i] === 0x09 || buffer[i] === 0x0d || buffer[i] === 0x0a)) {
		i += 1;
	}
	if (i >= buffer.length) {
		return false;
	}
	return buffer[i] === 0x7b || buffer[i] === 0x5b;
}

function extractNextJsonChunk(text) {
	const trimmedLeft = text.replace(/^\s+/, '');
	const skipped = text.length - trimmedLeft.length;
	if (trimmedLeft.length === 0) {
		return null;
	}

	const first = trimmedLeft[0];
	const isObjectOrArray = first === '{' || first === '[';
	if (!isObjectOrArray) {
		const newlineIdx = trimmedLeft.indexOf('\n');
		if (newlineIdx < 0) {
			return null;
		}
		const candidate = trimmedLeft.slice(0, newlineIdx).trim();
		if (candidate.length === 0) {
			return { consumed: skipped + newlineIdx + 1, chunk: null };
		}
		return { consumed: skipped + newlineIdx + 1, chunk: candidate };
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < trimmedLeft.length; i += 1) {
		const ch = trimmedLeft[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === '{' || ch === '[') {
			depth += 1;
			continue;
		}

		if (ch === '}' || ch === ']') {
			depth -= 1;
			if (depth === 0) {
				const end = i + 1;
				return {
					consumed: skipped + end,
					chunk: trimmedLeft.slice(0, end)
				};
			}
			continue;
		}
	}

	return null;
}

function startStdioServer() {
	verbose('Starting stdio MCP mode');
	let binaryBuffer = Buffer.alloc(0);
	let textBuffer = '';
	let outputMode = 'framed';

	const handleJsonText = (jsonText) => {
		let payload;
		try {
			payload = JSON.parse(jsonText);
		} catch {
			writeStdioMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, outputMode);
			return;
		}

		void handleRpcInput(payload).then(response => {
			if (response !== undefined) {
				writeStdioMessage(response, outputMode);
			}
		});
	};

	const processTextBuffer = () => {
		while (true) {
			const extracted = extractNextJsonChunk(textBuffer);
			if (!extracted) {
				return;
			}

			textBuffer = textBuffer.slice(extracted.consumed);
			if (extracted.chunk) {
				outputMode = 'line';
				handleJsonText(extracted.chunk);
			}
		}
	};

	const processBinaryBuffer = () => {
		while (binaryBuffer.length > 0) {
			const frame = readFramedMessage(binaryBuffer);
			if (frame) {
				if (!frame.hasFrameHeader) {
					if (!startsLikeJson(binaryBuffer)) {
						return;
					}
				} else {
					if (frame.consumed === 0) {
						return;
					}
					binaryBuffer = binaryBuffer.slice(frame.consumed);
					outputMode = 'framed';
					if (frame.malformedHeader) {
						writeStdioMessage({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid header' } }, outputMode);
						continue;
					}
					if (typeof frame.payload === 'string' && frame.payload.length > 0) {
						handleJsonText(frame.payload);
					}
					continue;
				}
			}

			textBuffer += binaryBuffer.toString('utf8');
			binaryBuffer = Buffer.alloc(0);
			processTextBuffer();
			return;
		}
	};

	process.stdin.on('data', chunk => {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		binaryBuffer = Buffer.concat([binaryBuffer, incoming]);
		processBinaryBuffer();
	});

	process.stdin.on('end', () => {
		if (binaryBuffer.length > 0) {
			textBuffer += binaryBuffer.toString('utf8');
			binaryBuffer = Buffer.alloc(0);
		}

		processTextBuffer();
		const trailing = textBuffer.trim();
		if (trailing.length > 0) {
			outputMode = 'line';
			handleJsonText(trailing);
		}
	});

	process.stdin.resume();
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

		const response = await handleRpcInput(payload);
		if (response === undefined) {
			res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
			res.end();
			return;
		}
		writeJson(res, 200, response);
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
if (STDIO_MODE) {
	startStdioServer();
} else {
	initToken();
	server.listen(PORT, HOST, () => {
		log(`CubeForge MCP Server listening on http://${HOST}:${PORT}/mcp`);
		log(`Workspace: ${WORKSPACE}`);
		log(`Token file: ${TOKEN_FILE}`);
		log(`Tools: ${TOOLS.map(t => t.name).join(', ')}`);
	});
}
