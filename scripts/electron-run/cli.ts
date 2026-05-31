import {
    existsSync,
    readFileSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { safeDestr } from 'destr';
import { delay } from 'es-toolkit/promise';
import { sendCommand } from '@scripts/electron-run/client';
import { COMMAND_EXECUTION_TIMEOUT_MS } from '@scripts/electron-run/electronRunTimeouts';
import {
    cleanupStaleSessionArtifacts,
    clearSessionStarting,
    getSessionInfo,
    getSessionStartingInfo,
    isSessionRunning,
    listAllSessionNames,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    getCurrentSessionName,
    sessionFilePath,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import { isProcessAlive } from '@scripts/electron-run/electronRunProcessTree';
import { projectRoot } from '@scripts/electron-run/electronRunProjectPaths';
import {
    startSession,
    startSessionDetached,
    stopSession,
    stopSingleSession,
} from '@scripts/electron-run/sessionManager';

const CLI_COMMANDS = [
    'start',
    'cleanstart',
    'startd',
    'stop',
    'status',
    'restart',
    'restartd',
    'list',
    'screenshot',
    'screenshots',
    'console',
    'devtools',
    'click',
    'type',
    'content',
    'waitfor',
    'resize',
    'viewport',
    'run',
    'run-file',
    'eval',
    'openPdf',
    'health',
] as const;

type TCliCommand = typeof CLI_COMMANDS[number];
const CLI_COMMAND_SET = new Set<TCliCommand>(CLI_COMMANDS);

function isCliCommand(value: string): value is TCliCommand {
    return CLI_COMMAND_SET.has(value as TCliCommand);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parsePositivePid(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : null;
}

function readLegacyPid(filePath: string) {
    try {
        const parsed = safeDestr<Partial<{ pid: unknown }>>(readFileSync(filePath, 'utf8'));
        return parsePositivePid(parsed?.pid);
    } catch {
        return null;
    }
}

function stopLegacyProcess(pid: number | null) {
    if (!pid || !isProcessAlive(pid)) {
        return;
    }
    try {
        process.kill(pid, 'SIGTERM');
    } catch {}
}

function cleanupLegacySessionFile(filePath: string, logCleanup = false) {
    try {
        if (!existsSync(filePath)) {
            return;
        }
        stopLegacyProcess(readLegacyPid(filePath));
        unlinkSync(filePath);
        if (logCleanup) {
            console.log('[Migration] Cleaned up legacy session file');
        }
    } catch {}
}

function parsePingResult(value: unknown) {
    if (!isRecord(value) || typeof value.uptime !== 'number' || !Number.isFinite(value.uptime)) {
        return null;
    }
    return {uptime: value.uptime};
}

function parseHealthResult(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }

    const healthValue = value.health;
    const health = isRecord(healthValue)
        ? {
            openFileDirect: typeof healthValue.openFileDirect === 'string' ? healthValue.openFileDirect : undefined,
            electronAPI: typeof healthValue.electronAPI === 'string' ? healthValue.electronAPI : undefined,
        }
        : undefined;

    return {
        ready: typeof value.ready === 'boolean' ? value.ready : undefined,
        health,
    };
}

function migrateLegacySessionFiles() {
    const legacySessionFile = join(projectRoot, '.devkit', 'electron-session.json');
    const legacyStartingFile = join(projectRoot, '.devkit', 'electron-session-starting.json');

    cleanupLegacySessionFile(legacySessionFile, true);
    cleanupLegacySessionFile(legacyStartingFile);
}

function printUsage() {
    console.log(`
Electron Puppeteer Control - Multi-Session

Usage:
  pnpm electron:run [--session <name>] <command> [args...]

Options:
  --session <name>, -s <name>   Session name (default: "default")
  --all                         Apply to all sessions (with stop)
  --keep-nuxt                   Keep the default Nuxt dev server alive when stopping one session

Session:
  start               Start session (foreground, Ctrl+C to stop)
  startd              Start session in background (detached) and return
  cleanstart          Start with fresh Nuxt server (clears stale cache)
  stop                Stop session (or --all to stop every session)
  status              Check session health (shows connection status)
  restart             Stop and restart the session (useful for recovery)
  restartd            Stop and restart in detached mode
  list                List all sessions and their status

Commands (require running session):
  health              Check app health status (loaded, API availability)
  screenshot [name] [fullPage]
                     Take screenshot -> .devkit/sessions/<name>/screenshots/<name>.png
  screenshots <baseName> [count] [intervalMs] [fullPage]
                     Capture multiple screenshots at intervals in one command
  console [level] [limit]
                     Get console messages (all|log|warn|error|info|debug)
  devtools [section] [limit]
                     DevTools diagnostics (summary|console|network|errors|metrics|all)
  run <code>          Run Puppeteer code (access: page, screenshot, sleep/wait)
  run-file <path>     Run Puppeteer code from a JS file
  eval <code>         Evaluate JS in page
  click <selector> [timeoutMs]
                     Click element and return captured click-event metadata
  type <sel> <text>   Type into element
  content <selector>  Get text content
  waitfor <selector> [timeoutMs]
                     Wait until selector appears (useful for scripted flows)
  resize <w> <h>      Resize viewport (Puppeteer viewport)
  viewport            Print current viewport dimensions
  openPdf <path>      Open PDF file by absolute path

Examples:
  pnpm electron:run startd                        # Start default session
  pnpm electron:run -s test startd                 # Start "test" session
  pnpm electron:run -s test screenshot "home"      # Screenshot in "test" session
  pnpm electron:run screenshots "progress" 12 500  # 12 shots every 500ms
  pnpm electron:run devtools network 200           # Recent network diagnostics
  pnpm electron:run viewport                       # Read current viewport/window size
  pnpm electron:run resize 1280 820               # Set viewport for deterministic screenshots
  pnpm electron:run list                           # Show all running sessions
  pnpm electron:run stop --all                     # Stop everything
  pnpm electron:run -s test openPdf "/path/to.pdf"
  pnpm electron:run run "await sleep(500); return await page.title()"
`);
}

interface IParsedCliArgs {
    sessionName: string;
    stopAll: boolean;
    keepNuxt: boolean;
    rawCommand: string | null;
    command: TCliCommand | null;
    args: string[];
}

function parseCliArgs(rawArgs: string[]): IParsedCliArgs {
    let sessionName = 'default';
    let stopAll = false;
    let keepNuxt = false;
    const filteredArgs: string[] = [];

    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];
        if (arg?.startsWith('--session=')) {
            sessionName = arg.split('=')[1] ?? 'default';
        } else if (arg === '--session' || arg === '-s') {
            sessionName = rawArgs[++i] ?? 'default';
        } else if (arg === '--all') {
            stopAll = true;
        } else if (arg === '--keep-nuxt') {
            keepNuxt = true;
        } else if (arg) {
            filteredArgs.push(arg);
        }
    }

    const [
        rawCommand = null,
        ...args
    ] = filteredArgs;

    return {
        sessionName,
        stopAll,
        keepNuxt,
        rawCommand,
        command: rawCommand && isCliCommand(rawCommand) ? rawCommand : null,
        args,
    };
}

function resolveCliCommand(parsed: IParsedCliArgs) {
    if (!parsed.rawCommand) {
        printUsage();
        process.exit(0);
    }
    if (!parsed.command) {
        console.error(`Unknown command: ${parsed.rawCommand}`);
        process.exit(1);
    }
    return parsed.command;
}

function printJson(result: unknown) {
    console.log(JSON.stringify(result, null, 2));
}

async function printJsonCommand(command: Parameters<typeof sendCommand>[0], args: string[], timeoutMs?: number) {
    printJson(await sendCommand(command, args, timeoutMs));
}

function requireFirstArg(args: string[], errorMessage: string) {
    const value = args[0];
    if (!value) {
        console.error(errorMessage);
        process.exit(1);
    }
    return value;
}

function requireJoinedArgs(args: string[], errorMessage: string) {
    const code = args.join(' ');
    if (!code) {
        console.error(errorMessage);
        process.exit(1);
    }
    return code;
}

async function printSessionHealthStatus(port: number, uptime: number) {
    try {
        const healthResult = parseHealthResult(await sendCommand('health'));
        if (healthResult?.ready) {
            console.log(`Session '${getCurrentSessionName()}' running (port: ${port}, uptime: ${Math.round(uptime)}s) - App ready \u2713`);
            return;
        }
        const openFileDirect = healthResult?.health?.openFileDirect ?? 'unknown';
        const electronAPI = healthResult?.health?.electronAPI ?? 'unknown';
        console.log(`Session '${getCurrentSessionName()}' running (port: ${port}, uptime: ${Math.round(uptime)}s) - \u26a0\ufe0f  App not ready (openFileDirect=${openFileDirect}, electronAPI=${electronAPI})`);
    } catch {
        console.log(`Session '${getCurrentSessionName()}' running (port: ${port}, uptime: ${Math.round(uptime)}s) - \u26a0\ufe0f  Electron DISCONNECTED`);
        console.log(`  Use \`pnpm electron:run --session=${getCurrentSessionName()} restart\` to recover.`);
    }
}

async function printStatus() {
    const info = getSessionInfo();
    if (!info) {
        console.log(`No session '${getCurrentSessionName()}' running.`);
        process.exit(1);
    }

    try {
        const pingResult = parsePingResult(await sendCommand('ping'));
        if (!pingResult) {
            throw new Error('Malformed ping response payload');
        }
        await printSessionHealthStatus(info.port, pingResult.uptime);
    } catch {
        console.log('Session file exists but server not responding.');
        console.log('  Cleaning up stale session file...');
        try {
            unlinkSync(sessionFilePath());
        } catch {}
        process.exit(1);
    }
}

async function printSessionListItem(name: string) {
    await cleanupStaleSessionArtifacts(name);
    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);

    if (info && isProcessAlive(info.pid)) {
        const running = await isSessionRunning(name);
        const status = running ? 'running' : 'starting';
        console.log(`  ${name}`);
        console.log(`    Status:  ${status}`);
        console.log(`    PID:     ${info.pid}`);
        console.log(`    Ports:   server=${info.port}, cdp=${info.cdpPort}`);
        console.log('');
        return;
    }

    if (starting && isProcessAlive(starting.pid)) {
        console.log(`  ${name}`);
        console.log('    Status:  starting');
        console.log(`    PID:     ${starting.pid}`);
        console.log('');
        return;
    }

    try {
        unlinkSync(sessionFilePath(name));
    } catch {}
    clearSessionStarting(name);
}

async function printSessionList() {
    const names = listAllSessionNames();
    if (names.length === 0) {
        console.log('No sessions found.');
        return;
    }

    console.log('Sessions:\n');
    for (const name of names) {
        await printSessionListItem(name);
    }
}

async function restartSession(detached: boolean) {
    console.log(detached
        ? `Restarting session '${getCurrentSessionName()}' in background...`
        : `Restarting session '${getCurrentSessionName()}'...`);
    await stopSingleSession(getCurrentSessionName());
    await delay(1000);
    if (detached) {
        await startSessionDetached();
    } else {
        await startSession(false);
    }
}

type TCliCommandHandler = (args: string[], parsed: IParsedCliArgs) => Promise<void>;

const CLI_COMMAND_HANDLERS: Record<TCliCommand, TCliCommandHandler> = {
    async start() {
        console.log(`Starting session '${getCurrentSessionName()}'...`);
        await startSession(false);
    },
    async cleanstart() {
        console.log(`Starting fresh session '${getCurrentSessionName()}'...`);
        await startSession(true);
    },
    async startd() {
        await startSessionDetached();
    },
    async stop(args, parsed) {
        void args;
        await stopSession({
            stopAll: parsed.stopAll,
            keepNuxt: parsed.keepNuxt,
        });
    },
    async status() {
        await printStatus();
    },
    async restart() {
        await restartSession(false);
    },
    async restartd() {
        await restartSession(true);
    },
    async list() {
        await printSessionList();
    },
    screenshot: args => printJsonCommand('screenshot', args),
    screenshots: args => printJsonCommand('screenshots', args, 600_000),
    console: args => printJsonCommand('console', args),
    devtools: args => printJsonCommand('devtools', args),
    click: args => printJsonCommand('click', args),
    type: args => printJsonCommand('type', args),
    async content(args) {
        console.log(await sendCommand('content', args));
    },
    waitfor: args => printJsonCommand('waitfor', args, COMMAND_EXECUTION_TIMEOUT_MS),
    resize: args => printJsonCommand('resize', args),
    viewport: args => printJsonCommand('viewport', args),
    async run(args) {
        const code = requireJoinedArgs(args, 'No code provided');
        const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
        if (result !== undefined) {
            printJson(result);
        }
    },
    async 'run-file'(args) {
        const filePath = requireFirstArg(args, 'JS file path required');
        const code = readFileSync(filePath, 'utf8');
        const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
        if (result !== undefined) {
            printJson(result);
        }
    },
    async eval(args) {
        const code = requireJoinedArgs(args, 'No code provided');
        printJson(await sendCommand('eval', [code], COMMAND_EXECUTION_TIMEOUT_MS));
    },
    async openPdf(args) {
        const pdfPath = requireFirstArg(args, 'PDF path required');
        printJson(await sendCommand('openPdf', [pdfPath], COMMAND_EXECUTION_TIMEOUT_MS));
    },
    async health() {
        printJson(await sendCommand('health'));
    },
};

export async function runCli() {
    const parsed = parseCliArgs(process.argv.slice(2));
    setCurrentSessionName(parsed.sessionName);
    migrateLegacySessionFiles();
    const command = resolveCliCommand(parsed);

    try {
        await CLI_COMMAND_HANDLERS[command](parsed.args, parsed);
    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
