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
const NO_AUTH = args.includes('--no-auth') || process.env.MCP_NO_AUTH === '1';
const ATTACH_EXISTING_ON_PORT_CONFLICT = !args.includes('--no-attach-existing');
const WORKSPACE = path.resolve(getArg(args, '--workspace') ?? process.cwd());
let ACTIVE_WORKSPACE = WORKSPACE;
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_INSTANCE_ID = crypto.randomBytes(6).toString('hex');

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
		name: 'stm32.operationDesk',
		description: 'STM32 MCP Operation Desk: check current workspace, startup info, running state, and optionally switch workspace.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: ['string', 'null'], description: 'status (default) | setWorkspace' },
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (for status target or setWorkspace target)' },
				includeIocList: { type: ['boolean', 'null'], description: 'Include top-level .ioc list (default: true)' }
			}
		}
	},
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
				makePath: { type: ['string', 'null'], description: 'Path to make executable (optional, auto-detected when omitted)' },
				forceRebuild: { type: ['boolean', 'null'], description: 'Force full rebuild and bypass stale object reuse (default: false)' }
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
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' },
				programmerPath: { type: ['string', 'null'], description: 'Path to STM32_Programmer_CLI (optional)' },
				force: { type: ['boolean', 'null'], description: 'Allow flashing even when ELF appears stale (default: false)' }
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
		name: 'stm32.validateEnvironment',
		description: 'Validate end-to-end STM32 toolchain readiness (CubeMX, GCC, make, Programmer CLI, build dir, ioc) and optionally probe ST-LINK.',
		inputSchema: {
			type: 'object',
			properties: {
				workspacePath: { type: ['string', 'null'], description: 'Workspace root path (optional)' },
				probeHardware: { type: ['boolean', 'null'], description: 'Also run ST-LINK probe check (default: true)' }
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
	const wsRoot = resolveWorkspacePath(params);
	if (!isExistingDirectory(wsRoot)) {
		return { found: false, message: `workspacePath not found: ${wsRoot}`, workspacePath: wsRoot };
	}
	const iocPath = selectPreferredIocPath(wsRoot);
	const iocFile = iocPath ? path.basename(iocPath) : null;
	if (!iocFile) {
		return { found: false, message: '.ioc file not found in workspace root' };
	}
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
	const wsRoot = resolveWorkspacePath(params);
	const jobs = params.jobs ?? 8;

	// Priority: 1. params.makePath, 2. settings, 3. env var, 4. auto-detect
	const settingsMake = getConfigValue('makePath', ['STM32_MAKE_PATH', 'MAKE_PATH'], wsRoot);
	const requestedMake = params.makePath || settingsMake;
	const makeResolution = resolveMakeCommand(requestedMake);
	const makeCmd = makeResolution.makeCmd;
	const gccResolution = resolveArmGccCommand(wsRoot);
	const gccCmd = gccResolution.gccCmd;

	// Warn when toolchain is resolved from PATH rather than explicit config
	if (!requestedMake) {
		log(`[WARN] make path not configured — resolved via PATH/auto-detect: ${makeCmd}. Set stm32.makePath or STM32_MAKE_PATH for reproducible builds.`);
	}
	if (!getConfigValue('armGccPath', ['STM32_ARM_GCC_PATH', 'ARM_GCC_PATH'], wsRoot)) {
		if (gccCmd) {
			log(`[WARN] arm-none-eabi-gcc path not configured — resolved via PATH/auto-detect: ${gccCmd}. Set stm32.armGccPath or STM32_ARM_GCC_PATH for reproducible builds.`);
		}
	}

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
			makeResolved: makeCmd,
			debugDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolved: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: '',
			stderr: `workspacePath not found or not a directory: ${wsRoot}`
		};
	}

	if (!buildDir) {
		const fallback = await buildGeneratedProjectWithoutMakefile(wsRoot, gccCmd, childEnv);
		if (fallback.success) {
			clearDirtyBuildState(wsRoot);
		}
		return {
			success: fallback.success,
			exitCode: fallback.exitCode,
			makePath: makeCmd,
			makeResolved: makeCmd,
			debugDir,
			buildDir: fallback.buildDir ?? null,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolved: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: fallback.stdout ?? '',
			stderr: fallback.stderr ?? '',
			note: 'Built with bare-metal fallback (no Makefile found)'
		};
	}

	const preferredRoots = detectPreferredSourceRoots(wsRoot, buildDir);
	const preBuildHealing = healGeneratedMainFiles(wsRoot);
	const preBuildMakefile = healMakefileIncludes(wsRoot, buildDir);
	const preBuildSync = synchronizeCriticalDuplicateFiles(wsRoot, preferredRoots);
	let rebuildPlan = prepareBuildForRecentWrites(wsRoot, buildDir, params);
	if ((preBuildSync.changedCount > 0 || preBuildHealing.fixedCount > 0 || preBuildMakefile.patched) && !rebuildPlan.forceRebuild) {
		rebuildPlan = {
			...rebuildPlan,
			forceRebuild: true,
			reason: `pre-build sanitize (healed=${preBuildHealing.fixedCount}, synced=${preBuildSync.changedCount}, makefilePatched=${preBuildMakefile.patched})`
		};
	}

	if (makeLooksLikePath && !isExistingFile(makeCmd)) {
		return {
			success: false,
			exitCode: 'ENOENT',
			makePath: makeCmd,
			makeResolved: makeCmd,
			debugDir,
			buildDir,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolved: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: '',
			stderr: [
				`make path does not exist or is not a file: ${makeCmd}`,
				'',
				'Resolution attempts:',
				...makeResolution.tried.map(t => `  - ${t}`),
				'',
				'Troubleshooting:',
				'  1. Install STM32CubeCLT or GNU ARM Embedded Toolchain',
				'  2. Set stm32.makePath in settings',
				'  3. Add make to system PATH',
				'  4. Set STM32_MAKE_PATH environment variable'
			].join('\n')
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
					makeResolved: makeCmd,
					debugDir,
					buildDir,
					resolutionTried: makeResolution.tried,
					gccPath: gccCmd,
					gccResolved: gccCmd,
					gccResolutionTried: gccResolution.tried,
					stdout: versionErr.stdout ?? '',
					stderr: [
						`make executable exists but cannot be launched: ${makeCmd}`,
						'Possible missing runtime DLL/dependency or execution restriction.',
						'',
						'On Windows: Install Visual C++ Redistributables',
						'On Linux/Mac: Check file permissions and dependencies'
					].join('\n')
				};
			}
		}
	}

	try {
		const makeArgs = [`-j${jobs}`];
		if (rebuildPlan.forceRebuild) {
			makeArgs.push('-B');
		}
		makeArgs.push('all');
		const { stdout, stderr } = await execFileAsync(makeCmd, makeArgs, {
			cwd: buildDir,
			env: childEnv,
			timeout: 120000
		});
		const elfPath = findElfFile(wsRoot);
		if (elfPath) {
			try {
				writeLastBuildStamp(wsRoot, { elfPath, builtAt: new Date().toISOString(), buildDir, makePath: makeCmd });
			} catch {
				// best-effort only
			}
		}
		clearDirtyBuildState(wsRoot);
		return {
			success: true,
			exitCode: 0,
			makePath: makeCmd,
			makeResolved: makeCmd,
			makeCommand: `${makeCmd} -j${jobs}${rebuildPlan.forceRebuild ? ' -B' : ''} all`,
			debugDir,
			buildDir,
			elfPath: elfPath ?? null,
			rebuildPlan,
			preBuildHealing,
			preBuildSync,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolved: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout,
			stderr,
			note: elfPath ? 'Build succeeded. ELF file ready for flashing.' : 'Build succeeded but ELF file not found.'
		};
	} catch (err) {
		const detail = err.code === 'ENOENT'
			? [
				`make launch failed: ${makeCmd}`,
				`cwd: ${buildDir}`,
				'',
				'Resolution attempts:',
				...makeResolution.tried.map(t => `  - ${t}`),
				'',
				'Troubleshooting:',
				'  1. Verify make is installed',
				'  2. Check PATH includes make directory',
				'  3. Reinstall STM32CubeCLT or GNU ARM Toolchain'
			].join('\n')
			: (typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : (err.message ?? 'build failed'));
		return {
			success: false,
			exitCode: err.code ?? 1,
			makePath: makeCmd,
			makeResolved: makeCmd,
			makeCommand: `${makeCmd} -j${jobs}${rebuildPlan.forceRebuild ? ' -B' : ''} all`,
			debugDir,
			buildDir,
			rebuildPlan,
			preBuildHealing,
			preBuildSync,
			resolutionTried: makeResolution.tried,
			gccPath: gccCmd,
			gccResolved: gccCmd,
			gccResolutionTried: gccResolution.tried,
			stdout: err.stdout ?? '',
			stderr: detail
		};
	}
}

/**
 * Patch a CubeMX-generated Makefile that is missing the CMSIS Device include path.
 * CubeMX sometimes omits "-IDrivers/CMSIS/Device/ST/STM32Fxxx/Include" from the
 * C_INCLUDES block, causing "system_stm32fXxx.h: No such file or directory" errors.
 *
 * Strategy: look for any existing "-IDrivers/CMSIS/Include" line in the Makefile and,
 * if the sibling Device/ST/<family>/Include directory exists but is not already listed,
 * append it immediately after.
 */
function healMakefileIncludes(wsRoot, buildDir) {
	const makefilePath = path.join(buildDir ?? wsRoot, 'Makefile');
	if (!isExistingFile(makefilePath)) {
		return { patched: false };
	}

	let content = '';
	try {
		content = fs.readFileSync(makefilePath, 'utf8');
	} catch {
		return { patched: false };
	}

	// Find all CMSIS Device/ST subdirectories that exist in the project
	const driversRoot = path.join(wsRoot, 'Drivers');
	const cmsisDeviceSt = path.join(driversRoot, 'CMSIS', 'Device', 'ST');
	if (!isExistingDirectory(cmsisDeviceSt)) {
		return { patched: false };
	}

	let families = [];
	try {
		families = fs.readdirSync(cmsisDeviceSt, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return { patched: false };
	}

	const toAdd = [];
	for (const family of families) {
		const incDir = `Drivers/CMSIS/Device/ST/${family}/Include`;
		const incFlag = `-I${incDir}`;
		if (content.includes(incFlag)) {
			continue;
		}
		if (!isExistingDirectory(path.join(wsRoot, incDir))) {
			continue;
		}
		toAdd.push(incDir);
		log(`[healMakefileIncludes] Will inject missing include: ${incFlag}`);
	}

	if (toAdd.length === 0) {
		return { patched: false };
	}

	const lineBreak = /\r\n/.test(content) ? '\r\n' : '\n';

	// Match the entire C_INCLUDES = ... block (multiline with \ continuation)
	const blockRe = /^(C_INCLUDES\s*=\s*\\?\s*\n)((?:[ \t]*-I[^\n]*\n?)*)/m;
	const blockMatch = blockRe.exec(content);
	let updated = content;

	if (blockMatch) {
		// Rebuild the block: existing lines + new ones
		const existingLines = blockMatch[2].split('\n')
			.map(l => l.trim())
			.filter(l => l.startsWith('-I'));
		const allIncludes = [...existingLines, ...toAdd.map(d => `-I${d}`)];
		const newBlock = allIncludes.map((inc, i) =>
			i < allIncludes.length - 1 ? `${inc} \\${lineBreak}` : `${inc}${lineBreak}`
		).join('');
		updated = content.slice(0, blockMatch.index) +
			blockMatch[1] + newBlock +
			content.slice(blockMatch.index + blockMatch[0].length);
	} else {
		// Fallback: append to C_INCLUDES = line
		const singleLineRe = /^(C_INCLUDES\s*=\s*)(.*)$/m;
		const singleMatch = singleLineRe.exec(content);
		if (!singleMatch) {
			return { patched: false };
		}
		const extra = toAdd.map(d => ` -I${d}`).join('');
		updated = content.slice(0, singleMatch.index + singleMatch[0].length) +
			extra + content.slice(singleMatch.index + singleMatch[0].length);
	}

	try {
		fs.writeFileSync(makefilePath, updated, 'utf8');
	} catch {
		return { patched: false };
	}

	return { patched: true };
}

function healGeneratedMainFiles(wsRoot) {
	const candidates = ['Src/main.c', 'Core/Src/main.c'];
	const fixed = [];

	for (const relPath of candidates) {
		const abs = safeResolvePath(wsRoot, relPath);
		if (!isExistingFile(abs)) {
			continue;
		}
		let original = '';
		try {
			original = fs.readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		const lineBreak = /\r\n/.test(original) ? '\r\n' : '\n';
		const repaired = repairMainCCommonBraceIssue(original, lineBreak);
		if (repaired !== original) {
			try {
				fs.writeFileSync(abs, repaired, 'utf8');
				bumpFileMtimeForward(abs);
				markWorkspaceFileDirty(wsRoot, abs, 'preBuildMainRepair');
				fixed.push(relPath);
			} catch {
				// ignore single-file write failure
			}
		}
	}

	return { fixedCount: fixed.length, fixed };
}
async function toolFlash(params) {
	const wsRoot = resolveWorkspacePath(params);
	const freq = params.frequencyKHz ?? 4000;
	const forceFlash = params.force === true;
	const allowMakeFlashFallback = params.makeFlashFallback !== false;
	const programmerResolution = resolveProgrammerCliCommand(params.programmerPath, wsRoot);
	const programmer = programmerResolution.programmerCmd;

	const stlink = await detectStLink(programmer);
	if (!stlink.connected) {
		const errorDetail = [
			'ST-LINK not detected.',
			'',
			'Programmer resolution:',
			...programmerResolution.tried.map(t => `  - ${t}`),
			'',
			'Detection attempts:',
			stlink.attemptLog ?? 'no attempt log',
			'',
			'Troubleshooting:',
			'  1. Check ST-LINK cable connection',
			'  2. Check target board power',
			'  3. Verify STM32_Programmer_CLI is installed',
			'  4. Check ST-LINK driver installation',
			'  5. Verify target voltage (VAPP)'
		].join('\n');

		if (allowMakeFlashFallback) {
			const makeFlash = await flashViaMakeTarget(wsRoot);
			if (makeFlash.success) {
				return {
					success: true,
					workspacePath: wsRoot,
					programmerPath: programmer,
					resolutionTried: programmerResolution.tried,
					stdout: makeFlash.stdout ?? '',
					stderr: makeFlash.stderr ?? '',
					detection: stlink,
					flashTool: makeFlash.tool,
					note: 'Flashed via make flash target fallback.'
				};
			}
		}
		return {
			success: false,
			workspacePath: wsRoot,
			programmerPath: programmer,
			programmerResolved: programmer,
			resolutionTried: programmerResolution.tried,
			error: errorDetail,
			detection: stlink,
			makeFlashTried: allowMakeFlashFallback
		};
	}

	let elfPath = params.elfPath;

	if (!elfPath) {
		const stamp = readLastBuildStamp(wsRoot);
		if (stamp?.elfPath && isExistingFile(stamp.elfPath)) {
			elfPath = stamp.elfPath;
		}
		if (!elfPath) {
			elfPath = findElfFile(wsRoot);
		}
		if (!elfPath) {
			return { success: false, error: 'ELF file not found. Build the project first.' };
		}
		if (!forceFlash && isStaleBuildArtifact(wsRoot, elfPath)) {
			return {
				success: false,
				workspacePath: wsRoot,
				elfPath,
				error: 'ELF looks stale compared to source/.ioc changes. Rebuild first or set force=true to override.'
			};
		}
	}

	try {
		if (stlink.interface === 'st-info') {
			const fallbackFlash = await flashViaStFlash(wsRoot, elfPath);
			if (!fallbackFlash.success) {
				return {
					success: false,
					workspacePath: wsRoot,
					elfPath,
					programmerPath: programmer,
					resolutionTried: programmerResolution.tried,
					stdout: fallbackFlash.stdout ?? '',
					stderr: fallbackFlash.stderr ?? '',
					error: fallbackFlash.error ?? 'Fallback flash failed',
					detection: stlink
				};
			}
			return {
				success: true,
				workspacePath: wsRoot,
				elfPath,
				programmerPath: programmer,
				resolutionTried: programmerResolution.tried,
				stdout: fallbackFlash.stdout ?? '',
				stderr: fallbackFlash.stderr ?? '',
				detection: stlink,
				flashTool: fallbackFlash.tool
			};
		}

		const flashArgs = ['-c', 'port=SWD', `freq=${freq}`, '-w', elfPath, '-v', '-rst'];
		verbose(`Flash command: ${programmer} ${flashArgs.join(' ')}`);
		const { stdout, stderr } = await execFileAsync(
			programmer,
			flashArgs,
			{ cwd: wsRoot, timeout: 60000 }
		);
		const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
		const verified = /Download verified successfully|File download complete/i.test(combined);
		if (!verified) {
			return {
				success: false,
				workspacePath: wsRoot,
				elfPath,
				programmerPath: programmer,
				resolutionTried: programmerResolution.tried,
				stdout,
				stderr,
				error: 'Flash command finished without verification signature in output.'
			};
		}
		return {
			success: true,
			workspacePath: wsRoot,
			elfPath,
			programmerPath: programmer,
			programmerResolved: programmer,
			resolutionTried: programmerResolution.tried,
			flashCommand: `${programmer} ${flashArgs.join(' ')}`,
			stdout,
			stderr,
			detection: stlink,
			note: 'Flash completed with -rst flag (MCU will reset and run program immediately)'
		};
	} catch (err) {
		return {
			success: false,
			workspacePath: wsRoot,
			elfPath,
			programmerPath: programmer,
			resolutionTried: programmerResolution.tried,
			exitCode: err.code ?? 1,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? err.message,
			detection: stlink
		};
	}
}

async function flashViaMakeTarget(wsRoot) {
	const buildDir = findBuildDirectoryWithMakefile(wsRoot) ?? wsRoot;
	const makeResolution = resolveMakeCommand(getConfigValue('makePath', ['STM32_MAKE_PATH', 'MAKE_PATH'], wsRoot));
	const makeCmd = makeResolution.makeCmd;

	const makefilePath = path.join(buildDir, 'Makefile');
	if (!isLikelyCubeMxMakefile(makefilePath) && !isExistingFile(makefilePath)) {
		return { success: false, tool: makeCmd, error: `Makefile not found: ${makefilePath}`, stdout: '', stderr: '' };
	}

	try {
		const makeText = fs.readFileSync(makefilePath, 'utf8');
		if (!/^flash\s*:/m.test(makeText)) {
			return { success: false, tool: makeCmd, error: 'flash target not found in Makefile', stdout: '', stderr: '' };
		}
	} catch {
		return { success: false, tool: makeCmd, error: 'failed to inspect Makefile', stdout: '', stderr: '' };
	}

	try {
		const { stdout, stderr } = await execFileAsync(makeCmd, ['flash'], { cwd: buildDir, timeout: 120000 });
		const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
		const ok = !/error|failed|No such file|not found|cannot/i.test(combined);
		if (!ok) {
			return { success: false, tool: makeCmd, stdout, stderr, error: 'make flash finished with failure signatures' };
		}
		return { success: true, tool: makeCmd, stdout, stderr };
	} catch (err) {
		return {
			success: false,
			tool: makeCmd,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? err.message ?? '',
			error: 'make flash execution failed'
		};
	}
}

async function flashViaStFlash(wsRoot, elfPath) {
	const stFlashCmd = resolveCommandFromPath(['st-flash']);
	if (!stFlashCmd) {
		return { success: false, error: 'st-flash not found on PATH', stdout: '', stderr: '' };
	}

	let binPath = elfPath;
	let tempBinPath = null;
	try {
		if (/\.elf$/i.test(elfPath)) {
			const objcopyCmd = resolveArmObjcopyCommand(wsRoot);
			if (!objcopyCmd) {
				return { success: false, error: 'arm-none-eabi-objcopy not found for ELF conversion', stdout: '', stderr: '' };
			}
			tempBinPath = path.join(require('os').tmpdir(), `mcp-flash-${Date.now()}.bin`);
			await execFileAsync(objcopyCmd, ['-O', 'binary', elfPath, tempBinPath], { cwd: wsRoot, timeout: 60000 });
			binPath = tempBinPath;
		}

		const { stdout, stderr } = await execFileAsync(stFlashCmd, ['--reset', 'write', binPath, '0x08000000'], { cwd: wsRoot, timeout: 60000 });
		const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
		const ok = /verified|flash written|flashing|wrote|success/i.test(combined) || (stderr ?? '').length === 0;
		if (!ok) {
			return { success: false, tool: stFlashCmd, stdout, stderr, error: 'st-flash finished without success signature.' };
		}
		return { success: true, tool: stFlashCmd, stdout, stderr };
	} catch (err) {
		return {
			success: false,
			tool: stFlashCmd,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? err.message ?? '',
			error: 'st-flash execution failed'
		};
	} finally {
		if (tempBinPath) {
			try { fs.unlinkSync(tempBinPath); } catch { }
		}
	}
}

async function toolRegenerateCode(params) {
	let wsRoot = resolveWorkspacePath(params);
	const cubemxResolution = resolveCubeMxCommand(params.cubemxPath, wsRoot);
	const cubemxPath = cubemxResolution.cubemxCmd;

	let iocPath = params.iocPath;
	if (typeof iocPath === 'string' && iocPath.trim().length > 0) {
		iocPath = iocPath.trim();
		if (!path.isAbsolute(iocPath)) {
			iocPath = safeResolvePath(wsRoot, iocPath);
		} else if (isExistingFile(iocPath)) {
			// If caller supplied absolute iocPath, use its directory as execution workspace unless explicitly pinned.
			if (!params.workspacePath) {
				wsRoot = path.dirname(iocPath);
			}
		}
	}

	if (!iocPath) {
		iocPath = selectPreferredIocPath(wsRoot);
	}

	if (!iocPath) {
		return { success: false, error: '.ioc file not found', workspacePath: wsRoot };
	}

	if (!isExistingFile(iocPath) || path.extname(iocPath).toLowerCase() !== '.ioc') {
		return { success: false, error: `Invalid iocPath: ${iocPath}`, workspacePath: wsRoot };
	}

	const rawIoc = fs.readFileSync(iocPath, 'utf8');
	if (!/^(Mcu\.|ProjectManager\.|File\.Version=)/m.test(rawIoc)) {
		return {
			success: false,
			error: `Not a valid ioc file: ${iocPath}`,
			workspacePath: wsRoot,
			diagnostics: ['Expected keys like Mcu.* / ProjectManager.* were not found in the .ioc content.']
		};
	}

	// Repair .ioc before first run (normal mode)
	const iocSanitize = sanitizeIocForCubeMx(iocPath, wsRoot, { aggressive: false });

	const normalizedIocPath = iocPath.replace(/\\/g, '/');
	const normalizedWsRoot = wsRoot.replace(/\\/g, '/');

	// CRITICAL: CubeMX script must explicitly set toolchain to Makefile
	// The .ioc file already contains project settings, we just need to ensure toolchain is correct
	const scriptContent = [
		`config load "${normalizedIocPath}"`,
		`project toolchain Makefile`,
		`generate code`,
		`exit`
	].join('\n');

	const scriptPath = path.join(require('os').tmpdir(), `cubemx-script-${Date.now()}.txt`);
	fs.writeFileSync(scriptPath, scriptContent, 'utf8');

	console.log('[MCP] CubeMX script:', scriptContent);

	try {
		const runCubeMx = async () => {
			console.log(`[MCP] Executing CubeMX: ${cubemxPath}`);
			console.log(`[MCP] Working directory: ${wsRoot}`);

			console.log(`[MCP] Script path: ${scriptPath}`);

			let stdout = '';
			let stderr = '';
			let exitCode = 0;

			try {
				const result = await execFileAsync(cubemxPath, ['-s', scriptPath], {
					cwd: wsRoot,
					timeout: 180000,
					maxBuffer: 10 * 1024 * 1024
				});
				stdout = result.stdout || '';
				stderr = result.stderr || '';
			} catch (err) {
				stdout = err.stdout || '';
				stderr = err.stderr || '';
				exitCode = err.code || 1;
				console.error('[MCP] CubeMX execution error:', err.message);
			}

			const combinedOutput = `${stdout}\n${stderr}`;
			const fatalDiagnostics = extractCubeMxFatalDiagnostics(combinedOutput);

			console.log('[MCP] CubeMX stdout length:', stdout.length);
			console.log('[MCP] CubeMX stderr length:', stderr.length);
			console.log('[MCP] Fatal diagnostics:', fatalDiagnostics.length);

			return { stdout, stderr, combinedOutput, fatalDiagnostics, exitCode };
		};

		let firstRun = await runCubeMx();
		let retriedAfterRepair = false;
		let retryRepair = { changed: false, changedKeys: [], aggressiveApplied: false };

		if (firstRun.fatalDiagnostics.length > 0) {
			retryRepair = sanitizeIocForCubeMx(iocPath, wsRoot, { aggressive: true });
			if (retryRepair.changed) {
				retriedAfterRepair = true;
				firstRun = await runCubeMx();
			}
		}

		const { stdout, stderr, combinedOutput, fatalDiagnostics, exitCode } = firstRun;

		// Check for execution errors first
		if (exitCode !== 0 && exitCode !== undefined) {
			return {
				success: false,
				iocPath,
				workspacePath: wsRoot,
				cubemxPath,
				exitCode,
				stdout,
				stderr,
				error: [
					`CubeMX execution failed with exit code ${exitCode}.`,
					'',
					'This usually means:',
					'  1. CubeMX executable not found or not executable',
					'  2. .ioc file is corrupted or incompatible',
					'  3. CubeMX crashed during code generation',
					'',
					'Troubleshooting:',
					'  - Verify CubeMX path is correct',
					'  - Try opening .ioc in CubeMX GUI',
					'  - Check stderr output below for details',
					'',
					'STDERR:',
					stderr || '(empty)'
				].join('\n'),
				diagnostics: extractCubeMxDiagnostics(combinedOutput)
			};
		}

		if (fatalDiagnostics.length > 0) {
			return {
				success: false,
				iocPath,
				workspacePath: wsRoot,
				cubemxPath,
				cubemxResolved: cubemxPath,
				resolutionTried: cubemxResolution.tried,
				sanitizedIoc: iocSanitize.changed || retryRepair.changed,
				sanitizedKeys: [...new Set([...(iocSanitize.changedKeys ?? []), ...(retryRepair.changedKeys ?? [])])],
				retriedAfterRepair,
				stdout,
				stderr,
				error: [
					'CubeMX reported fatal errors during regenerate.',
					'',
					'Fatal diagnostics:',
					...fatalDiagnostics.map(d => `  - ${d}`),
					'',
					'Troubleshooting:',
					'  1. Open .ioc file in STM32CubeMX GUI and verify it loads',
					'  2. Check for invalid pin configurations',
					'  3. Ensure MCU/Board name is correct',
					'  4. Update STM32CubeMX to the latest version'
				].join('\n'),
				fatalDiagnostics,
				diagnostics: [...extractCubeMxDiagnostics(combinedOutput), ...fatalDiagnostics].slice(0, 50)
			};
		}

		const generatedRootHints = extractGeneratedRootHintsFromCubeMxOutput(combinedOutput, wsRoot);
		const projectArtifacts = detectGeneratedProjectArtifacts(wsRoot, iocPath, generatedRootHints);
		if (!projectArtifacts.generated) {
			return {
				success: false,
				iocPath,
				workspacePath: wsRoot,
				cubemxPath,
				cubemxResolved: cubemxPath,
				resolutionTried: cubemxResolution.tried,
				sanitizedIoc: iocSanitize.changed || retryRepair.changed,
				sanitizedKeys: [...new Set([...(iocSanitize.changedKeys ?? []), ...(retryRepair.changedKeys ?? [])])],
				retriedAfterRepair,
				stdout,
				stderr,
				error: [
					'CubeMX completed but STM project sources were not generated.',
					'',
					'Expected artifacts not found:',
					'  - main.c or main.h',
					'  - Makefile or project files',
					'',
					'Verify CubeMX project settings:',
					'  1. Toolchain/IDE should be "Makefile" or "STM32CubeIDE"',
					'  2. Project path should be correct',
					'  3. Check CubeMX output for warnings'
				].join('\n'),
				diagnostics: extractCubeMxDiagnostics(combinedOutput),
				projectArtifacts,
				generatedRootHints
			};
		}

		const counterpartSync = syncGeneratedArtifactsToCounterparts(wsRoot, projectArtifacts);

		// CRITICAL: Verify Makefile was actually generated
		const makefilePath = path.join(wsRoot, 'Makefile');
		const makefileExists = isExistingFile(makefilePath);

		if (!makefileExists) {
			console.error('[MCP] CRITICAL: Makefile not generated!');
			console.error('[MCP] Checking .ioc settings...');

			const iocContent = fs.readFileSync(iocPath, 'utf8');
			const toolchainLine = iocContent.match(/ProjectManager\.ToolChain=(.+)/);
			const currentToolchain = toolchainLine ? toolchainLine[1].trim() : 'NOT SET';

			return {
				success: false,
				iocPath,
				workspacePath: wsRoot,
				cubemxPath,
				cubemxResolved: cubemxPath,
				resolutionTried: cubemxResolution.tried,
				sanitizedIoc: iocSanitize.changed || retryRepair.changed,
				sanitizedKeys: [...new Set([...(iocSanitize.changedKeys ?? []), ...(retryRepair.changedKeys ?? [])])],
				retriedAfterRepair,
				stdout,
				stderr,
				error: [
					'CRITICAL: CubeMX did not generate Makefile!',
					'',
					'Current .ioc Toolchain setting: ' + currentToolchain,
					'Expected: Makefile',
					'',
					'This means CubeMX ignored the toolchain setting.',
					'',
					'REQUIRED ACTIONS:',
					'  1. Open .ioc file in STM32CubeMX GUI',
					'  2. Go to Project Manager → Project',
					'  3. Set Toolchain/IDE to "Makefile"',
					'  4. Click "GENERATE CODE"',
					'  5. Verify Makefile appears in project root',
					'',
					'If Makefile still not generated:',
					'  - Your CubeMX version may not support Makefile generation',
					'  - Try selecting "STM32CubeIDE" instead',
					'  - Update CubeMX to latest version'
				].join('\n'),
				projectArtifacts,
				generatedRootHints,
				syncedCounterparts: counterpartSync.synced,
				skippedCounterparts: counterpartSync.skipped,
				makefileGenerated: false,
				diagnostics: extractCubeMxDiagnostics(combinedOutput),
				currentToolchainSetting: currentToolchain
			};
		}

		const buildDir = findBuildDirectoryWithMakefile(wsRoot);
		console.log('[MCP] Makefile found at:', makefilePath);
		console.log('[MCP] Build directory:', buildDir || wsRoot);

		// Final verification: Check for HAL libraries
		const driversPath = path.join(wsRoot, 'Drivers');
		const hasDrivers = isExistingDirectory(driversPath);
		const corePath = path.join(wsRoot, 'Core');
		const hasCore = isExistingDirectory(corePath);

		const verificationWarnings = [];
		if (!hasDrivers) {
			verificationWarnings.push('Drivers folder not found - HAL libraries may be missing');
		}
		if (!hasCore) {
			verificationWarnings.push('Core folder not found - main.c may be missing');
		}

		console.log('[MCP] Verification: Drivers exists:', hasDrivers);
		console.log('[MCP] Verification: Core exists:', hasCore);
		console.log('[MCP] Code generation completed successfully!');

		return {
			success: true,
			iocPath,
			workspacePath: wsRoot,
			cubemxPath,
			cubemxResolved: cubemxPath,
			resolutionTried: cubemxResolution.tried,
			sanitizedIoc: iocSanitize.changed || retryRepair.changed,
			sanitizedKeys: [...new Set([...(iocSanitize.changedKeys ?? []), ...(retryRepair.changedKeys ?? [])])],
			retriedAfterRepair,
			projectArtifacts,
			generatedRootHints,
			syncedCounterparts: counterpartSync.synced,
			skippedCounterparts: counterpartSync.skipped,
			makefileGenerated: true,
			makefilePath,
			buildDir,
			verification: {
				hasDrivers,
				hasCore,
				hasMakefile: true,
				warnings: verificationWarnings
			},
			stdout,
			stderr,
			note: verificationWarnings.length > 0
				? `Code regenerated with warnings: ${verificationWarnings.join('; ')}`
				: 'Code regenerated successfully. Project is ready to build.'
		};
	} catch (err) {
		const detail = err.code === 'ENOENT'
			? [
				`STM32CubeMX executable not found: ${cubemxPath}`,
				'',
				'Resolution attempts:',
				...cubemxResolution.tried.map(t => `  - ${t}`),
				'',
				'Troubleshooting:',
				'  1. Install STM32CubeMX from st.com',
				'  2. Set stm32.cubemxPath in settings to executable path',
				'  3. Add STM32CubeMX to system PATH',
				'  4. Set STM32_CUBEMX_PATH environment variable'
			].join('\n')
			: ((typeof err.stderr === 'string' && err.stderr.length > 0) ? err.stderr : (err.message ?? 'regenerate failed'));
		return {
			success: false,
			iocPath,
			workspacePath: wsRoot,
			cubemxPath,
			cubemxResolved: cubemxPath,
			resolutionTried: cubemxResolution.tried,
			exitCode: err.code ?? 1,
			stdout: err.stdout ?? '',
			stderr: detail,
			diagnostics: extractCubeMxDiagnostics((err.stdout ?? '') + '\n' + (err.stderr ?? ''))
		};
	} finally {
		fs.unlink(scriptPath, () => { });
	}
}

function detectGeneratedProjectArtifacts(wsRoot, iocPath = null, generatedRootHints = null) {
	const buildDir = findBuildDirectoryWithMakefile(wsRoot);
	const preferredRoots = detectPreferredSourceRoots(wsRoot, buildDir);
	const iocProjectPath = readIocProjectPath(iocPath);
	const rootsByIoc = deriveSourceRootsFromIocProjectPath(iocProjectPath);

	const expectedSourceRoot = generatedRootHints?.sourceRoot ?? rootsByIoc.sourceRoot ?? preferredRoots.sourceRoot;
	const expectedIncludeRoot = generatedRootHints?.includeRoot ?? rootsByIoc.includeRoot ?? preferredRoots.includeRoot;

	const rootPairs = [
		{ sourceRoot: 'Core/Src', includeRoot: 'Core/Inc' },
		{ sourceRoot: 'Src', includeRoot: 'Inc' },
	];
	let bestPair = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	const now = Date.now();

	for (const pair of rootPairs) {
		const mainCPath = path.join(wsRoot, pair.sourceRoot, 'main.c');
		const mainHPath = path.join(wsRoot, pair.includeRoot, 'main.h');
		if (!isExistingFile(mainCPath) || !isExistingFile(mainHPath)) {
			continue;
		}

		let score = 0;
		try {
			score += scoreGeneratedFileContent(fs.readFileSync(mainCPath, 'utf8'), 'c');
		} catch {
			score -= 20;
		}
		try {
			score += scoreGeneratedFileContent(fs.readFileSync(mainHPath, 'utf8'), 'h');
		} catch {
			score -= 10;
		}

		score += scoreFileRecency(getFileMtimeSafe(mainCPath), now);
		score += scoreFileRecency(getFileMtimeSafe(mainHPath), now);

		if (pair.sourceRoot === expectedSourceRoot) {
			score += 10;
		}
		if (pair.includeRoot === expectedIncludeRoot) {
			score += 10;
		}

		if (generatedRootHints?.sourceRoot || generatedRootHints?.includeRoot) {
			if (generatedRootHints?.sourceRoot && pair.sourceRoot === generatedRootHints.sourceRoot) {
				score += 140;
			}
			if (generatedRootHints?.includeRoot && pair.includeRoot === generatedRootHints.includeRoot) {
				score += 140;
			}
			if (generatedRootHints?.sourceRoot && pair.sourceRoot !== generatedRootHints.sourceRoot) {
				score -= 80;
			}
			if (generatedRootHints?.includeRoot && pair.includeRoot !== generatedRootHints.includeRoot) {
				score -= 80;
			}
		}

		if (!bestPair || score > bestScore) {
			bestPair = pair;
			bestScore = score;
		}
	}

	const sourceRoot = bestPair?.sourceRoot ?? expectedSourceRoot;
	const includeRoot = bestPair?.includeRoot ?? expectedIncludeRoot;
	const mainC = isExistingFile(path.join(wsRoot, sourceRoot, 'main.c')) ? path.join(wsRoot, sourceRoot, 'main.c') : null;
	const mainH = isExistingFile(path.join(wsRoot, includeRoot, 'main.h')) ? path.join(wsRoot, includeRoot, 'main.h') : null;
	const startupCandidates = [
		path.join(wsRoot, sourceRoot.startsWith('Core/') ? 'Core/Startup' : 'Startup'),
		path.join(wsRoot, sourceRoot.startsWith('Core/') ? 'Startup' : 'Core/Startup'),
	];
	const startupDir = startupCandidates.find(isExistingDirectory) ?? null;

	return {
		generated: Boolean(mainC && mainH),
		mainC,
		mainH,
		startupDir,
		expectedSourceRoot: sourceRoot,
		expectedIncludeRoot: includeRoot,
	};
}

function scoreFileRecency(mtimeMs, nowMs = Date.now()) {
	if (!mtimeMs || mtimeMs <= 0) {
		return -30;
	}
	const ageMs = Math.max(0, nowMs - mtimeMs);
	if (ageMs <= 2 * 60 * 1000) {
		return 80;
	}
	if (ageMs <= 10 * 60 * 1000) {
		return 50;
	}
	if (ageMs <= 60 * 60 * 1000) {
		return 20;
	}
	if (ageMs <= 24 * 60 * 60 * 1000) {
		return 5;
	}
	return -10;
}

function getFileMtimeSafe(filePath) {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

function readIocProjectPath(iocPath) {
	if (!iocPath || !isExistingFile(iocPath)) {
		return null;
	}
	try {
		const content = fs.readFileSync(iocPath, 'utf8');
		const raw = content.match(/^ProjectManager\.ProjectPath=(.+)$/m)?.[1]?.trim() ?? '';
		if (!raw) {
			return null;
		}
		const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
		if (!normalized || normalized.includes('..')) {
			return null;
		}
		return normalized;
	} catch {
		return null;
	}
}

function deriveSourceRootsFromIocProjectPath(projectPath) {
	const normalized = (projectPath ?? '').toLowerCase();
	if (normalized === 'core') {
		return { sourceRoot: 'Core/Src', includeRoot: 'Core/Inc' };
	}
	if (normalized === '.' || normalized === '' || normalized === 'src' || normalized === 'inc') {
		return { sourceRoot: 'Src', includeRoot: 'Inc' };
	}
	return { sourceRoot: null, includeRoot: null };
}

function pickBestGeneratedCandidate(candidates, expectedRoot, fileKind) {
	let bestPath = null;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const candidate of candidates) {
		if (!isExistingFile(candidate)) {
			continue;
		}

		let score = 0;
		try {
			const text = fs.readFileSync(candidate, 'utf8');
			score += scoreGeneratedFileContent(text, fileKind);
		} catch {
			score -= 10;
		}

		try {
			const mtime = fs.statSync(candidate).mtimeMs;
			score += Math.min(50, Math.max(0, mtime / 1e12));
		} catch {
			// ignore mtime scoring failure
		}

		const normalizedCandidate = candidate.replace(/\\/g, '/').toLowerCase();
		if (expectedRoot && normalizedCandidate.includes(`/${expectedRoot.toLowerCase()}/`)) {
			score += 40;
		}

		if (!bestPath || score > bestScore) {
			bestPath = candidate;
			bestScore = score;
		}
	}

	return bestPath;
}

function scoreGeneratedFileContent(text, fileKind) {
	let score = 0;
	if (/\/\*\s*USER CODE BEGIN\s+/i.test(text)) {
		score += 120;
	}
	if (fileKind === 'c') {
		if (/HAL_Init\s*\(/.test(text)) {
			score += 40;
		}
		if (/SystemClock_Config\s*\(/.test(text)) {
			score += 25;
		}
		if (/MX_GPIO_Init\s*\(/.test(text)) {
			score += 20;
		}
		if (/stm32f[0-9a-z]+_hal\.h/i.test(text)) {
			score += 15;
		}
	}
	if (fileKind === 'h') {
		if (/void\s+Error_Handler\s*\(/.test(text)) {
			score += 20;
		}
		if (/__MAIN_H|MAIN_H/.test(text)) {
			score += 10;
		}
	}
	return score;
}

function pickNewestExistingFile(candidates) {
	let bestPath = null;
	let bestMtime = -1;
	for (const candidate of candidates) {
		if (!isExistingFile(candidate)) {
			continue;
		}
		let mtime = 0;
		try {
			mtime = fs.statSync(candidate).mtimeMs;
		} catch {
			mtime = 0;
		}
		if (!bestPath || mtime >= bestMtime) {
			bestPath = candidate;
			bestMtime = mtime;
		}
	}
	return bestPath;
}

function sanitizeIocForCubeMx(iocPath, wsRoot, options = {}) {
	try {
		const aggressive = options.aggressive === true;
		let content = fs.readFileSync(iocPath, 'utf8');
		const lines = content.split(/\r?\n/);
		const changedKeys = new Set();

		const keyIndex = new Map();
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^([^#;][^=]*)=(.*)$/);
			if (m) {
				keyIndex.set(m[1].trim(), i);
			}
		}

		function getValue(key) {
			const idx = keyIndex.get(key);
			if (idx === undefined) return undefined;
			const m = lines[idx].match(/^[^=]*=(.*)$/);
			return (m?.[1] ?? '').trim();
		}

		function setValue(key, value) {
			const idx = keyIndex.get(key);
			const line = `${key}=${value}`;
			if (idx === undefined) {
				lines.push(line);
				keyIndex.set(key, lines.length - 1);
			} else if (lines[idx] !== line) {
				lines[idx] = line;
			}
			changedKeys.add(key);
		}

		const iocBaseName = path.basename(iocPath, '.ioc');
		const currentMcuName = getValue('Mcu.Name') || getValue('Mcu.CPN') || getValue('Mcu.UserName') || '';
		const canonicalMcu = currentMcuName ? resolveCanonicalMcuName(currentMcuName, wsRoot || path.dirname(iocPath)).canonical : '';

		if (getValue('ProjectManager.ComputerToolchain') === 'false') {
			setValue('ProjectManager.ComputerToolchain', '0');
		}
		if (getValue('ProjectManager.ComputerToolchain') === 'true') {
			setValue('ProjectManager.ComputerToolchain', '1');
		}

		if (!getValue('File.Version')) setValue('File.Version', '6');
		if (!getValue('ProjectManager.ProjectName')) setValue('ProjectManager.ProjectName', iocBaseName);
		if (!getValue('ProjectManager.ProjectFileName')) setValue('ProjectManager.ProjectFileName', `${iocBaseName}.ioc`);

		// CRITICAL: Always force Toolchain to Makefile, regardless of current value
		const currentToolchain = getValue('ProjectManager.ToolChain');
		if (currentToolchain !== 'Makefile') {
			setValue('ProjectManager.ToolChain', 'Makefile');
		}
		// Fix broken TargetToolchain key (board configurator previously wrote this wrong key)
		const brokenToolchain = getValue('ProjectManager.TargetToolchain');
		if (brokenToolchain) {
			// Remove the broken key line entirely and ensure ToolChain=Makefile is set
			const brokenIdx = keyIndex.get('ProjectManager.TargetToolchain');
			if (brokenIdx !== undefined) {
				lines[brokenIdx] = ''; // blank out the broken key
				changedKeys.add('ProjectManager.TargetToolchain');
			}
			if (!getValue('ProjectManager.ToolChain') || getValue('ProjectManager.ToolChain') !== 'Makefile') {
				setValue('ProjectManager.ToolChain', 'Makefile');
			}
		}
		// CRITICAL: Remove ProjectPath if set — it causes CubeMX to generate Makefile/Drivers in wrong directory
		const currentProjectPath = getValue('ProjectManager.ProjectPath');
		if (currentProjectPath && currentProjectPath !== '.' && currentProjectPath !== '') {
			const ppIdx = keyIndex.get('ProjectManager.ProjectPath');
			if (ppIdx !== undefined) {
				lines[ppIdx] = ''; // remove ProjectPath entirely
				changedKeys.add('ProjectManager.ProjectPath');
			}
		}
		if (!getValue('ProjectManager.NoMain')) setValue('ProjectManager.NoMain', 'false');

		if (!getValue('Mcu.Name') && canonicalMcu) setValue('Mcu.Name', canonicalMcu);
		if (!getValue('Mcu.CPN') && canonicalMcu) setValue('Mcu.CPN', canonicalMcu);
		if (!getValue('Mcu.UserName') && canonicalMcu) setValue('Mcu.UserName', canonicalMcu);

		if (!getValue('Mcu.Family') && canonicalMcu) {
			const inferred = inferMcuFamilyFromName(canonicalMcu);
			if (inferred) setValue('Mcu.Family', inferred);
		}

		if (!getValue('Mcu.IPNb')) setValue('Mcu.IPNb', '0');
		if (!getValue('Mcu.ThirdPartyNb')) setValue('Mcu.ThirdPartyNb', '0');

		// Ensure minimal IP set for valid HAL code generation (MX_GPIO_Init, clock, system init).
		const ipEntries = [];
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^Mcu\.IP(\d+)=(.+)$/);
			if (!m) {
				continue;
			}
			ipEntries.push({ index: Number(m[1]), value: m[2].trim() });
		}
		const existingIps = ipEntries
			.sort((a, b) => a.index - b.index)
			.map(e => e.value)
			.filter(Boolean);
		const requiredIps = ['GPIO', 'RCC', 'SYS'];
		for (const ip of requiredIps) {
			if (!existingIps.includes(ip)) {
				existingIps.push(ip);
			}
		}
		for (let i = 0; i < existingIps.length; i++) {
			setValue(`Mcu.IP${i}`, existingIps[i]);
		}
		setValue('Mcu.IPNb', String(existingIps.length));

		// Remove broken pin entries that often make CubeMX load partial/empty project state.
		const configuredSignalPins = new Set();
		for (const line of lines) {
			const m = line.match(/^([A-Z]{1,2}\d+|VP_[A-Z0-9_]+)\.(?:Signal|Mode)=/i);
			if (m) {
				configuredSignalPins.add(m[1].toUpperCase());
			}
		}
		const validPins = [];
		for (const line of lines) {
			const m = line.match(/^Mcu\.Pin\d+=(.+)$/);
			if (!m) {
				continue;
			}
			const pinName = (m[1] ?? '').trim();
			if (!pinName) {
				continue;
			}
			const key = pinName.toUpperCase();
			if (configuredSignalPins.has(key) || key.startsWith('VP_')) {
				validPins.push(pinName);
			}
		}
		if (validPins.length > 0) {
			for (let i = 0; i < validPins.length; i++) {
				setValue(`Mcu.Pin${i}`, validPins[i]);
			}
			setValue('Mcu.PinsNb', String(validPins.length));
		}

		const pinCount = lines.filter(l => /^Mcu\.Pin\d+=.+$/.test(l.trim())).length;
		const existingPinsNb = getValue('Mcu.PinsNb');
		if (!existingPinsNb || !/^\d+$/.test(existingPinsNb)) {
			setValue('Mcu.PinsNb', String(pinCount));
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const m = line.match(/^([^#;][^=]*)=(.*)$/);
			if (!m) continue;
			const key = m[1].trim();
			const val = (m[2] ?? '').trim();

			if (val === '' && /(?:Nb|Count|Number|Index)$/i.test(key)) {
				lines[i] = `${key}=0`;
				changedKeys.add(key);
			}

			if (aggressive && val === '' && /^Mcu\.(?:IP|Pin)\d+$/i.test(key)) {
				lines[i] = `${key}=`;
				changedKeys.add(key);
			}
		}

		const repaired = lines.join('\n');
		if (repaired !== content) {
			fs.writeFileSync(iocPath, repaired, 'utf8');
			return { changed: true, changedKeys: Array.from(changedKeys), aggressiveApplied: aggressive };
		}

		return { changed: false, changedKeys: Array.from(changedKeys), aggressiveApplied: aggressive };
	} catch {
		return { changed: false, changedKeys: [], aggressiveApplied: options.aggressive === true };
	}
}

function extractCubeMxDiagnostics(stdout) {
	if (typeof stdout !== 'string' || stdout.length === 0) {
		return [];
	}

	const lines = stdout.split(/\r?\n/);
	const picked = [];
	for (const line of lines) {
		if (/Exception|ERROR|OptionalMessage_ERROR|cannot be retrieved|NumberFormatException/i.test(line)) {
			picked.push(line.trim());
			if (picked.length >= 30) {
				break;
			}
		}
	}
	return picked;
}

function extractCubeMxFatalDiagnostics(output) {
	if (typeof output !== 'string' || output.length === 0) {
		return [];
	}

	const fatalPatterns = [
		/Not a valid ioc file/i,
		/OptionalMessage_ERROR.*Not a valid ioc file/i,
		/Exception in thread/i,
		/java\.lang\.(?:IllegalArgumentException|NullPointerException|NumberFormatException|RuntimeException)/i,
		/Failed to load .*ioc/i,
		/cannot open .*\.ioc/i,
		/no such file or directory.*\.ioc/i,
	];

	const lines = output.split(/\r?\n/);
	const picked = [];
	for (const line of lines) {
		if (!line || !line.trim()) {
			continue;
		}
		if (fatalPatterns.some(re => re.test(line))) {
			const normalized = line.trim();
			if (!picked.includes(normalized)) {
				picked.push(normalized);
			}
			if (picked.length >= 20) {
				break;
			}
		}
	}
	return picked;
}

function extractGeneratedRootHintsFromCubeMxOutput(output, wsRoot) {
	if (typeof output !== 'string' || output.length === 0) {
		return null;
	}

	const normalizedWs = String(wsRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const stats = {
		coreSrc: 0,
		src: 0,
		coreInc: 0,
		inc: 0,
		coreMainC: 0,
		srcMainC: 0,
		coreMainH: 0,
		incMainH: 0,
	};

	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/Generated code:\s*(.+)$/i);
		if (!match) {
			continue;
		}
		let rawPath = (match[1] ?? '').trim().replace(/\\/g, '/').replace(/\r/g, '');
		if (!rawPath) {
			continue;
		}

		const lowerPath = rawPath.toLowerCase();
		let rel = lowerPath;
		if (normalizedWs) {
			if (lowerPath === normalizedWs) {
				rel = '';
			} else if (lowerPath.startsWith(`${normalizedWs}/`)) {
				rel = lowerPath.slice(normalizedWs.length + 1);
			} else {
				const idx = lowerPath.indexOf(`/${normalizedWs}/`);
				if (idx >= 0) {
					rel = lowerPath.slice(idx + normalizedWs.length + 2);
				}
			}
		}

		rel = rel.replace(/^\/+/, '');
		if (!rel) {
			continue;
		}

		if (rel.startsWith('core/src/')) stats.coreSrc += 1;
		if (rel.startsWith('src/')) stats.src += 1;
		if (rel.startsWith('core/inc/')) stats.coreInc += 1;
		if (rel.startsWith('inc/')) stats.inc += 1;

		if (rel.endsWith('core/src/main.c')) stats.coreMainC += 1;
		if (rel.endsWith('src/main.c')) stats.srcMainC += 1;
		if (rel.endsWith('core/inc/main.h')) stats.coreMainH += 1;
		if (rel.endsWith('inc/main.h')) stats.incMainH += 1;
	}

	let sourceRoot = null;
	if (stats.srcMainC > 0 && stats.coreMainC === 0) {
		sourceRoot = 'Src';
	} else if (stats.coreMainC > 0 && stats.srcMainC === 0) {
		sourceRoot = 'Core/Src';
	} else if (stats.src > stats.coreSrc) {
		sourceRoot = 'Src';
	} else if (stats.coreSrc > 0) {
		sourceRoot = 'Core/Src';
	}

	let includeRoot = null;
	if (stats.incMainH > 0 && stats.coreMainH === 0) {
		includeRoot = 'Inc';
	} else if (stats.coreMainH > 0 && stats.incMainH === 0) {
		includeRoot = 'Core/Inc';
	} else if (stats.inc > stats.coreInc) {
		includeRoot = 'Inc';
	} else if (stats.coreInc > 0) {
		includeRoot = 'Core/Inc';
	}

	if (!sourceRoot && !includeRoot) {
		return null;
	}

	return {
		sourceRoot,
		includeRoot,
		stats,
	};
}

function toolAnalyzeHardFault(params) {
	const cfsr = parseInt(params.cfsr, 16);
	const hfsr = params.hfsr ? parseInt(params.hfsr, 16) : null;
	const mmfar = params.mmfar ?? null;
	const bfar = params.bfar ?? null;
	const issues = [];

	// UFSR (Usage Fault) bits 15:0 of CFSR
	if (cfsr & 0x0001) issues.push({ type: 'UsageFault', bit: 'UNDEFINSTR', desc: 'Undefined instruction executed. Possible jump to invalid memory address.' });
	if (cfsr & 0x0002) issues.push({ type: 'UsageFault', bit: 'INVSTATE', desc: 'Invalid EPSR state. Possible branch without Thumb bit set.' });
	if (cfsr & 0x0004) issues.push({ type: 'UsageFault', bit: 'INVPC', desc: 'Invalid PC load (EXC_RETURN error).' });
	if (cfsr & 0x0008) issues.push({ type: 'UsageFault', bit: 'NOCP', desc: 'Coprocessor (FPU etc.) used while disabled.' });
	if (cfsr & 0x0100) issues.push({ type: 'UsageFault', bit: 'UNALIGNED', desc: 'Unaligned memory access. SCB->CCR UNALIGN_TRP is set.' });
	if (cfsr & 0x0200) issues.push({ type: 'UsageFault', bit: 'DIVBYZERO', desc: 'Division by zero. SCB->CCR DIV_0_TRP is set.' });

	// BFSR bits 15:8 of CFSR
	if (cfsr & 0x0100_0000 >> 16) { }  // alias correction — use direct bit test
	const bfsr = (cfsr >> 8) & 0xFF;
	if (bfsr & 0x01) issues.push({ type: 'BusFault', bit: 'IBUSERR', desc: 'Instruction fetch bus error. PC points to invalid Flash/RAM address.' });
	if (bfsr & 0x02) issues.push({ type: 'BusFault', bit: 'PRECISERR', desc: `Precise data bus error. Address: ${bfar ?? 'unknown'}`, address: bfar });
	if (bfsr & 0x04) issues.push({ type: 'BusFault', bit: 'IMPRECISERR', desc: 'Imprecise bus error from buffered write. Check DMA and async accesses.' });
	if (bfsr & 0x08) issues.push({ type: 'BusFault', bit: 'UNSTKERR', desc: 'Bus error during stack unwind. Possible stack overflow.' });
	if (bfsr & 0x10) issues.push({ type: 'BusFault', bit: 'STKERR', desc: 'Bus error during stack push. Stack pointer is corrupted.' });

	// MMFSR bits 7:0 of CFSR
	const mmfsr = cfsr & 0xFF;
	if (mmfsr & 0x01) issues.push({ type: 'MemManage', bit: 'IACCVIOL', desc: 'Instruction fetch MPU violation. Check MPU configuration.' });
	if (mmfsr & 0x02) issues.push({ type: 'MemManage', bit: 'DACCVIOL', desc: `Data access MPU violation. Address: ${mmfar ?? 'unknown'}`, address: mmfar });
	if (mmfsr & 0x08) issues.push({ type: 'MemManage', bit: 'MUNSTKERR', desc: 'MPU violation during stack unwind.' });
	if (mmfsr & 0x10) issues.push({ type: 'MemManage', bit: 'MSTKERR', desc: 'MPU violation during stack push.' });

	// HFSR
	const hfsrIssues = [];
	if (hfsr !== null) {
		if (hfsr & 0x40000000) hfsrIssues.push('FORCED: Another fault escalated to HardFault. Check CFSR for details.');
		if (hfsr & 0x00000002) hfsrIssues.push('VECTTBL: Vector table fetch error. Invalid vector table address.');
		if (hfsr & 0x80000000) hfsrIssues.push('DEBUGEVT: Caused by debug event.');
	}

	const priority = issues.length > 0
		? issues.map(i => `[${i.type}/${i.bit}] ${i.desc}`).join('\n')
		: 'CFSR=0x00000000: No explicit fault bits set. Check HFSR FORCED bit.';

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
		recs.push('Check function pointer Thumb bit (LSB=1).');
		recs.push('PC may be corrupted by stack overflow. Check stack size.');
	}
	if (issues.some(i => i.type === 'BusFault' && i.bit === 'PRECISERR')) {
		recs.push(`Check BFAR address (${issues.find(i => i.bit === 'PRECISERR')?.address ?? 'unknown'}). Possible NULL pointer or out-of-bounds access.`);
	}
	if (issues.some(i => i.bit === 'STKERR' || i.bit === 'UNSTKERR')) {
		recs.push('Increase FreeRTOS task stack size and check with uxTaskGetStackHighWaterMark().');
	}
	if (issues.some(i => i.bit === 'DIVBYZERO')) {
		recs.push('Verify divisor is non-zero before division.');
	}
	if (issues.length === 0) {
		recs.push('Read SCB->CFSR/HFSR/MMFAR/BFAR directly using CubeProgrammer or GDB.');
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
	const wsRoot = resolveWorkspacePath(params);
	const programmerResolution = resolveProgrammerCliCommand(params.programmerPath, wsRoot);
	const programmer = programmerResolution.programmerCmd;
	const result = await detectStLink(programmer);
	if (!result.connected) {
		return {
			success: false,
			connected: false,
			programmerPath: programmer,
			programmerResolved: programmer,
			resolutionTried: programmerResolution.tried,
			stdout: result.stdout,
			stderr: result.stderr,
			attemptLog: result.attemptLog,
			error: result.error ?? 'ST-LINK not detected',
			troubleshooting: [
				'1. Check ST-LINK cable connection',
				'2. Check target board power',
				'3. Verify STM32_Programmer_CLI is installed',
				'4. Check ST-LINK driver installation',
				'5. Verify target voltage (VAPP)',
				'6. Try running manually: ' + programmer + ' -c port=SWD -l'
			].join('\n')
		};
	}
	return {
		success: true,
		connected: true,
		programmerPath: programmer,
		programmerResolved: programmer,
		resolutionTried: programmerResolution.tried,
		stdout: result.stdout,
		stderr: result.stderr,
		attemptLog: result.attemptLog,
		interface: result.interface,
		board: result.board,
		sn: result.sn
	};
}

async function toolValidateEnvironment(params) {
	const wsRoot = resolveWorkspacePath(params);
	const makeResolution = resolveMakeCommand(getConfigValue('makePath', ['STM32_MAKE_PATH', 'MAKE_PATH'], wsRoot));
	const gccResolution = resolveArmGccCommand(wsRoot);
	const cubemxResolution = resolveCubeMxCommand(getConfigValue('cubemxPath', ['STM32_CUBEMX_PATH', 'STM32CUBEMX_PATH'], wsRoot), wsRoot);
	const programmerResolution = resolveProgrammerCliCommand(getConfigValue('programmerPath', ['STM32_PROGRAMMER_PATH'], wsRoot), wsRoot);
	const buildDir = findBuildDirectoryWithMakefile(wsRoot);
	const iocPath = selectPreferredIocPath(wsRoot);
	const probeHardware = params?.probeHardware !== false;

	let stlink = null;
	if (probeHardware) {
		stlink = await detectStLink(programmerResolution.programmerCmd);
	}

	const checks = {
		workspaceExists: isExistingDirectory(wsRoot),
		iocFound: Boolean(iocPath && isExistingFile(iocPath)),
		buildDirFound: Boolean(buildDir),
		makeFound: Boolean(makeResolution.makeCmd && (path.isAbsolute(makeResolution.makeCmd) ? isExistingFile(makeResolution.makeCmd) : true)),
		gccFound: Boolean(gccResolution.gccCmd && isExistingFile(gccResolution.gccCmd)),
		cubemxFound: Boolean(cubemxResolution.cubemxCmd && isExistingFile(cubemxResolution.cubemxCmd)),
		programmerFound: Boolean(programmerResolution.programmerCmd && (path.isAbsolute(programmerResolution.programmerCmd) ? isExistingFile(programmerResolution.programmerCmd) : true)),
		stlinkConnected: stlink ? Boolean(stlink.connected) : null,
	};

	const readiness = {
		forGenerate: checks.workspaceExists && checks.iocFound && checks.cubemxFound,
		forBuild: checks.workspaceExists && checks.gccFound && (checks.makeFound || !checks.buildDirFound),
		forFlash: checks.workspaceExists && checks.programmerFound && (stlink ? stlink.connected : false),
	};

	const issues = [];
	const recommendations = [];

	if (!checks.workspaceExists) {
		issues.push('Workspace directory does not exist');
		recommendations.push('Verify workspace path is correct');
	}
	if (!checks.iocFound) {
		issues.push('.ioc file not found in workspace');
		recommendations.push('Create .ioc file using STM32CubeMX or stm32.createIocFromPins tool');
	}
	if (!checks.makeFound) {
		issues.push('make executable not found');
		recommendations.push('Install STM32CubeCLT or add make to system PATH');
		recommendations.push('Set stm32.makePath in VS Code settings');
	}
	if (!checks.gccFound) {
		issues.push('ARM GCC compiler not found');
		recommendations.push('Install GNU ARM Embedded Toolchain');
		recommendations.push('Add arm-none-eabi-gcc to system PATH');
	}
	if (!checks.cubemxFound) {
		issues.push('STM32CubeMX executable not found');
		recommendations.push('Install STM32CubeMX from st.com');
		recommendations.push('Set stm32.cubemxPath in VS Code settings');
	}
	if (!checks.programmerFound) {
		issues.push('STM32_Programmer_CLI not found');
		recommendations.push('Install STM32CubeProgrammer');
		recommendations.push('Set stm32.programmerPath in VS Code settings');
	}
	if (stlink && !stlink.connected) {
		issues.push('ST-LINK probe not detected');
		recommendations.push('Check ST-LINK cable connection');
		recommendations.push('Verify target board has power');
		recommendations.push('Install ST-LINK drivers');
	}

	return {
		success: true,
		workspacePath: wsRoot,
		iocPath: iocPath ?? null,
		buildDir: buildDir ?? null,
		make: { command: makeResolution.makeCmd, resolved: makeResolution.makeCmd, tried: makeResolution.tried },
		gcc: { command: gccResolution.gccCmd, resolved: gccResolution.gccCmd, tried: gccResolution.tried },
		cubemx: { command: cubemxResolution.cubemxCmd, resolved: cubemxResolution.cubemxCmd, tried: cubemxResolution.tried },
		programmer: { command: programmerResolution.programmerCmd, resolved: programmerResolution.programmerCmd, tried: programmerResolution.tried },
		checks,
		readiness,
		stlink,
		issues,
		recommendations,
		summary: issues.length === 0
			? 'All tools detected. Environment is ready.'
			: `${issues.length} issue(s) detected. See recommendations for fixes.`
	};
}

async function toolReadRegister(params) {
	const wsRoot = resolveWorkspacePath(params);
	const programmerResolution = resolveProgrammerCliCommand(params.programmerPath, wsRoot);
	const programmer = programmerResolution.programmerCmd;
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
	const candidates = [];
	for (const sub of ['build', 'Debug', 'Release', 'Build']) {
		const dir = path.join(wsRoot, sub);
		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (!file.toLowerCase().endsWith('.elf')) continue;
				const full = path.join(dir, file);
				let mtimeMs = 0;
				try { mtimeMs = fs.statSync(full).mtimeMs; } catch { mtimeMs = 0; }
				candidates.push({ full, mtimeMs });
			}
		} catch (_) { }
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return candidates[0].full;
}

async function detectStLink(programmer) {
	const attemptLog = [];
	// Use ONLY -l to avoid resetting the MCU during connection checks
	const attempts = [
		{ args: ['-l'], iface: 'list-only' },
	];

	let lastOut = '';
	let lastErr = '';
	attemptLog.push(`Programmer path: ${programmer}`);

	for (const attempt of attempts) {
		try {
			const cmdLine = `${programmer} ${attempt.args.join(' ')}`;
			attemptLog.push(`Trying: ${cmdLine}`);
			const { stdout, stderr } = await execFileAsync(programmer, attempt.args, { timeout: 15000 });
			const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
			lastOut = stdout ?? '';
			lastErr = stderr ?? '';
			attemptLog.push(`Result (${attempt.iface}): stdout=${stdout?.length ?? 0} bytes, stderr=${stderr?.length ?? 0} bytes`);
			const hasProbeToken = /ST-?LINK|STLINK|Board\s*:|SN\s*:|Connected to target|Target connected|Device ID|Chip ID|STM32|Memory map|Read out protection/i.test(combined);
			const hasNegativeToken = /No\s+ST-?LINK|No\s+debug\s+probe|not\s+detected|0\s+st-?link|Error: No STM32|failed to connect|Cannot connect/i.test(combined);
			const connected = hasProbeToken && !hasNegativeToken;
			attemptLog.push(`Detection: hasProbe=${hasProbeToken}, hasNegative=${hasNegativeToken}, connected=${connected}`);
			if (connected) {
				const board = combined.match(/(?:Board\s*Name|Board)\s*:\s*(.+)/i)?.[1]?.trim() ?? null;
				const sn = combined.match(/(?:ST-?LINK\s*SN|SN)\s*:\s*([A-Za-z0-9]+)/i)?.[1]?.trim() ?? null;
				attemptLog.push(`SUCCESS: ST-LINK detected via ${attempt.iface}`);
				return { connected: true, interface: attempt.iface, board, sn, stdout, stderr, attemptLog: attemptLog.join('\n') };
			}
		} catch (err) {
			lastOut = err.stdout ?? '';
			lastErr = err.stderr ?? err.message ?? '';
			attemptLog.push(`ERROR (${attempt.iface}): ${err.code ?? 'unknown'} - ${err.message ?? 'no message'}`);
			if (err && err.code === 'ENOENT') {
				attemptLog.push(`Programmer binary not found at: ${programmer}`);
				// Keep trying fallbacks (e.g., st-info) instead of returning immediately.
				continue;
			}
		}
	}

	attemptLog.push('Trying st-info fallback...');
	const stInfoFallback = await detectStLinkViaStInfo();
	if (stInfoFallback.connected) {
		attemptLog.push('SUCCESS: ST-LINK detected via st-info');
		return { ...stInfoFallback, attemptLog: attemptLog.join('\n') };
	}
	attemptLog.push('st-info fallback failed');

	// Final attempt: just check if the programmer binary responds (version check)
	try {
		attemptLog.push('Trying --version check...');
		const { stdout: verOut, stderr: verErr } = await execFileAsync(programmer, ['--version'], { timeout: 8000 });
		const combined = `${verOut ?? ''}\n${verErr ?? ''}`;
		if (/ST-?LINK|STM32|Cube|Programmer/i.test(combined)) {
			lastOut = verOut ?? '';
			lastErr = verErr ?? '';
			attemptLog.push('Programmer binary responds to --version');
		}
	} catch (err) {
		attemptLog.push(`--version check failed: ${err.message ?? 'unknown'}`);
	}

	attemptLog.push('FAILED: No ST-LINK detected by any method');
	return {
		connected: false,
		stdout: lastOut,
		stderr: lastErr,
		error: `No ST-LINK probe found. Programmer CLI='${programmer}', and st-info fallback also failed.`,
		attemptLog: attemptLog.join('\n')
	};
}

async function detectStLinkViaStInfo() {
	const stInfoCmd = resolveCommandFromPath(['st-info']);
	if (!stInfoCmd) {
		return { connected: false, stdout: '', stderr: '', error: 'st-info not found' };
	}
	try {
		const { stdout, stderr } = await execFileAsync(stInfoCmd, ['--probe'], { timeout: 15000 });
		const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
		const connected = /serial|chipid|flash:\s*\d+|sram:\s*\d+/i.test(combined);
		if (!connected) {
			return {
				connected: false,
				stdout,
				stderr,
				error: 'No ST-LINK probe found via st-info --probe.'
			};
		}
		const sn = combined.match(/serial\s*:\s*([A-Fa-f0-9]+)/i)?.[1]?.trim() ?? null;
		return { connected: true, interface: 'st-info', board: null, sn, stdout, stderr };
	} catch (err) {
		return {
			connected: false,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? err.message ?? '',
			error: 'st-info probe failed'
		};
	}
}

function resolveProgrammerCliCommand(configuredPath, workspacePath) {
	const tried = [];

	// Priority 1: Explicit parameter
	const explicit = resolveBinaryCandidate(configuredPath, ['STM32_Programmer_CLI.exe', 'STM32_Programmer_CLI']);
	if (configuredPath) {
		tried.push(`param:${sanitizePathValue(configuredPath)}`);
	}
	if (explicit) {
		return { programmerCmd: explicit, tried };
	}

	// Priority 2: STM32_CUBECLT_PATH environment variable (HIGHEST PRIORITY for CubeCLT)
	const cltRoot = sanitizePathValue(process.env.STM32_CUBECLT_PATH);
	if (cltRoot) {
		tried.push(`env:STM32_CUBECLT_PATH=${cltRoot}`);
		// Try multiple paths within CubeCLT installation
		const cltCandidates = [
			path.join(cltRoot, 'STM32CubeProgrammer', 'bin', process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
			path.join(cltRoot, 'bin', process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
		];
		for (const candidate of cltCandidates) {
			tried.push(`clt:${candidate}`);
			if (fs.existsSync(candidate)) {
				return { programmerCmd: candidate, tried };
			}
		}
	}

	// Priority 3: VS Code settings and environment variables
	const settingCandidates = [
		getConfigValue('programmerPath', ['STM32_PROGRAMMER_PATH', 'STM32_PROGRAMMER_CLI_PATH'], workspacePath),
		getConfigValue('cubeprogrammerPath', ['STM32_CUBEPROGRAMMER_PATH'], workspacePath),
		getConfigValue('cubectlPath', ['STM32_CUBECTL_PATH'], workspacePath),
	].filter(Boolean);

	for (const configured of settingCandidates) {
		tried.push(`settings/env:${configured}`);
		const fromSettings = resolveBinaryCandidate(configured, ['STM32_Programmer_CLI.exe', 'STM32_Programmer_CLI']);
		if (fromSettings) {
			return { programmerCmd: fromSettings, tried };
		}

		// If this points to a folder, try nearby CubeProgrammer locations
		const configuredSanitized = sanitizePathValue(configured);
		if (configuredSanitized) {
			const cfgRoot = fs.existsSync(configuredSanitized) && fs.statSync(configuredSanitized).isFile()
				? path.dirname(configuredSanitized)
				: configuredSanitized;
			const siblingCandidates = [
				path.join(cfgRoot, 'STM32CubeProgrammer', 'bin', process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
				path.join(path.dirname(cfgRoot), 'STM32CubeProgrammer', 'bin', process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
				path.join(cfgRoot, 'bin', process.platform === 'win32' ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
			];
			for (const sibling of siblingCandidates) {
				tried.push(`neighbor:${sibling}`);
				if (fs.existsSync(sibling)) {
					return { programmerCmd: sibling, tried };
				}
			}
		}
	}

	// Priority 4: System PATH
	for (const cmdName of ['STM32_Programmer_CLI.exe', 'STM32_Programmer_CLI']) {
		tried.push(`path:${cmdName}`);
		try {
			const which = process.platform === 'win32'
				? spawnSync('where', [cmdName], { encoding: 'utf8' })
				: spawnSync('which', [cmdName], { encoding: 'utf8' });
			if (which.status === 0 && typeof which.stdout === 'string') {
				const first = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
				if (first && fs.existsSync(first)) {
					return { programmerCmd: first, tried };
				}
			}
		} catch {
			// ignore and continue
		}
	}

	// Priority 5: Common installation paths
	if (process.platform === 'win32') {
		// Check E:\installs\cubeCLT pattern (user's actual installation)
		const driveLetters = ['E', 'D', 'C'];
		for (const drive of driveLetters) {
			const installsPath = `${drive}:/installs/cubeCLT`;
			if (fs.existsSync(installsPath)) {
				tried.push(`scanning:${installsPath}`);
				try {
					const entries = fs.readdirSync(installsPath);
					for (const entry of entries) {
						if (entry.startsWith('STM32CubeCLT')) {
							const candidate = path.join(installsPath, entry, 'STM32CubeProgrammer', 'bin', 'STM32_Programmer_CLI.exe');
							tried.push(`installs:${candidate}`);
							if (fs.existsSync(candidate)) {
								return { programmerCmd: candidate, tried };
							}
						}
					}
				} catch { /* ignore */ }
			}
		}

		const winCandidates = [
			'E:/installs/CubeProg/bin/STM32_Programmer_CLI.exe',
			'C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI.exe',
			'C:/Program Files (x86)/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI.exe',
			'C:/ST/STM32CubeProgrammer/bin/STM32_Programmer_CLI.exe',
		];
		for (const candidate of winCandidates) {
			tried.push(`candidate:${candidate}`);
			if (fs.existsSync(candidate)) {
				return { programmerCmd: candidate, tried };
			}
		}

		const fromCubeIde = findProgrammerCliFromCubeIde();
		if (fromCubeIde) {
			tried.push(`cubeide:${fromCubeIde}`);
			return { programmerCmd: fromCubeIde, tried };
		}
	}

	const fallback = findExecutable('STM32_Programmer_CLI');
	tried.push(`fallback:${fallback}`);
	return { programmerCmd: fallback, tried };
}

function findProgrammerCliFromCubeIde() {
	if (process.platform !== 'win32') {
		return null;
	}
	const roots = [
		'C:/ST/STM32CubeIDE',
		'C:/Program Files/STMicroelectronics/STM32CubeIDE',
		'C:/Program Files (x86)/STMicroelectronics/STM32CubeIDE',
	];

	for (const root of roots) {
		if (!isExistingDirectory(root)) {
			continue;
		}
		let versions = [];
		try {
			versions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name));
		} catch {
			versions = [];
		}
		for (const baseDir of versions) {
			const pluginsDir = path.join(baseDir, 'plugins');
			if (!isExistingDirectory(pluginsDir)) {
				continue;
			}
			let entries = [];
			try {
				entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
			} catch {
				entries = [];
			}
			for (const entry of entries) {
				const pluginPath = path.join(pluginsDir, entry.name);
				if (!/cubeprogrammer|programmer/i.test(entry.name)) {
					continue;
				}
				const candidate = path.join(pluginPath, 'tools', 'bin', 'STM32_Programmer_CLI.exe');
				if (isExistingFile(candidate)) {
					return candidate;
				}
			}
		}
	}

	return null;
}

function resolveCommandFromPath(commandNames) {
	for (const cmdName of commandNames) {
		try {
			const which = process.platform === 'win32'
				? spawnSync('where', [cmdName], { encoding: 'utf8' })
				: spawnSync('which', [cmdName], { encoding: 'utf8' });
			if (which.status === 0 && typeof which.stdout === 'string') {
				const first = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
				if (first && fs.existsSync(first)) {
					return first;
				}
			}
		} catch {
			// ignore and continue
		}
	}
	return null;
}

function resolveArmObjcopyCommand(workspacePath) {
	const gccResolution = resolveArmGccCommand(workspacePath);
	if (gccResolution.gccCmd) {
		const candidate = path.join(path.dirname(gccResolution.gccCmd), process.platform === 'win32' ? 'arm-none-eabi-objcopy.exe' : 'arm-none-eabi-objcopy');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return resolveCommandFromPath(['arm-none-eabi-objcopy.exe', 'arm-none-eabi-objcopy']);
}

function getBuildStampPath(wsRoot) {
	return path.join(wsRoot, '.mcp-last-build.json');
}

function getDirtyBuildStatePath(wsRoot) {
	return path.join(wsRoot, '.mcp-dirty-build-state.json');
}

function writeLastBuildStamp(wsRoot, data) {
	const stampPath = getBuildStampPath(wsRoot);
	fs.writeFileSync(stampPath, JSON.stringify(data, null, 2), 'utf8');
}

function readLastBuildStamp(wsRoot) {
	const stampPath = getBuildStampPath(wsRoot);
	if (!isExistingFile(stampPath)) return null;
	try {
		return JSON.parse(fs.readFileSync(stampPath, 'utf8'));
	} catch {
		return null;
	}
}

function readDirtyBuildState(wsRoot) {
	const statePath = getDirtyBuildStatePath(wsRoot);
	if (!isExistingFile(statePath)) {
		return { version: 1, files: [], updatedAt: null };
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
		if (!parsed || !Array.isArray(parsed.files)) {
			return { version: 1, files: [], updatedAt: null };
		}
		return {
			version: 1,
			files: parsed.files.filter(entry => entry && typeof entry.path === 'string'),
			updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
		};
	} catch {
		return { version: 1, files: [], updatedAt: null };
	}
}

function writeDirtyBuildState(wsRoot, state) {
	const statePath = getDirtyBuildStatePath(wsRoot);
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function clearDirtyBuildState(wsRoot) {
	const statePath = getDirtyBuildStatePath(wsRoot);
	try {
		if (isExistingFile(statePath)) {
			fs.unlinkSync(statePath);
		}
	} catch {
		// ignore cleanup failure
	}
}

function markWorkspaceFileDirty(wsRoot, absPath, reason = 'write') {
	const rel = path.relative(wsRoot, absPath).replace(/\\/g, '/');
	if (!rel || rel.startsWith('..')) {
		return;
	}

	const state = readDirtyBuildState(wsRoot);
	const nowIso = new Date().toISOString();
	const next = state.files.filter(entry => entry.path !== rel);
	next.push({ path: rel, reason, at: nowIso });
	writeDirtyBuildState(wsRoot, {
		version: 1,
		updatedAt: nowIso,
		files: next,
	});
}

function bumpFileMtimeForward(absPath, plusMs = 2500) {
	try {
		const now = Date.now() + plusMs;
		const dt = new Date(now);
		fs.utimesSync(absPath, dt, dt);
	} catch {
		// ignore on unsupported file systems
	}
}

function collectObjectFilesInBuildDir(buildDir) {
	const found = [];
	const stack = [buildDir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile() && entry.name.toLowerCase().endsWith('.o')) {
				found.push(full);
			}
		}
	}
	return found;
}

function prepareBuildForRecentWrites(wsRoot, buildDir, params) {
	const state = readDirtyBuildState(wsRoot);
	const dirtyEntries = [];
	for (const entry of state.files) {
		try {
			const absPath = safeResolvePath(wsRoot, entry.path);
			if (!isExistingFile(absPath)) {
				continue;
			}
			dirtyEntries.push({ ...entry, absPath });
		} catch {
			// ignore invalid dirty-state path entries
		}
	}

	const forceRebuildByParam = params?.forceRebuild === true;
	if (dirtyEntries.length === 0 && !forceRebuildByParam) {
		return {
			forceRebuild: false,
			reason: 'no recent writes',
			dirtyFiles: [],
			deletedObjects: 0,
		};
	}

	for (const entry of dirtyEntries) {
		bumpFileMtimeForward(entry.absPath);
	}

	const broadInvalidation = dirtyEntries.some(entry => /\.(h|hpp|ioc|ld)$/i.test(entry.path));
	const objects = collectObjectFilesInBuildDir(buildDir);
	let deletedObjects = 0;

	if (broadInvalidation) {
		for (const objPath of objects) {
			try {
				fs.unlinkSync(objPath);
				deletedObjects += 1;
			} catch {
				// ignore deletion errors
			}
		}
	} else {
		const targetObjectNames = new Set(
			dirtyEntries
				.filter(entry => /\.(c|cpp|s)$/i.test(entry.path))
				.map(entry => `${path.basename(entry.path, path.extname(entry.path))}.o`)
		);
		for (const objPath of objects) {
			if (!targetObjectNames.has(path.basename(objPath))) {
				continue;
			}
			try {
				fs.unlinkSync(objPath);
				deletedObjects += 1;
			} catch {
				// ignore deletion errors
			}
		}
	}

	return {
		forceRebuild: true,
		reason: forceRebuildByParam ? 'forceRebuild parameter' : 'recent MCP writes',
		dirtyFiles: dirtyEntries.map(entry => entry.path),
		deletedObjects,
	};
}

function isStaleBuildArtifact(wsRoot, elfPath) {
	try {
		if (!isExistingFile(elfPath)) return true;
		const elfMtime = fs.statSync(elfPath).mtimeMs;
		let newestSource = 0;
		for (const sub of ['Core', 'Src', 'Inc']) {
			const dir = path.join(wsRoot, sub);
			if (!isExistingDirectory(dir)) continue;
			const stack = [dir];
			while (stack.length > 0) {
				const current = stack.pop();
				let entries = [];
				try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { entries = []; }
				for (const e of entries) {
					const full = path.join(current, e.name);
					if (e.isDirectory()) {
						stack.push(full);
						continue;
					}
					if (!/\.(c|h|s|ld|ioc)$/i.test(e.name)) continue;
					let mt = 0;
					try { mt = fs.statSync(full).mtimeMs; } catch { mt = 0; }
					if (mt > newestSource) newestSource = mt;
				}
			}
		}
		return newestSource > elfMtime;
	} catch {
		return true;
	}
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
				'E:/installs/CubeMX/STM32CubeMX.exe',
				localAppData ? `${localAppData.replace(/\\/g, '/')}/Programs/STM32CubeMX/STM32CubeMX.exe` : null,
				'C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/STM32CubeMX.exe',
				'C:/ST/STM32CubeMX/STM32CubeMX.exe',
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
	const expectedNames = Array.isArray(binaryNames) ? binaryNames.map(name => String(name).toLowerCase()) : [];
	const fileNameMatches = (filePath) => {
		if (expectedNames.length === 0) {
			return true;
		}
		const base = path.basename(filePath).toLowerCase();
		return expectedNames.includes(base);
	};
	if (fs.existsSync(candidate)) {
		const stat = fs.statSync(candidate);
		if (stat.isFile()) {
			return fileNameMatches(candidate) ? candidate : null;
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
		if (fs.existsSync(exeCandidate) && fs.statSync(exeCandidate).isFile() && fileNameMatches(exeCandidate)) {
			return exeCandidate;
		}
	}
	return null;
}

function parseJsonLikeSettings(content) {
	if (typeof content !== 'string' || content.trim().length === 0) {
		return {};
	}

	const src = content;
	let out = '';
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		const next = i + 1 < src.length ? src[i + 1] : '';

		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
				out += ch;
			}
			continue;
		}

		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}

		if (inString) {
			out += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i += 1;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}

		out += ch;
	}

	const normalized = out.replace(/,\s*([}\]])/g, '$1');
	try {
		return JSON.parse(normalized);
	} catch {
		return {};
	}
}

function getUserVscodeSettingsCandidates() {
	const appData = sanitizePathValue(process.env.APPDATA);
	const userHome = sanitizePathValue(process.env.USERPROFILE || process.env.HOME);
	const candidates = [];

	if (appData) {
		candidates.push(path.join(appData, 'Code', 'User', 'settings.json'));
		candidates.push(path.join(appData, 'Code - Insiders', 'User', 'settings.json'));
		candidates.push(path.join(appData, 'VSCodium', 'User', 'settings.json'));
	}

	if (userHome) {
		candidates.push(path.join(userHome, '.config', 'Code', 'User', 'settings.json'));
		candidates.push(path.join(userHome, '.config', 'Code - Insiders', 'User', 'settings.json'));
		candidates.push(path.join(userHome, '.config', 'VSCodium', 'User', 'settings.json'));
	}

	const unique = [];
	const seen = new Set();
	for (const p of candidates) {
		const abs = path.resolve(p);
		const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(abs);
	}
	return unique;
}

function loadUserVscodeSettings() {
	for (const settingsPath of getUserVscodeSettingsCandidates()) {
		try {
			if (!fs.existsSync(settingsPath)) {
				continue;
			}
			const content = fs.readFileSync(settingsPath, 'utf8');
			const parsed = parseJsonLikeSettings(content);
			if (parsed && typeof parsed === 'object') {
				return parsed;
			}
		} catch {
			// try next candidate
		}
	}
	return {};
}

function getSettingKeyCandidates(configKey) {
	const base = String(configKey ?? '').trim();
	if (!base) {
		return [];
	}
	const lower = base.charAt(0).toLowerCase() + base.slice(1);
	const stem = lower.endsWith('Path') ? lower.slice(0, -4) : lower;
	const keys = new Set([
		`stm32.${base}`,
		`stm32.${lower}`,
		`stm32.${stem}`,
		`stm32.${stem}.path`,
	]);

	if (base === 'cubemxPath') {
		keys.add('stm32.cubemx.path');
	}
	if (base === 'programmerPath') {
		keys.add('stm32.programmer.path');
		keys.add('stm32.cubeprogrammer.path');
		keys.add('stm32.cubectl.path');
	}
	if (base === 'armGccPath') {
		keys.add('stm32.armgcc.path');
		keys.add('stm32.gcc.path');
	}
	if (base === 'makePath') {
		keys.add('stm32.make.path');
	}

	return Array.from(keys);
}

function readFirstSettingValue(settings, settingKeys) {
	if (!settings || typeof settings !== 'object') {
		return null;
	}
	for (const key of settingKeys) {
		const value = sanitizePathValue(settings[key]);
		if (value) {
			return value;
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
		return parseJsonLikeSettings(content);
	} catch {
		return {};
	}
}

/** Get a configuration value with environment variable fallback */
function getConfigValue(configKey, envVarNames, workspacePath) {
	const settingKeys = getSettingKeyCandidates(configKey);

	const primarySettings = loadVscodeSettings(workspacePath);
	const primaryValue = readFirstSettingValue(primarySettings, settingKeys);
	if (primaryValue) {
		return primaryValue;
	}

	if (workspacePath && path.resolve(workspacePath) !== path.resolve(WORKSPACE)) {
		const fallbackSettings = loadVscodeSettings(WORKSPACE);
		const fallbackValue = readFirstSettingValue(fallbackSettings, settingKeys);
		if (fallbackValue) {
			return fallbackValue;
		}
	}

	const userSettings = loadUserVscodeSettings();
	const userValue = readFirstSettingValue(userSettings, settingKeys);
	if (userValue) {
		return userValue;
	}

	for (const envVarName of envVarNames ?? []) {
		const envValue = sanitizePathValue(process.env[envVarName]);
		if (envValue) {
			return envValue;
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

function isLikelyCubeMxMakefile(makefilePath) {
	if (!isExistingFile(makefilePath)) {
		return false;
	}

	try {
		const content = fs.readFileSync(makefilePath, 'utf8');
		return /objects\.list|subdir\.mk|C_SOURCES\s*=|ASM_SOURCES\s*=|LDSCRIPT\s*=|Drivers\/CMSIS|Drivers\/STM32/i.test(content);
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
		if (isExistingDirectory(dir) && isLikelyCubeMxMakefile(path.join(dir, 'Makefile'))) {
			return dir;
		}
	}

	try {
		const level1 = fs.readdirSync(wsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
		const skipDirs = new Set(['node_modules', '.git', '.vscode', '.tmp', 'out', 'dist']);
		for (const entry of level1) {
			if (skipDirs.has(entry.name)) {
				continue;
			}
			const dir = path.join(wsRoot, entry.name);
			if (isLikelyCubeMxMakefile(path.join(dir, 'Makefile'))) {
				return dir;
			}
			try {
				const level2 = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
				for (const entry2 of level2) {
					if (skipDirs.has(entry2.name)) {
						continue;
					}
					const dir2 = path.join(dir, entry2.name);
					if (isLikelyCubeMxMakefile(path.join(dir2, 'Makefile'))) {
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

function normalizeRelPath(relPath) {
	return String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function detectPreferredSourceRoots(wsRoot, buildDir) {
	const sourceCandidates = ['Core/Src', 'Src'];
	const includeCandidates = ['Core/Inc', 'Inc'];

	const sourceFromBuild = detectRootFromBuildArtifacts(buildDir, sourceCandidates);
	const includeFromBuild = detectRootFromBuildArtifacts(buildDir, includeCandidates);
	const sourceFromFreshFiles = detectRootFromFreshGeneratedFiles(wsRoot, sourceCandidates, 'main.c');
	const includeFromFreshFiles = detectRootFromFreshGeneratedFiles(wsRoot, includeCandidates, 'main.h');

	const sourceRoot = sourceFromBuild
		?? sourceFromFreshFiles
		?? (isExistingDirectory(path.join(wsRoot, 'Core', 'Src')) ? 'Core/Src' : (isExistingDirectory(path.join(wsRoot, 'Src')) ? 'Src' : 'Core/Src'));
	const includeRoot = includeFromBuild
		?? includeFromFreshFiles
		?? (isExistingDirectory(path.join(wsRoot, 'Core', 'Inc')) ? 'Core/Inc' : (isExistingDirectory(path.join(wsRoot, 'Inc')) ? 'Inc' : 'Core/Inc'));

	return { sourceRoot, includeRoot };
}

function detectRootFromFreshGeneratedFiles(wsRoot, rootCandidates, markerFileName) {
	let bestRoot = null;
	let bestMtime = -1;

	for (const root of rootCandidates) {
		const probe = path.join(wsRoot, root, markerFileName);
		if (!isExistingFile(probe)) {
			continue;
		}
		let mtime = 0;
		try {
			mtime = fs.statSync(probe).mtimeMs;
		} catch {
			mtime = 0;
		}
		if (!bestRoot || mtime >= bestMtime) {
			bestRoot = root;
			bestMtime = mtime;
		}
	}

	return bestRoot;
}

function detectRootFromBuildArtifacts(buildDir, rootCandidates) {
	if (!buildDir || !isExistingDirectory(buildDir)) {
		return null;
	}
	const probeFiles = [
		path.join(buildDir, 'objects.list'),
		path.join(buildDir, 'sources.mk'),
		path.join(buildDir, 'subdir.mk'),
		path.join(buildDir, 'makefile'),
		path.join(buildDir, 'Makefile'),
	];

	for (const probe of probeFiles) {
		if (!isExistingFile(probe)) {
			continue;
		}
		let content = '';
		try {
			content = fs.readFileSync(probe, 'utf8');
		} catch {
			continue;
		}
		for (const candidate of rootCandidates) {
			const escaped = candidate.replace('/', '[\\/]');
			if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}[\\/]`, 'm').test(content)) {
				return candidate;
			}
		}
	}

	return null;
}

function mapToPreferredTree(relPath, preferredRoots) {
	const rel = normalizeRelPath(relPath);
	if (rel.startsWith('Core/Src/')) {
		return preferredRoots.sourceRoot === 'Src' ? `Src/${rel.slice('Core/Src/'.length)}` : rel;
	}
	if (rel.startsWith('Src/')) {
		return preferredRoots.sourceRoot === 'Core/Src' ? `Core/Src/${rel.slice('Src/'.length)}` : rel;
	}
	if (rel.startsWith('Core/Inc/')) {
		return preferredRoots.includeRoot === 'Inc' ? `Inc/${rel.slice('Core/Inc/'.length)}` : rel;
	}
	if (rel.startsWith('Inc/')) {
		return preferredRoots.includeRoot === 'Core/Inc' ? `Core/Inc/${rel.slice('Inc/'.length)}` : rel;
	}
	return rel;
}

function getCounterpartRelPath(relPath) {
	const rel = normalizeRelPath(relPath);
	if (rel.startsWith('Core/Src/')) return `Src/${rel.slice('Core/Src/'.length)}`;
	if (rel.startsWith('Src/')) return `Core/Src/${rel.slice('Src/'.length)}`;
	if (rel.startsWith('Core/Inc/')) return `Inc/${rel.slice('Core/Inc/'.length)}`;
	if (rel.startsWith('Inc/')) return `Core/Inc/${rel.slice('Inc/'.length)}`;
	return null;
}

function syncEditedFileToCounterpart(wsRoot, effectiveRelPath) {
	const counterpartRel = getCounterpartRelPath(effectiveRelPath);
	if (!counterpartRel) {
		return [];
	}
	const srcAbs = safeResolvePath(wsRoot, effectiveRelPath);
	const dstAbs = safeResolvePath(wsRoot, counterpartRel);
	if (!isExistingFile(srcAbs)) {
		return [];
	}

	if (!isExistingDirectory(path.dirname(dstAbs)) && !isExistingFile(dstAbs)) {
		return [];
	}

	try {
		fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
		fs.copyFileSync(srcAbs, dstAbs);
		bumpFileMtimeForward(dstAbs);
		markWorkspaceFileDirty(wsRoot, dstAbs, 'counterpartSync');
		return [counterpartRel];
	} catch {
		return [];
	}
}

function synchronizeCriticalDuplicateFiles(wsRoot, preferredRoots) {
	const pairs = [
		['Core/Src/main.c', 'Src/main.c', preferredRoots.sourceRoot === 'Core/Src' ? 'Core/Src/main.c' : 'Src/main.c'],
		['Core/Inc/main.h', 'Inc/main.h', preferredRoots.includeRoot === 'Core/Inc' ? 'Core/Inc/main.h' : 'Inc/main.h'],
	];

	const changed = [];
	for (const [aRel, bRel, canonicalRel] of pairs) {
		const aAbs = safeResolvePath(wsRoot, aRel);
		const bAbs = safeResolvePath(wsRoot, bRel);
		if (!isExistingFile(aAbs) || !isExistingFile(bAbs)) {
			continue;
		}
		let aText = '';
		let bText = '';
		try {
			aText = fs.readFileSync(aAbs, 'utf8');
			bText = fs.readFileSync(bAbs, 'utf8');
		} catch {
			continue;
		}
		if (aText === bText) {
			continue;
		}

		const srcRel = canonicalRel;
		const dstRel = canonicalRel === aRel ? bRel : aRel;
		const srcAbs = safeResolvePath(wsRoot, srcRel);
		const dstAbs = safeResolvePath(wsRoot, dstRel);
		try {
			fs.copyFileSync(srcAbs, dstAbs);
			bumpFileMtimeForward(dstAbs);
			markWorkspaceFileDirty(wsRoot, dstAbs, 'preBuildDuplicateSync');
			changed.push({ source: srcRel, target: dstRel });
		} catch {
			// ignore sync failure
		}
	}

	return { changedCount: changed.length, changes: changed };
}

function syncGeneratedArtifactsToCounterparts(wsRoot, projectArtifacts) {
	const synced = [];
	const skipped = [];

	const mainCRel = projectArtifacts?.mainC ? normalizeRelPath(path.relative(wsRoot, projectArtifacts.mainC)) : null;
	const mainHRel = projectArtifacts?.mainH ? normalizeRelPath(path.relative(wsRoot, projectArtifacts.mainH)) : null;
	const sourceRoot = mainCRel ? mainCRel.replace(/\/main\.c$/i, '') : null;
	const includeRoot = mainHRel ? mainHRel.replace(/\/main\.h$/i, '') : null;
	const sourceCounterpartRoot = sourceRoot ? getCounterpartRelPath(`${sourceRoot}/main.c`)?.replace(/\/main\.c$/i, '') : null;
	const includeCounterpartRoot = includeRoot ? getCounterpartRelPath(`${includeRoot}/main.h`)?.replace(/\/main\.h$/i, '') : null;

	const filePairs = [];
	if (sourceRoot && sourceCounterpartRoot) {
		for (const rel of listTreeFiles(wsRoot, sourceRoot, ['.c'])) {
			filePairs.push({ srcRel: rel, dstRel: `${sourceCounterpartRoot}/${path.basename(rel)}` });
		}
	}
	if (includeRoot && includeCounterpartRoot) {
		for (const rel of listTreeFiles(wsRoot, includeRoot, ['.h'])) {
			filePairs.push({ srcRel: rel, dstRel: `${includeCounterpartRoot}/${path.basename(rel)}` });
		}
	}

	for (const pair of filePairs) {
		const srcAbs = safeResolvePath(wsRoot, pair.srcRel);
		const dstAbs = safeResolvePath(wsRoot, pair.dstRel);
		try {
			if (!isExistingFile(srcAbs)) {
				continue;
			}

			// For C files, avoid overwriting manual/custom counterpart files.
			if (path.extname(pair.dstRel).toLowerCase() === '.c' && isExistingFile(dstAbs)) {
				const dstText = fs.readFileSync(dstAbs, 'utf8');
				const looksGenerated = /\/\*\s*USER CODE BEGIN\s+/i.test(dstText) || /\*\s*@file\s*:/i.test(dstText);
				if (!looksGenerated) {
					skipped.push(pair.dstRel);
					continue;
				}
			}

			fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
			fs.copyFileSync(srcAbs, dstAbs);
			bumpFileMtimeForward(dstAbs);
			markWorkspaceFileDirty(wsRoot, dstAbs, 'regenerateSync');
			synced.push(pair.dstRel);
		} catch {
			// best effort
		}
	}
	return { synced, skipped };
}

function listTreeFiles(wsRoot, relDir, extensions) {
	const out = [];
	const dirAbs = safeResolvePath(wsRoot, relDir);
	if (!isExistingDirectory(dirAbs)) {
		return out;
	}
	let entries = [];
	try {
		entries = fs.readdirSync(dirAbs, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const ext = path.extname(entry.name).toLowerCase();
		if (!extensions.includes(ext)) {
			continue;
		}
		out.push(normalizeRelPath(`${relDir}/${entry.name}`));
	}
	return out;
}

function findLatestCubeFwPackageForFamily(familyName) {
	const userProfile = process.env.USERPROFILE ?? '';
	const homeCombined = `${process.env.HOMEDRIVE ?? ''}${process.env.HOMEPATH ?? ''}`;
	const candidates = [
		path.join(userProfile, 'STM32Cube.Repository'),
		path.join(userProfile, 'STM32Cube', 'Repository'),
		path.join(homeCombined, 'STM32Cube.Repository'),
		path.join(homeCombined, 'STM32Cube', 'Repository'),
	];
	let repoRoot = candidates.find(isExistingDirectory);
	if (!repoRoot && process.platform === 'win32') {
		try {
			const usersRoot = 'C:\\Users';
			for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
				if (!entry.isDirectory()) {
					continue;
				}
				const probe = path.join(usersRoot, entry.name, 'STM32Cube', 'Repository');
				if (isExistingDirectory(probe)) {
					repoRoot = probe;
					break;
				}
			}
		} catch {
			// ignore probe errors and fall through to null handling
		}
	}
	if (!repoRoot) {
		return null;
	}

	const family = (familyName ?? '').toUpperCase();
	const token = `STM32CUBE_FW_${family}_V`;
	let best = null;
	let bestName = '';
	try {
		const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const nameUpper = entry.name.toUpperCase();
			if (!nameUpper.startsWith(token)) {
				continue;
			}
			if (!best || nameUpper > bestName) {
				best = path.join(repoRoot, entry.name);
				bestName = nameUpper;
			}
		}
	} catch {
		return null;
	}
	return best;
}

function findFileRecursive(rootDir, matcher, maxDepth = 6, depth = 0) {
	if (depth > maxDepth || !isExistingDirectory(rootDir)) {
		return null;
	}
	let entries = [];
	try {
		entries = fs.readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return null;
	}

	for (const entry of entries) {
		const full = path.join(rootDir, entry.name);
		if (entry.isFile() && matcher(entry.name, full)) {
			return full;
		}
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		if (entry.name === '.git' || entry.name === 'node_modules') {
			continue;
		}
		const full = path.join(rootDir, entry.name);
		const found = findFileRecursive(full, matcher, maxDepth, depth + 1);
		if (found) {
			return found;
		}
	}
	return null;
}

function selectPreferredIocPath(wsRoot) {
	if (!isExistingDirectory(wsRoot)) {
		return null;
	}
	const iocFiles = fs.readdirSync(wsRoot).filter(e => e.toLowerCase().endsWith('.ioc'));
	if (iocFiles.length === 0) {
		return null;
	}
	if (iocFiles.length === 1) {
		return path.join(wsRoot, iocFiles[0]);
	}

	const configuredIoc = getConfigValue('iocPath', ['STM32_IOC_PATH'], wsRoot);
	if (configuredIoc) {
		const fullConfigured = path.isAbsolute(configuredIoc)
			? configuredIoc
			: safeResolvePath(wsRoot, configuredIoc);
		if (isExistingFile(fullConfigured) && path.extname(fullConfigured).toLowerCase() === '.ioc') {
			return fullConfigured;
		}
	}

	const sorted = iocFiles
		.map(f => {
			const full = path.join(wsRoot, f);
			let mtimeMs = 0;
			try { mtimeMs = fs.statSync(full).mtimeMs; } catch { mtimeMs = 0; }
			return { full, mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (sorted.length >= 2 && sorted[0].mtimeMs === sorted[1].mtimeMs) {
		const dirBase = path.basename(path.resolve(wsRoot)).toLowerCase();
		const exact = sorted.find(entry => path.basename(entry.full).toLowerCase() === `${dirBase}.ioc`);
		if (exact) {
			return exact.full;
		}
	}

	return sorted[0]?.full ?? null;
}

function parseIocMcuInfo(wsRoot) {
	try {
		const iocPath = selectPreferredIocPath(wsRoot);
		if (!iocPath) {
			return { mcuName: null, family: null };
		}
		const content = fs.readFileSync(iocPath, 'utf8');
		let mcu = (content.match(/^Mcu\.Name=(.+)$/m)?.[1] ?? '').trim();
		let family = (content.match(/^Mcu\.Family=(.+)$/m)?.[1] ?? '').trim();
		if (!mcu) mcu = (content.match(/^Mcu\.CPN=(.+)$/m)?.[1] ?? '').trim();
		if (mcu) {
			mcu = mcu.replace(/[\[\(\)\{\}]/g, '').replace(/\s+/g, '');
		}
		if (!family && mcu) {
			const upper = mcu.toUpperCase();
			const m = upper.match(/^STM32([A-Z][0-9])/);
			if (m) {
				family = `STM32${m[1]}`;
			}
		}
		return { mcuName: mcu || null, family: family || null };
	} catch {
		return { mcuName: null, family: null };
	}
}

/**
 * Derive the GCC -D define symbol for the MCU from the .ioc file.
 * e.g. Mcu.Name=STM32F303K8Tx  -> "STM32F303x8"
 *      Mcu.Name=STM32F767ZITx  -> "STM32F767xx"
 * Falls back to null if the .ioc is not present or unrecognised.
 */
function deriveMcuDefineFromIoc(wsRoot) {
	try {
		const iocPath = selectPreferredIocPath(wsRoot);
		if (!iocPath) { return null; }
		const content = fs.readFileSync(iocPath, 'utf8');
		// Prefer Mcu.Name (e.g. STM32F303K8Tx), fall back to Mcu.CPN
		let mcuRaw = (content.match(/^Mcu\.Name=(.+)$/m)?.[1] ?? '').trim();
		if (!mcuRaw) {
			mcuRaw = (content.match(/^Mcu\.CPN=(.+)$/m)?.[1] ?? '').trim();
		}
		if (!mcuRaw) { return null; }

		// Strip parenthesised variants like STM32F303K(6-8)Tx → take last char of group
		mcuRaw = mcuRaw.replace(/\(([A-Z0-9](?:-[A-Z0-9])*)\)/gi, (_m, chars) => {
			const parts = chars.split('-');
			return parts[parts.length - 1];
		});

		const upper = mcuRaw.toUpperCase();
		// Match STM32<family><line><pin-count><flash-size><package>
		// CubeMX define pattern: STM32F303x8, STM32F767xx, STM32H743xx …
		// The define uses lowercase 'x' for pin-count and sometimes flash-size.
		// Pattern: STM32 + letter + 3 digits + optional-letter + flash-char + rest
		const m = upper.match(/^(STM32[A-Z][0-9]{3}[A-Z]?)([A-Z0-9])([A-Z0-9]*)/);
		if (!m) { return null; }

		const base = m[1];   // e.g. STM32F303, STM32F767
		const flashChar = m[2]; // e.g. K=64K, R=256K, Z=1M — becomes the flash letter in the define
		// The HAL define is base + 'x' + flashChar (lowercase) for specific lines,
		// or base + 'xx' for families where CubeMX uses generic defines.
		// Heuristic: if the base ends in a letter (e.g. STM32F303K), use that letter + flash;
		// otherwise use 'xx'.
		const baseMatch = base.match(/^(STM32[A-Z][0-9]{3})([A-Z])?$/);
		if (!baseMatch) { return null; }
		const family = baseMatch[1];    // STM32F303
		const pinLetter = baseMatch[2]; // K (or undefined)

		if (pinLetter) {
			// Specific: STM32F303K8 → STM32F303x8
			return `${family}x${flashChar.toLowerCase()}`;
		} else {
			// Generic: STM32F767 → STM32F767xx
			return `${family}xx`;
		}
	} catch {
		return null;
	}
}

/**
 * Collect include directories from a project's own Drivers/ subtree
 * (i.e. CubeMX-copied vendor headers in the workspace).
 * Returns an array of absolute paths that exist.
 */
function collectProjectDriverIncludes(wsRoot) {
	const driversRoot = path.join(wsRoot, 'Drivers');
	if (!isExistingDirectory(driversRoot)) { return []; }

	const result = [];
	try {
		const families = fs.readdirSync(driversRoot, { withFileTypes: true });
		for (const entry of families) {
			if (!entry.isDirectory()) { continue; }
			const familyDir = path.join(driversRoot, entry.name);
			// Common patterns: STM32F3xx_HAL_Driver/Inc, CMSIS/Include, CMSIS/Device/ST/STM32F3xx/Include
			const candidates = [
				path.join(familyDir, 'Inc'),
				path.join(familyDir, 'Inc', 'Legacy'),
				path.join(familyDir, 'Include'),
				path.join(familyDir, 'Device', 'ST'),
			];
			for (const c of candidates) {
				if (isExistingDirectory(c)) { result.push(c); }
			}
			// CMSIS/Device/ST/<family>/Include
			if (entry.name.toUpperCase() === 'CMSIS') {
				try {
					const deviceSt = path.join(familyDir, 'Device', 'ST');
					if (isExistingDirectory(deviceSt)) {
						for (const sub of fs.readdirSync(deviceSt, { withFileTypes: true })) {
							if (!sub.isDirectory()) { continue; }
							const incDir = path.join(deviceSt, sub.name, 'Include');
							if (isExistingDirectory(incDir)) { result.push(incDir); }
						}
					}
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }
	return result;
}

function getProjectNameFromIoc(wsRoot) {
	try {
		const iocPath = selectPreferredIocPath(wsRoot);
		if (!iocPath) {
			return path.basename(wsRoot);
		}
		const content = fs.readFileSync(iocPath, 'utf8');
		const projectName = (content.match(/^ProjectManager\.ProjectName=(.+)$/m)?.[1] ?? '').trim();
		return projectName || path.basename(wsRoot);
	} catch {
		return path.basename(wsRoot);
	}
}

async function buildGeneratedProjectWithoutMakefile(wsRoot, gccCmd, env) {
	if (!gccCmd) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: 'No Makefile and no ARM GCC found. Set stm32.armGccPath or STM32_ARM_GCC_PATH.'
		};
	}

	const preBuildHealing = healGeneratedMainFiles(wsRoot);

	const info = parseIocMcuInfo(wsRoot);
	const familyUpper = (info.family ?? '').toUpperCase();
	if (!familyUpper) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: `No Makefile-based build directory found and unable to detect MCU family from IOC. Detected family=${info.family ?? 'unknown'}.`,
			preBuildHealing
		};
	}

	if (familyUpper === 'STM32F7') {
		const result = await buildBareMetalFallbackF7(wsRoot, gccCmd, env, info.mcuName);
		return { ...result, preBuildHealing };
	}

	if (familyUpper !== 'STM32F3') {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: `No Makefile-based build directory found and fallback build currently supports STM32F3/STM32F7 only. Detected family=${info.family ?? 'unknown'}.`,
			preBuildHealing
		};
	}

	const fwRoot = findLatestCubeFwPackageForFamily('F3');
	if (!fwRoot) {
		const mcuUpper = (info.mcuName ?? '').toUpperCase();
		if (mcuUpper === 'STM32F303K8TX') {
			const result = await buildBareMetalFallbackF303K8(wsRoot, gccCmd, env);
			return { ...result, preBuildHealing };
		}
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: 'STM32Cube FW F3 package not found under %USERPROFILE%/STM32Cube/Repository.',
			preBuildHealing
		};
	}

	const cmsisRoot = path.join(fwRoot, 'Drivers', 'CMSIS');
	const deviceRoot = path.join(cmsisRoot, 'Device', 'ST', 'STM32F3xx');
	const halRoot = path.join(fwRoot, 'Drivers', 'STM32F3xx_HAL_Driver');
	const startup = path.join(deviceRoot, 'Source', 'Templates', 'gcc', 'startup_stm32f303x8.s');
	const system = path.join(deviceRoot, 'Source', 'Templates', 'system_stm32f3xx.c');
	if (!isExistingFile(startup) || !isExistingFile(system)) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: `Required CMSIS templates not found: startup=${startup}, system=${system}`,
			preBuildHealing
		};
	}

	const linkerScript = findFileRecursive(
		path.join(fwRoot, 'Projects'),
		(name) => /STM32F303K8.*FLASH\.ld$/i.test(name),
		10
	);
	if (!linkerScript) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: 'Linker script for STM32F303K8 not found in STM32Cube FW F3 package.',
			preBuildHealing
		};
	}

	const preferredRoots = detectPreferredSourceRoots(wsRoot, null);
	const srcDir = path.join(wsRoot, ...preferredRoots.sourceRoot.split('/'));
	if (!isExistingDirectory(srcDir)) {
		return { success: false, exitCode: 1, stdout: '', stderr: `Generated source directory not found: ${srcDir}`, preBuildHealing };
	}

	const projectName = getProjectNameFromIoc(wsRoot);
	const buildDir = path.join(wsRoot, 'Debug');
	const objDir = path.join(buildDir, 'obj');
	fs.mkdirSync(objDir, { recursive: true });

	const mcuDefine = deriveMcuDefineFromIoc(wsRoot) ?? 'STM32F303x8';
	const includeArgs = [
		...Array.from(new Set([
			path.join(wsRoot, ...preferredRoots.includeRoot.split('/')),
			path.join(wsRoot, 'Core', 'Inc'),
			path.join(wsRoot, 'Inc'),
			...collectProjectDriverIncludes(wsRoot),
		].filter(isExistingDirectory))).map(includeDir => `-I${includeDir}`),
		`-I${path.join(halRoot, 'Inc')}`,
		`-I${path.join(halRoot, 'Inc', 'Legacy')}`,
		`-I${path.join(deviceRoot, 'Include')}`,
		`-I${path.join(cmsisRoot, 'Include')}`,
	];

	const commonFlags = [
		'-mcpu=cortex-m4',
		'-mthumb',
		'-O0',
		'-g3',
		'-ffunction-sections',
		'-fdata-sections',
		'-Wall',
		'-DUSE_HAL_DRIVER',
		`-D${mcuDefine}`,
		...includeArgs,
	];

	const halSources = [
		'stm32f3xx_hal.c',
		'stm32f3xx_hal_cortex.c',
		'stm32f3xx_hal_dma.c',
		'stm32f3xx_hal_exti.c',
		'stm32f3xx_hal_flash.c',
		'stm32f3xx_hal_flash_ex.c',
		'stm32f3xx_hal_gpio.c',
		'stm32f3xx_hal_pwr.c',
		'stm32f3xx_hal_pwr_ex.c',
		'stm32f3xx_hal_rcc.c',
		'stm32f3xx_hal_rcc_ex.c',
	];

	const projectSources = fs.readdirSync(srcDir)
		.filter(f => f.toLowerCase().endsWith('.c'))
		.filter((fileName) => {
			const lower = fileName.toLowerCase();
			if (!lower.startsWith('stm32')) {
				return true;
			}
			// Keep only family-matching STM32 support files for this fallback build.
			return /stm32f3/i.test(lower);
		})
		.map(f => path.join(srcDir, f));

	const allCSources = [
		...projectSources,
		system,
		...halSources.map(f => path.join(halRoot, 'Src', f)).filter(isExistingFile),
	];

	const objects = [];
	let buildStdout = '';
	let buildStderr = '';

	for (const src of allCSources) {
		const obj = path.join(objDir, `${path.basename(src, '.c')}.o`);
		try {
			const { stdout, stderr } = await execFileAsync(gccCmd, ['-c', src, '-o', obj, ...commonFlags], { cwd: wsRoot, env, timeout: 120000 });
			buildStdout += stdout ?? '';
			buildStderr += stderr ?? '';
			objects.push(obj);
		} catch (err) {
			return {
				success: false,
				exitCode: err.code ?? 1,
				buildDir,
				stdout: (buildStdout + (err.stdout ?? '')).trim(),
				stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
			};
		}
	}

	const startupObj = path.join(objDir, path.basename(startup, '.s') + '.o');
	try {
		const { stdout, stderr } = await execFileAsync(gccCmd, ['-c', startup, '-o', startupObj, ...commonFlags], { cwd: wsRoot, env, timeout: 120000 });
		buildStdout += stdout ?? '';
		buildStderr += stderr ?? '';
		objects.push(startupObj);
	} catch (err) {
		return {
			success: false,
			exitCode: err.code ?? 1,
			buildDir,
			stdout: (buildStdout + (err.stdout ?? '')).trim(),
			stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
		};
	}

	const elfPath = path.join(buildDir, `${projectName}.elf`);
	try {
		const { stdout, stderr } = await execFileAsync(
			gccCmd,
			[
				...objects,
				'-mcpu=cortex-m4',
				'-mthumb',
				'-Wl,--gc-sections',
				`-Wl,-Map=${path.join(buildDir, `${projectName}.map`)}`,
				`-T${linkerScript}`,
				'-specs=nosys.specs',
				'-specs=nano.specs',
				'-o',
				elfPath,
			],
			{ cwd: wsRoot, env, timeout: 120000 }
		);
		buildStdout += stdout ?? '';
		buildStderr += stderr ?? '';
	} catch (err) {
		return {
			success: false,
			exitCode: err.code ?? 1,
			buildDir,
			stdout: (buildStdout + (err.stdout ?? '')).trim(),
			stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
		};
	}

	return {
		success: true,
		exitCode: 0,
		buildDir,
		stdout: buildStdout.trim(),
		stderr: buildStderr.trim(),
		preBuildHealing
	};
}

async function buildBareMetalFallbackF7(wsRoot, gccCmd, env, mcuName = null) {
	const projectName = getProjectNameFromIoc(wsRoot);
	const buildDir = path.join(wsRoot, 'Debug');
	const objDir = path.join(buildDir, 'obj');
	fs.mkdirSync(objDir, { recursive: true });

	const fwRoot = findLatestCubeFwPackageForFamily('F7');
	if (!fwRoot) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: 'STM32Cube FW F7 package not found under %USERPROFILE%/STM32Cube/Repository.'
		};
	}

	const cmsisRoot = path.join(fwRoot, 'Drivers', 'CMSIS');
	const deviceRoot = path.join(cmsisRoot, 'Device', 'ST', 'STM32F7xx');
	const halRoot = path.join(fwRoot, 'Drivers', 'STM32F7xx_HAL_Driver');
	seedVendorHeaderForProject(wsRoot, path.join(halRoot, 'Inc', 'stm32f7xx_hal.h'), ['Inc/stm32f7xx_hal.h', 'Core/Inc/stm32f7xx_hal.h']);
	seedVendorHeaderForProject(wsRoot, path.join(deviceRoot, 'Include', 'stm32f7xx.h'), ['Inc/stm32f7xx.h', 'Core/Inc/stm32f7xx.h']);

	const mcuUpper = String(mcuName ?? '').toUpperCase();
	const series = (mcuUpper.match(/^STM32(F\d{3})/)?.[1] ?? 'F767').toLowerCase();
	const startup = path.join(deviceRoot, 'Source', 'Templates', 'gcc', `startup_stm32${series}xx.s`);
	const system = path.join(deviceRoot, 'Source', 'Templates', 'system_stm32f7xx.c');
	if (!isExistingFile(startup) || !isExistingFile(system)) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: `Required CMSIS templates not found: startup=${startup}, system=${system}`
		};
	}

	let linkerScript = findFileRecursive(
		path.join(fwRoot, 'Projects'),
		(name) => new RegExp(`STM32${series.toUpperCase()}[A-Z0-9]*.*FLASH\\.ld$`, 'i').test(name),
		12
	);
	if (!linkerScript) {
		linkerScript = findFileRecursive(
			path.join(fwRoot, 'Projects'),
			(name) => /STM32F7.*FLASH\.ld$/i.test(name),
			12
		);
	}
	if (!linkerScript) {
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: `Linker script for ${mcuUpper || 'STM32F7'} not found in STM32Cube FW F7 package.`
		};
	}

	const preferredRoots = detectPreferredSourceRoots(wsRoot, null);
	const srcDir = path.join(wsRoot, ...preferredRoots.sourceRoot.split('/'));
	if (!isExistingDirectory(srcDir)) {
		return { success: false, exitCode: 1, stdout: '', stderr: `Generated source directory not found: ${srcDir}` };
	}

	const includeArgs = [
		...Array.from(new Set([
			path.join(wsRoot, ...preferredRoots.includeRoot.split('/')),
			path.join(wsRoot, 'Core', 'Inc'),
			path.join(wsRoot, 'Inc'),
			...collectProjectDriverIncludes(wsRoot),
		].filter(isExistingDirectory))).map(includeDir => `-I${includeDir}`),
		`-I${path.join(halRoot, 'Inc')}`,
		`-I${path.join(halRoot, 'Inc', 'Legacy')}`,
		`-I${path.join(deviceRoot, 'Include')}`,
		`-I${path.join(cmsisRoot, 'Include')}`,
	];

	const defineSeries = deriveMcuDefineFromIoc(wsRoot) ?? `STM32${series.toUpperCase()}xx`;
	const commonFlags = [
		'-mcpu=cortex-m7',
		'-mthumb',
		'-mfloat-abi=hard',
		'-mfpu=fpv5-d16',
		'-O0',
		'-g3',
		'-ffunction-sections',
		'-fdata-sections',
		'-Wall',
		'-DUSE_HAL_DRIVER',
		`-D${defineSeries}`,
		...includeArgs,
	];

	const halSources = [
		'stm32f7xx_hal.c',
		'stm32f7xx_hal_cortex.c',
		'stm32f7xx_hal_dma.c',
		'stm32f7xx_hal_dma_ex.c',
		'stm32f7xx_hal_exti.c',
		'stm32f7xx_hal_flash.c',
		'stm32f7xx_hal_flash_ex.c',
		'stm32f7xx_hal_gpio.c',
		'stm32f7xx_hal_pwr.c',
		'stm32f7xx_hal_pwr_ex.c',
		'stm32f7xx_hal_rcc.c',
		'stm32f7xx_hal_rcc_ex.c',
	];

	const projectSources = fs.readdirSync(srcDir)
		.filter(f => f.toLowerCase().endsWith('.c'))
		.filter((fileName) => {
			const lower = fileName.toLowerCase();
			if (!lower.startsWith('stm32')) {
				return true;
			}
			return /stm32f7/i.test(lower);
		})
		.map(f => path.join(srcDir, f));

	const allCSources = [
		...projectSources,
		system,
		...halSources.map(f => path.join(halRoot, 'Src', f)).filter(isExistingFile),
	];

	const objects = [];
	let buildStdout = '';
	let buildStderr = '';

	for (const src of allCSources) {
		const obj = path.join(objDir, `${path.basename(src, '.c')}.o`);
		try {
			const { stdout, stderr } = await execFileAsync(gccCmd, ['-c', src, '-o', obj, ...commonFlags], { cwd: wsRoot, env, timeout: 120000 });
			buildStdout += stdout ?? '';
			buildStderr += stderr ?? '';
			objects.push(obj);
		} catch (err) {
			return {
				success: false,
				exitCode: err.code ?? 1,
				buildDir,
				stdout: (buildStdout + (err.stdout ?? '')).trim(),
				stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
			};
		}
	}

	const startupObj = path.join(objDir, path.basename(startup, '.s') + '.o');
	try {
		const { stdout, stderr } = await execFileAsync(gccCmd, ['-c', startup, '-o', startupObj, ...commonFlags], { cwd: wsRoot, env, timeout: 120000 });
		buildStdout += stdout ?? '';
		buildStderr += stderr ?? '';
		objects.push(startupObj);
	} catch (err) {
		return {
			success: false,
			exitCode: err.code ?? 1,
			buildDir,
			stdout: (buildStdout + (err.stdout ?? '')).trim(),
			stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
		};
	}

	const elfPath = path.join(buildDir, `${projectName}.elf`);
	try {
		const { stdout, stderr } = await execFileAsync(
			gccCmd,
			[
				...objects,
				'-mcpu=cortex-m7',
				'-mthumb',
				'-mfloat-abi=hard',
				'-mfpu=fpv5-d16',
				'-Wl,--gc-sections',
				`-Wl,-Map=${path.join(buildDir, `${projectName}.map`)}`,
				`-T${linkerScript}`,
				'-specs=nosys.specs',
				'-specs=nano.specs',
				'-Wl,--start-group',
				'-lc',
				'-lm',
				'-lnosys',
				'-Wl,--end-group',
				'-o',
				elfPath,
			],
			{ cwd: wsRoot, env, timeout: 120000 }
		);
		buildStdout += stdout ?? '';
		buildStderr += stderr ?? '';
	} catch (err) {
		return {
			success: false,
			exitCode: err.code ?? 1,
			buildDir,
			stdout: (buildStdout + (err.stdout ?? '')).trim(),
			stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
		};
	}

	return {
		success: true,
		exitCode: 0,
		buildDir,
		elfPath,
		stdout: buildStdout.trim(),
		stderr: buildStderr.trim()
	};
}

function seedVendorHeaderForProject(wsRoot, vendorHeaderPath, targetRelPaths) {
	if (!isExistingFile(vendorHeaderPath)) {
		return;
	}
	let vendorContent = '';
	try {
		vendorContent = fs.readFileSync(vendorHeaderPath, 'utf8');
	} catch {
		return;
	}

	for (const relPath of targetRelPaths) {
		const targetPath = safeResolvePath(wsRoot, relPath);
		if (!isExistingDirectory(path.dirname(targetPath))) {
			continue;
		}
		try {
			fs.writeFileSync(targetPath, vendorContent, 'utf8');
			bumpFileMtimeForward(targetPath);
			markWorkspaceFileDirty(wsRoot, targetPath, 'vendorHeaderSeed');
		} catch {
			// ignore per-file write failures
		}
	}
}

async function buildBareMetalFallbackF303K8(wsRoot, gccCmd, env) {
	const projectName = getProjectNameFromIoc(wsRoot);
	const buildDir = path.join(wsRoot, 'Debug');
	const objDir = path.join(buildDir, 'obj');
	fs.mkdirSync(objDir, { recursive: true });

	const elfPath = path.join(buildDir, `${projectName}.elf`);

	const preferredRoots = detectPreferredSourceRoots(wsRoot, null);
	const srcDir = path.join(wsRoot, ...preferredRoots.sourceRoot.split('/'));
	if (!isExistingDirectory(srcDir)) {
		return { success: false, exitCode: 1, buildDir, stdout: '', stderr: `Source directory not found: ${srcDir}` };
	}

	// Find linker script in workspace first, then fall back to a generated one
	let ldScript = findFileRecursive(wsRoot, (name) => /\.ld$/i.test(name) && !/node_modules|Drivers/i.test(name), 4);
	if (!ldScript) {
		const ldPath = path.join(buildDir, 'stm32f303k8_flash.ld');
		const ldSource = `ENTRY(Reset_Handler)\n\n_estack = ORIGIN(RAM) + LENGTH(RAM);\n\nMEMORY\n{\n\tFLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K\n\tRAM (xrw)  : ORIGIN = 0x20000000, LENGTH = 12K\n}\n\nSECTIONS\n{\n\t.isr_vector :\n\t{\n\t\t. = ALIGN(4);\n\t\tKEEP(*(.isr_vector))\n\t\t. = ALIGN(4);\n\t} > FLASH\n\t.text :\n\t{\n\t\t. = ALIGN(4);\n\t\t*(.text*)\n\t\t*(.rodata*)\n\t\t. = ALIGN(4);\n\t} > FLASH\n\t.ARM.exidx : { *(.ARM.exidx*) } > FLASH\n\t.data :\n\t{\n\t\t. = ALIGN(4);\n\t\t*(.data*)\n\t\t. = ALIGN(4);\n\t} > RAM AT > FLASH\n\t.bss :\n\t{\n\t\t. = ALIGN(4);\n\t\t*(.bss*)\n\t\t*(COMMON)\n\t\t. = ALIGN(4);\n\t} > RAM\n}\n`;
		fs.writeFileSync(ldPath, ldSource, 'utf8');
		ldScript = ldPath;
	}

	const mcuDefineF303 = deriveMcuDefineFromIoc(wsRoot) ?? 'STM32F303x8';
	const includeArgs = Array.from(new Set([
		path.join(wsRoot, ...preferredRoots.includeRoot.split('/')),
		path.join(wsRoot, 'Core', 'Inc'),
		path.join(wsRoot, 'Inc'),
		...collectProjectDriverIncludes(wsRoot),
	].filter(isExistingDirectory))).map(d => `-I${d}`);

	const commonFlags = [
		'-mcpu=cortex-m4', '-mthumb', '-O0', '-g3',
		'-ffunction-sections', '-fdata-sections', '-Wall',
		'-DUSE_HAL_DRIVER', `-D${mcuDefineF303}`,
		...includeArgs,
	];

	const projectSources = fs.readdirSync(srcDir)
		.filter(f => f.toLowerCase().endsWith('.c'))
		.filter((fileName) => {
			const lower = fileName.toLowerCase();
			if (!lower.startsWith('stm32')) { return true; }
			return /stm32f3/i.test(lower);
		})
		.map(f => path.join(srcDir, f));

	if (projectSources.length === 0) {
		return { success: false, exitCode: 1, buildDir, stdout: '', stderr: `No source files found in ${srcDir}` };
	}

	const objects = [];
	let buildStdout = '';
	let buildStderr = '';

	for (const src of projectSources) {
		const obj = path.join(objDir, `${path.basename(src, '.c')}.o`);
		try {
			const { stdout, stderr } = await execFileAsync(gccCmd, ['-c', src, '-o', obj, ...commonFlags], { cwd: wsRoot, env, timeout: 120000 });
			buildStdout += stdout ?? '';
			buildStderr += stderr ?? '';
			objects.push(obj);
		} catch (err) {
			return {
				success: false,
				exitCode: err.code ?? 1,
				buildDir,
				stdout: (buildStdout + (err.stdout ?? '')).trim(),
				stderr: (buildStderr + (err.stderr ?? err.message ?? '')).trim()
			};
		}
	}

	try {
		const { stdout, stderr } = await execFileAsync(
			gccCmd,
			[
				...objects,
				'-mcpu=cortex-m4', '-mthumb',
				'-Wl,--gc-sections',
				`-Wl,-Map=${path.join(buildDir, `${projectName}.map`)}`,
				`-T${ldScript}`,
				'-specs=nosys.specs', '-specs=nano.specs',
				'-o', elfPath,
			],
			{ cwd: wsRoot, env, timeout: 120000 }
		);
		buildStdout += stdout ?? '';
		buildStderr += stderr ?? '';
		return {
			success: true,
			exitCode: 0,
			buildDir,
			elfPath,
			stdout: buildStdout.trim(),
			stderr: buildStderr.trim()
		};
	} catch (err) {
		return {
			success: false,
			exitCode: err.code ?? 1,
			buildDir,
			stdout: (buildStdout + (err.stdout ?? '')).trim(),
			stderr: (buildStdout + (err.stderr ?? err.message ?? '')).trim()
		};
	}
}

// ─── New Tool Implementations ─────────────────────────────────────────────────

function resolveWorkspacePath(params) {
	if (params && typeof params.workspacePath === 'string' && params.workspacePath.trim().length > 0) {
		return path.resolve(params.workspacePath.trim());
	}
	if (params && typeof params.iocPath === 'string' && path.isAbsolute(params.iocPath)) {
		const iocDir = path.dirname(params.iocPath);
		if (isExistingDirectory(iocDir)) {
			return iocDir;
		}
	}
	return ACTIVE_WORKSPACE;
}

function toolOperationDesk(params) {
	const action = (params.action ?? 'status').toString();
	if (action === 'setWorkspace') {
		const target = params.workspacePath ? path.resolve(params.workspacePath) : null;
		if (!target || !isExistingDirectory(target)) {
			throw Object.assign(new Error(`workspacePath not found: ${params.workspacePath ?? ''}`), { code: -32602 });
		}
		ACTIVE_WORKSPACE = target;
	}

	const wsForListing = resolveWorkspacePath(params);
	let iocFiles = [];
	if (params.includeIocList !== false && isExistingDirectory(wsForListing)) {
		iocFiles = fs.readdirSync(wsForListing)
			.filter(e => e.toLowerCase().endsWith('.ioc'))
			.map(e => path.join(wsForListing, e));
	}

	return {
		desk: 'STM32 MCP Operation Desk',
		server: {
			instanceId: SERVER_INSTANCE_ID,
			pid: process.pid,
			host: HOST,
			port: PORT,
			startedAt: SERVER_STARTED_AT,
			uptimeSec: Math.floor(process.uptime()),
			noAuth: NO_AUTH,
			stdioMode: STDIO_MODE
		},
		workspace: {
			startupWorkspace: WORKSPACE,
			activeWorkspace: ACTIVE_WORKSPACE,
			requestedWorkspace: params.workspacePath ?? null,
			resolvedWorkspace: wsForListing,
			tokenFile: TOKEN_FILE,
			topLevelIocFiles: iocFiles
		}
	};
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
		return { canonical: normalized, source: 'input', verified: false, candidates: [] };
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
			const exact = stems.filter(stem => stem.toUpperCase() === candidate.toUpperCase());
			if (exact.length > 0) {
				return { canonical: exact[0], source: `db:${dbDir}`, verified: true, candidates: exact.slice(0, 5) };
			}
			const matched = stems.filter(stem => cubeMxFileNameMatchesMcu(stem, candidate));
			if (matched.length === 1) {
				return { canonical: matched[0], source: `db-pattern:${dbDir}`, verified: true, candidates: matched };
			}
			if (matched.length > 1) {
				return { canonical: candidate, source: `db-ambiguous:${dbDir}`, verified: false, candidates: matched.slice(0, 8) };
			}
		}
	}

	return { canonical: normalized, source: 'input-fallback', verified: false, candidates: [] };
}

function toolWriteFile(params) {
	if (!params.filePath) throw Object.assign(new Error('filePath required'), { code: -32602 });
	if (params.content === undefined) throw Object.assign(new Error('content required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const preferredRoots = detectPreferredSourceRoots(base, findBuildDirectoryWithMakefile(base));
	const requestedRelPath = normalizeRelPath(params.filePath);
	const effectiveRelPath = mapToPreferredTree(requestedRelPath, preferredRoots);
	const full = safeResolvePath(base, effectiveRelPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, params.content, 'utf8');
	bumpFileMtimeForward(full);
	markWorkspaceFileDirty(base, full, 'writeFile');
	const mirroredFiles = syncEditedFileToCounterpart(base, effectiveRelPath);
	return {
		filePath: effectiveRelPath,
		requestedFilePath: requestedRelPath,
		bytesWritten: Buffer.byteLength(params.content, 'utf8'),
		success: true,
		buildInvalidated: true,
		mirroredFiles,
	};
}

function toolPatchUserCode(params) {
	if (!params.filePath) throw Object.assign(new Error('filePath required'), { code: -32602 });
	if (!Array.isArray(params.patches) || params.patches.length === 0) throw Object.assign(new Error('patches array required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const preferredRoots = detectPreferredSourceRoots(base, findBuildDirectoryWithMakefile(base));
	const requestedRelPath = normalizeRelPath(params.filePath);
	const effectiveRelPath = mapToPreferredTree(requestedRelPath, preferredRoots);
	const counterpartRelPath = getCounterpartRelPath(effectiveRelPath);
	const candidateRelPaths = [effectiveRelPath, counterpartRelPath].filter(Boolean);

	let selectedRelPath = null;
	let selectedContent = '';
	let bestScore = -1;
	const selectionDetails = [];

	for (const relPath of candidateRelPaths) {
		const fullPath = safeResolvePath(base, relPath);
		if (!fs.existsSync(fullPath)) {
			selectionDetails.push({ filePath: relPath, exists: false, score: -1, availableSections: [] });
			continue;
		}
		const candidateContent = fs.readFileSync(fullPath, 'utf8');
		const availableSections = listUserCodeSections(candidateContent);
		let score = 0;
		for (const patch of params.patches) {
			const sectionName = (patch.sectionName ?? '').toString().trim();
			if (!sectionName) {
				continue;
			}
			if (findUserCodeSectionRange(candidateContent, sectionName)) {
				score += 1;
			}
		}
		selectionDetails.push({ filePath: relPath, exists: true, score, availableSections });
		if (score > bestScore) {
			bestScore = score;
			selectedRelPath = relPath;
			selectedContent = candidateContent;
		}
	}

	if (!selectedRelPath) {
		throw Object.assign(new Error(`File not found: ${effectiveRelPath}`), { code: -32602 });
	}

	if (bestScore <= 0) {
		return {
			filePath: selectedRelPath,
			requestedFilePath: requestedRelPath,
			patches: params.patches.map(p => ({ sectionName: (p.sectionName ?? '').toString(), success: false, error: 'Section markers not found in candidate files' })),
			success: false,
			buildInvalidated: false,
			mirroredFiles: [],
			selectionDetails,
		};
	}

	let content = selectedContent;
	const lineBreak = /\r\n/.test(content) ? '\r\n' : '\n';
	const results = [];
	for (const patch of params.patches) {
		const sectionName = (patch.sectionName ?? '').toString().trim();
		const newCode = patch.content ?? '';
		if (!sectionName) { results.push({ sectionName: '?', success: false, error: 'sectionName missing' }); continue; }
		const sectionRange = findUserCodeSectionRange(content, sectionName);
		if (!sectionRange) {
			results.push({ sectionName, success: false, error: `Section markers not found in file` });
			continue;
		}
		const prefix = content.slice(0, sectionRange.beginEndIndex);
		const suffix = content.slice(sectionRange.endStartIndex);
		const textCode = normalizePatchSnippetText(String(newCode));
		const normalizedCode = textCode.replace(/\r?\n/g, lineBreak);
		const leading = normalizedCode.startsWith(lineBreak) ? '' : lineBreak;
		const trailing = normalizedCode.endsWith(lineBreak) ? '' : lineBreak;
		const replacement = `${leading}${normalizedCode}${trailing}`;
		content = prefix + replacement + suffix;
		results.push({ sectionName, resolvedSectionName: sectionRange.resolvedSectionName, success: true });
	}
	const selectedFull = safeResolvePath(base, selectedRelPath);
	const successCount = results.filter(r => r.success).length;
	const failureCount = results.length - successCount;
	if (failureCount > 0) {
		return {
			filePath: selectedRelPath,
			requestedFilePath: requestedRelPath,
			patches: results,
			success: false,
			buildInvalidated: false,
			selectionDetails,
			mirroredFiles: [],
			error: 'One or more USER CODE sections were not found. No file changes were applied.'
		};
	}

	const markerBefore = countUserCodeMarkers(selectedContent);
	const markerAfter = countUserCodeMarkers(content);
	if (markerBefore.begin !== markerAfter.begin || markerBefore.end !== markerAfter.end) {
		return {
			filePath: selectedRelPath,
			requestedFilePath: requestedRelPath,
			patches: results,
			success: false,
			buildInvalidated: false,
			selectionDetails,
			mirroredFiles: [],
			error: 'Patch rejected: USER CODE marker count changed unexpectedly.'
		};
	}

	const ext = path.extname(selectedRelPath).toLowerCase();
	let autoRepaired = false;
	if (['.c', '.h', '.cpp', '.hpp', '.cc'].includes(ext)) {
		const beforeBalance = analyzeCStructuralBalance(selectedContent);
		let afterBalance = analyzeCStructuralBalance(content);

		if (!afterBalance.balanced && ext === '.c' && /(^|\/)main\.c$/i.test(normalizeRelPath(selectedRelPath))) {
			const repairedContent = repairMainCCommonBraceIssue(content, lineBreak);
			if (repairedContent !== content) {
				const repairedBalance = analyzeCStructuralBalance(repairedContent);
				if (repairedBalance.balanced) {
					content = repairedContent;
					afterBalance = repairedBalance;
					autoRepaired = true;
				}
			}
		}

		if (!afterBalance.balanced) {
			return {
				filePath: selectedRelPath,
				requestedFilePath: requestedRelPath,
				patches: results,
				success: false,
				buildInvalidated: false,
				selectionDetails,
				mirroredFiles: [],
				error: 'Patch rejected: likely syntax imbalance introduced (brace/paren mismatch).',
				balanceBefore: beforeBalance,
				balanceAfter: afterBalance,
			};
		}
	}

	const changed = content !== selectedContent;
	if (changed) {
		fs.writeFileSync(selectedFull, content, 'utf8');
		bumpFileMtimeForward(selectedFull);
		markWorkspaceFileDirty(base, selectedFull, 'patchUserCode');
	}
	const mirroredFiles = changed ? syncEditedFileToCounterpart(base, selectedRelPath) : [];
	return {
		filePath: selectedRelPath,
		requestedFilePath: requestedRelPath,
		patches: results,
		success: successCount > 0,
		buildInvalidated: changed,
		autoRepaired,
		selectionDetails,
		mirroredFiles,
	};
}

function repairMainCCommonBraceIssue(content, lineBreak = '\n') {
	const lb = lineBreak || '\n';
	const re = /(\/\*\s*USER CODE END 3\s*\*\/\r?\n\s*}\r?\n)(\r?\n\/\*\*\r?\n\s*\*\s*@brief\s+System Clock Configuration)/i;
	if (!re.test(content)) {
		return repairMainCByBraceBalance(content, lb);
	}
	const fastPatched = content.replace(re, (_m, p1, p2) => `${p1}  }${lb}${p2}`);
	return repairMainCByBraceBalance(fastPatched, lb);
}

function repairMainCByBraceBalance(content, lineBreak = '\n') {
	const lb = lineBreak || '\n';
	const mainIdx = content.indexOf('int main(void)');
	const sysIdx = content.indexOf('void SystemClock_Config(', Math.max(0, mainIdx + 1));
	if (mainIdx < 0 || sysIdx < 0 || sysIdx <= mainIdx) {
		return content;
	}

	const segment = content.slice(mainIdx, sysIdx);
	const openCount = countCBraces(segment);
	if (openCount <= 0) {
		return content;
	}

	const prefix = content.slice(0, sysIdx);
	const suffix = content.slice(sysIdx);
	const trimmedPrefix = prefix.replace(/[ \t]+$/g, '');
	const existingTail = trimmedPrefix.slice(Math.max(0, trimmedPrefix.length - 24));
	if (/}\s*}\s*$/.test(existingTail)) {
		return content;
	}

	const insertion = `${lb}${'  }' + lb}`.repeat(openCount);
	return `${prefix}${insertion}${suffix}`;
}

function countCBraces(text) {
	let depth = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inString = false;
	let inChar = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = i + 1 < text.length ? text[i + 1] : '';

		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}

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

		if (inChar) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === "'") {
				inChar = false;
			}
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "'") {
			inChar = true;
			continue;
		}

		if (ch === '{') {
			depth += 1;
		} else if (ch === '}') {
			depth -= 1;
		}
	}

	return Math.max(0, depth);
}

function countUserCodeMarkers(content) {
	const begin = (content.match(/\/\*\s*USER\s+CODE\s+BEGIN\s+/gi) ?? []).length;
	const end = (content.match(/\/\*\s*USER\s+CODE\s+END\s+/gi) ?? []).length;
	return { begin, end };
}

function normalizePatchSnippetText(value) {
	let out = String(value ?? '');

	// Accept PowerShell-style escaped newlines that may arrive as literal `n text.
	out = out.replace(/`r`n/g, '\n').replace(/`n/g, '\n').replace(/`r/g, '\r');

	// If the payload appears single-line but contains JSON escaped newlines, decode them.
	if (!/\r|\n/.test(out) && /\\n|\\r/.test(out)) {
		out = out.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
	}

	return out;
}

function analyzeCStructuralBalance(content) {
	let brace = 0;
	let paren = 0;
	let bracket = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inString = false;
	let inChar = false;
	let escape = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		const next = i + 1 < content.length ? content[i + 1] : '';

		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}

		if (inString) {
			if (escape) {
				escape = false;
			} else if (ch === '\\') {
				escape = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (inChar) {
			if (escape) {
				escape = false;
			} else if (ch === '\\') {
				escape = true;
			} else if (ch === "'") {
				inChar = false;
			}
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "'") {
			inChar = true;
			continue;
		}

		if (ch === '{') brace += 1;
		if (ch === '}') brace -= 1;
		if (ch === '(') paren += 1;
		if (ch === ')') paren -= 1;
		if (ch === '[') bracket += 1;
		if (ch === ']') bracket -= 1;

		if (brace < 0 || paren < 0 || bracket < 0) {
			return { balanced: false, brace, paren, bracket };
		}
	}

	const balanced = !inString && !inChar && !inBlockComment && brace === 0 && paren === 0 && bracket === 0;
	return { balanced, brace, paren, bracket };
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSectionName(value) {
	return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function listUserCodeSections(content) {
	const sections = [];
	const re = /\/\*\s*USER\s+CODE\s+BEGIN\s+([^*]+?)\s*\*\//gi;
	let m;
	while ((m = re.exec(content)) !== null) {
		const name = (m[1] ?? '').trim();
		if (name) {
			sections.push(name);
		}
	}
	return Array.from(new Set(sections));
}

function findUserCodeSectionRange(content, sectionName) {
	const requested = normalizeSectionName(sectionName);
	if (!requested) {
		return null;
	}

	const directBegin = new RegExp(`/\\*\\s*USER\\s+CODE\\s+BEGIN\\s+${escapeRegExp(sectionName)}\\s*\\*/`, 'i');
	let beginMatch = directBegin.exec(content);

	if (!beginMatch) {
		const beginAny = /\/\*\s*USER\s+CODE\s+BEGIN\s+([^*]+?)\s*\*\//gi;
		let m;
		while ((m = beginAny.exec(content)) !== null) {
			const candidateName = (m[1] ?? '').trim();
			if (normalizeSectionName(candidateName) === requested) {
				beginMatch = m;
				break;
			}
		}
	}

	if (!beginMatch || beginMatch.index < 0) {
		return null;
	}

	const beginStartIndex = beginMatch.index;
	const beginEndIndex = beginStartIndex + beginMatch[0].length;
	const resolvedSectionName = (beginMatch[1] ?? sectionName).toString().trim() || sectionName;

	const endRe = new RegExp(`/\\*\\s*USER\\s+CODE\\s+END\\s+${escapeRegExp(resolvedSectionName)}\\s*\\*/`, 'i');
	const tail = content.slice(beginEndIndex);
	const endMatch = endRe.exec(tail);
	if (!endMatch || endMatch.index < 0) {
		return null;
	}

	const endStartIndex = beginEndIndex + endMatch.index;
	const endEndIndex = endStartIndex + endMatch[0].length;
	return { beginStartIndex, beginEndIndex, endStartIndex, endEndIndex, resolvedSectionName };
}

function toolCreateIocFromPins(params) {
	if (!params.mcuName) throw Object.assign(new Error('mcuName required'), { code: -32602 });
	const base = resolveWorkspacePath(params);
	const canonical = resolveCanonicalMcuName(params.mcuName, base);
	const mcuName = canonical.canonical;
	if (!mcuName || !/^STM32/i.test(mcuName)) {
		const hint = Array.isArray(canonical.candidates) && canonical.candidates.length > 0
			? ` Candidates: ${canonical.candidates.join(', ')}`
			: '';
		throw Object.assign(new Error(`Invalid mcuName for CubeMX: ${params.mcuName}. source=${canonical.source}.${hint}`), { code: -32602 });
	}
	// Allow unverified names if CubeMX DB is not available; CubeMX itself will validate.
	const mcuNameWarning = canonical.verified ? null : `MCU name '${mcuName}' could not be verified against CubeMX DB (source=${canonical.source}). CubeMX will validate.`;
	const projectName = params.projectName ?? 'project';
	const pins = normalizePinsInput(params.pins);
	if (params.pins !== undefined && pins.length === 0) {
		throw Object.assign(new Error('Invalid pins format. Expected array/object/json string of pin definitions.'), { code: -32602 });
	}
	const mcuFamily = inferMcuFamilyFromName(mcuName);

	const pinLines = pins.map(p => `${p.pin}.Signal=${p.mode}`).join('\n');
	const pinGpioLines = pins
		.filter(p => p.mode === 'GPIO_Output' || p.mode === 'GPIO_Input')
		.map(p => `${p.pin}.GPIO_Label=`)
		.join('\n');

	const iocContent = [
		`#MicroXplorer Configuration settings - do not modify`,
		`File.Version=6`,
		`KeepUserPlacement=true`,
		`LibraryCopySrc=1`,
		`Mcu.CPN=${mcuName}`,
		`Mcu.Family=${mcuFamily}`,
		`Mcu.Name=${mcuName}`,
		`Mcu.IP0=GPIO`,
		`Mcu.IP1=RCC`,
		`Mcu.IP2=SYS`,
		`Mcu.IPNb=3`,
		`Mcu.ThirdPartyNb=0`,
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
		`ProjectManager.NoMain=false`,
		`ProjectManager.ComputerToolchain=0`,
		`ProjectManager.LibraryCopySrc=1`,
		``
	].filter(l => l !== undefined).join('\n');

	const iocPath = path.join(base, `${projectName}.ioc`);
	fs.writeFileSync(iocPath, iocContent, 'utf8');
	return {
		iocPath: path.relative(base, iocPath).replace(/\\/g, '/'),
		mcuName,
		mcuSource: canonical.source,
		mcuVerified: canonical.verified,
		mcuNameWarning: mcuNameWarning ?? null,
		projectName,
		pinCount: pins.length,
		success: true
	};
}

function normalizePinsInput(rawPins) {
	if (rawPins === undefined || rawPins === null) {
		return [];
	}

	if (typeof rawPins === 'string') {
		try {
			const parsed = JSON.parse(rawPins);
			return normalizePinsInput(parsed);
		} catch {
			return [];
		}
	}

	if (Array.isArray(rawPins)) {
		const out = [];
		for (const entry of rawPins) {
			if (typeof entry === 'string') {
				const m = entry.match(/^\s*([^:\s]+)\s*[:=]\s*(.+?)\s*$/);
				if (m) {
					out.push({ pin: m[1], mode: m[2] });
				}
				continue;
			}
			if (entry && typeof entry === 'object') {
				const pin = String(entry.pin ?? '').trim();
				const mode = String(entry.mode ?? '').trim();
				if (pin && mode) {
					out.push({ pin, mode });
				}
			}
		}
		return dedupePins(out);
	}

	if (rawPins && typeof rawPins === 'object') {
		const out = [];
		for (const [pinKey, value] of Object.entries(rawPins)) {
			const pin = String(pinKey ?? '').trim();
			if (!pin) {
				continue;
			}
			if (value && typeof value === 'object') {
				const modeObj = String(value.mode ?? value.signal ?? '').trim();
				if (modeObj) {
					out.push({ pin, mode: modeObj });
				}
				continue;
			}
			const mode = String(value ?? '').trim();
			if (mode) {
				out.push({ pin, mode });
			}
		}
		return dedupePins(out);
	}

	return [];
}

function dedupePins(pins) {
	const map = new Map();
	for (const p of pins) {
		const pin = String(p.pin ?? '').trim();
		const mode = String(p.mode ?? '').trim();
		if (!pin || !mode) {
			continue;
		}
		map.set(pin.toUpperCase(), { pin, mode });
	}
	return Array.from(map.values());
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
		let regenOk = false;
		try {
			regenResult = await toolRegenerateCode({
				workspacePath: base,
				cubemxPath: params.cubemxPath ?? null,
			});
			regenOk = !!regenResult.success;
			steps.push({ step: 'regenerateCode', success: regenOk, result: regenResult });
		} catch (e) {
			steps.push({ step: 'regenerateCode', success: false, error: e.message, note: 'Continuing with patchUserCode/build anyway' });
		}
		// If regenerate failed and caller does not allow fallback continuation, stop.
		if (!regenOk && params.abortOnRegenerateFail === true) {
			return { success: false, goal: params.goal, steps, error: 'regenerateCode failed and abortOnRegenerateFail=true' };
		}
	} else {
		steps.push({ step: 'regenerateCode', success: true, skipped: true });
	}

	// 3. patchUserCode
	if (Array.isArray(params.userCodePatches) && params.userCodePatches.length > 0) {
		const buildDirForMain = findBuildDirectoryWithMakefile(base);
		const preferredRoots = detectPreferredSourceRoots(base, buildDirForMain);
		const mainC = `${preferredRoots.sourceRoot}/main.c`;
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
	const buildDir = findBuildDirectoryWithMakefile(base);
	if (!buildDir) {
		steps.push({
			step: 'build',
			success: true,
			skipped: true,
			note: 'No Makefile-based build directory found. Project generation succeeded, build was skipped.'
		});
		return { success: true, goal: params.goal, steps, message: 'STM project generated successfully. Build skipped (no Makefile).' };
	}

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
				capabilities: {
					tools: {},
					experimental: {
						transports: ['http-jsonrpc', 'http-sse', 'stdio-framed', 'stdio-linejson']
					}
				},
				serverInfo: { name: 'cubeforge-stm32-mcp', version: '2.0.0' }
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
		case 'stm32.operationDesk':
			return toolOperationDesk(params);
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
		case 'stm32.validateEnvironment':
			return await toolValidateEnvironment(params);
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

const sseSessions = new Map();

function parseRequestUrl(reqUrl) {
	try {
		return new URL(reqUrl ?? '/', `http://${HOST}:${PORT}`);
	} catch {
		return null;
	}
}

function httpJsonRequest({ host, port, pathname, method = 'GET', payload = null, timeoutMs = 2000 }) {
	return new Promise((resolve, reject) => {
		const body = payload ? JSON.stringify(payload) : null;
		const req = http.request({
			host,
			port,
			path: pathname,
			method,
			headers: body ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body)
			} : undefined,
			timeout: timeoutMs,
		}, (res) => {
			let raw = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { raw += chunk; });
			res.on('end', () => {
				let json = null;
				try { json = raw ? JSON.parse(raw) : null; } catch { }
				resolve({ statusCode: res.statusCode ?? 0, raw, json });
			});
		});
		req.on('timeout', () => {
			req.destroy(new Error('request timeout'));
		});
		req.on('error', reject);
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

async function tryAttachToExistingMcpOnSamePort() {
	try {
		const health = await httpJsonRequest({ host: HOST, port: PORT, pathname: '/health', method: 'GET', timeoutMs: 2000 });
		if (health.statusCode !== 200 || !health.json || health.json.status !== 'ok') {
			return { attached: false, reason: `Port ${PORT} is in use, but /health did not return MCP status=ok` };
		}

		const setWorkspacePayload = {
			jsonrpc: '2.0',
			id: `attach-${Date.now()}`,
			method: 'stm32.operationDesk',
			params: { action: 'setWorkspace', workspacePath: WORKSPACE }
		};
		const setWorkspace = await httpJsonRequest({
			host: HOST,
			port: PORT,
			pathname: '/mcp',
			method: 'POST',
			payload: setWorkspacePayload,
			timeoutMs: 3000,
		});

		const setResult = setWorkspace.json?.result;
		const activeWorkspace = setResult?.workspace?.activeWorkspace ?? null;
		if (setWorkspace.statusCode !== 200 || !setResult) {
			return { attached: false, reason: 'Existing MCP found, but workspace switch request failed' };
		}

		return {
			attached: true,
			instanceId: health.json.instanceId ?? null,
			pid: health.json.pid ?? null,
			startupWorkspace: health.json.startupWorkspace ?? null,
			activeWorkspace,
		};
	} catch (err) {
		return { attached: false, reason: err?.message ?? 'attach failed' };
	}
}

function sendSseEvent(res, event, data) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function isLoopbackRequest(req) {
	const remote = req?.socket?.remoteAddress ?? '';
	return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function checkHttpAuth(req, res) {
	if (isLoopbackRequest(req)) {
		return true;
	}
	const auth = req.headers['authorization'] ?? '';
	if (!NO_AUTH && SERVER_TOKEN && auth !== `Bearer ${SERVER_TOKEN}`) {
		writeJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
		return false;
	}
	return true;
}

const server = http.createServer(async (req, res) => {
	verbose(`${req.method} ${req.url}`);
	const parsedUrl = parseRequestUrl(req.url);

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
		writeJson(res, 200, {
			status: 'ok',
			version: '2.0.0',
			instanceId: SERVER_INSTANCE_ID,
			pid: process.pid,
			startedAt: SERVER_STARTED_AT,
			uptimeSec: Math.floor(process.uptime()),
			startupWorkspace: WORKSPACE,
			activeWorkspace: ACTIVE_WORKSPACE,
			host: HOST,
			port: PORT,
			transports: ['http-jsonrpc', 'http-sse', STDIO_MODE ? 'stdio-framed/linejson(active)' : 'stdio-framed/linejson(supported)']
		});
		return;
	}

	// Tool list convenience endpoint
	if (req.method === 'GET' && req.url === '/tools') {
		writeJson(res, 200, { tools: TOOLS });
		return;
	}

	// Legacy SSE endpoint compatibility for clients using EventSource transport
	if (req.method === 'GET' && parsedUrl && (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/mcp/sse')) {
		if (!checkHttpAuth(req, res)) {
			return;
		}
		const sessionId = crypto.randomBytes(12).toString('hex');
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'Access-Control-Allow-Origin': '*'
		});
		sseSessions.set(sessionId, { res, createdAt: Date.now() });
		sendSseEvent(res, 'endpoint', `/messages?sessionId=${sessionId}`);
		sendSseEvent(res, 'ready', { sessionId });
		req.on('close', () => {
			sseSessions.delete(sessionId);
			try { res.end(); } catch (_) { }
		});
		return;
	}

	if (req.method === 'POST' && parsedUrl && (parsedUrl.pathname === '/messages' || parsedUrl.pathname === '/mcp/messages')) {
		if (!checkHttpAuth(req, res)) {
			return;
		}
		const sessionId = parsedUrl.searchParams.get('sessionId') ?? '';
		const session = sseSessions.get(sessionId);
		if (!session) {
			writeJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32004, message: 'Unknown SSE session' } });
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
		if (response !== undefined) {
			try {
				sendSseEvent(session.res, 'message', response);
			} catch {
				// ignore session write failure
			}
		}
		writeJson(res, 202, { ok: true });
		return;
	}

	// Main MCP endpoint
	if (req.method === 'POST' && req.url === '/mcp') {
		if (!checkHttpAuth(req, res)) {
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

server.on('error', async (err) => {
	if (err.code === 'EADDRINUSE') {
		if (ATTACH_EXISTING_ON_PORT_CONFLICT) {
			const attached = await tryAttachToExistingMcpOnSamePort();
			if (attached.attached) {
				console.log(
					`[MCP] Port ${PORT} already in use by existing MCP` +
					`${attached.instanceId ? ` (instance=${attached.instanceId}` : ''}` +
					`${attached.pid ? `, pid=${attached.pid}` : ''}` +
					`${attached.instanceId || attached.pid ? ')' : ''}. ` +
					`Reused it and switched active workspace to: ${attached.activeWorkspace ?? WORKSPACE}`
				);
				process.exit(0);
				return;
			}
			console.error(`[MCP] Port ${PORT} is in use. Auto-attach failed: ${attached.reason}`);
		}
		console.error(`[MCP] Port ${PORT} already in use. Existing MCPを停止するか、--port <N> を使用してください。`);
	} else {
		console.error('[MCP] Server error:', err.message);
	}
	process.exit(1);
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (STDIO_MODE) {
	startStdioServer();
} else {
	if (!NO_AUTH) {
		initToken();
	} else {
		SERVER_TOKEN = '';
		log('HTTP auth disabled by --no-auth / MCP_NO_AUTH=1');
	}
	server.listen(PORT, HOST, () => {
		log(`CubeForge MCP Server listening on http://${HOST}:${PORT}/mcp`);
		log(`Workspace: ${WORKSPACE}`);
		if (!NO_AUTH) {
			log(`Token file: ${TOKEN_FILE}`);
		}
		log(`Tools: ${TOOLS.map(t => t.name).join(', ')}`);
	});
}
