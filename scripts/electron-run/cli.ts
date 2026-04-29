import {
    existsSync,
    readFileSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { safeDestr } from 'destr';
import { delay } from 'es-toolkit/promise';
import { sendCommand } from './client';
import {
    COMMAND_EXECUTION_TIMEOUT_MS,
    cleanupStaleSessionArtifacts,
    clearSessionStarting,
    getCurrentSessionName,
    getSessionInfo,
    getSessionStartingInfo,
    isProcessAlive,
    isSessionRunning,
    listAllSessionNames,
    projectRoot,
    sessionFilePath,
    setCurrentSessionName,
} from './shared';
import {
    startSession,
    startSessionDetached,
    stopSession,
    stopSingleSession,
} from './session-manager';

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

    try {
        if (existsSync(legacySessionFile)) {
            const pid = readLegacyPid(legacySessionFile);
            if (pid && isProcessAlive(pid)) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {}
            }
            unlinkSync(legacySessionFile);
            console.log('[Migration] Cleaned up legacy session file');
        }
    } catch {}

    try {
        if (existsSync(legacyStartingFile)) {
            const pid = readLegacyPid(legacyStartingFile);
            if (pid && isProcessAlive(pid)) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {}
            }
            unlinkSync(legacyStartingFile);
        }
    } catch {}
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

export async function runCli() {
    const rawArgs = process.argv.slice(2);

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

    setCurrentSessionName(sessionName);
    const [
        rawCommand,
        ...args
    ] = filteredArgs;

    migrateLegacySessionFiles();

    if (!rawCommand) {
        printUsage();
        process.exit(0);
    }
    if (!isCliCommand(rawCommand)) {
        console.error(`Unknown command: ${rawCommand}`);
        process.exit(1);
    }
    const command = rawCommand;

    try {
        switch (command) {
            case 'start':
                console.log(`Starting session '${getCurrentSessionName()}'...`);
                await startSession(false);
                break;

            case 'cleanstart':
                console.log(`Starting fresh session '${getCurrentSessionName()}'...`);
                await startSession(true);
                break;

            case 'startd':
                await startSessionDetached();
                break;

            case 'stop':
                await stopSession({
                    stopAll,
                    keepNuxt,
                });
                break;

            case 'status': {
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
                    try {
                        const healthResult = parseHealthResult(await sendCommand('health'));
                        if (healthResult?.ready) {
                            console.log(`Session '${getCurrentSessionName()}' running (port: ${info.port}, uptime: ${Math.round(pingResult.uptime)}s) - App ready \u2713`);
                        } else {
                            const openFileDirect = healthResult?.health?.openFileDirect ?? 'unknown';
                            const electronAPI = healthResult?.health?.electronAPI ?? 'unknown';
                            console.log(`Session '${getCurrentSessionName()}' running (port: ${info.port}, uptime: ${Math.round(pingResult.uptime)}s) - \u26a0\ufe0f  App not ready (openFileDirect=${openFileDirect}, electronAPI=${electronAPI})`);
                        }
                    } catch {
                        console.log(`Session '${getCurrentSessionName()}' running (port: ${info.port}, uptime: ${Math.round(pingResult.uptime)}s) - \u26a0\ufe0f  Electron DISCONNECTED`);
                        console.log(`  Use \`pnpm electron:run --session=${getCurrentSessionName()} restart\` to recover.`);
                    }
                } catch {
                    console.log('Session file exists but server not responding.');
                    console.log('  Cleaning up stale session file...');
                    try {
                        unlinkSync(sessionFilePath());
                    } catch {}
                    process.exit(1);
                }
                break;
            }

            case 'restart':
                console.log(`Restarting session '${getCurrentSessionName()}'...`);
                await stopSingleSession(getCurrentSessionName());
                await delay(1000);
                await startSession(false);
                break;

            case 'restartd':
                console.log(`Restarting session '${getCurrentSessionName()}' in background...`);
                await stopSingleSession(getCurrentSessionName());
                await delay(1000);
                await startSessionDetached();
                break;

            case 'list': {
                const names = listAllSessionNames();
                if (names.length === 0) {
                    console.log('No sessions found.');
                    break;
                }

                console.log('Sessions:\n');
                for (const name of names) {
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
                    } else if (starting && isProcessAlive(starting.pid)) {
                        console.log(`  ${name}`);
                        console.log('    Status:  starting');
                        console.log(`    PID:     ${starting.pid}`);
                        console.log('');
                    } else {
                        try {
                            unlinkSync(sessionFilePath(name));
                        } catch {}
                        clearSessionStarting(name);
                    }
                }
                break;
            }

            case 'screenshot': {
                const result = await sendCommand('screenshot', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'screenshots': {
                const result = await sendCommand('screenshots', args, 600_000);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'console': {
                const result = await sendCommand('console', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'devtools': {
                const result = await sendCommand('devtools', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'click': {
                const result = await sendCommand('click', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'type': {
                const result = await sendCommand('type', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'content': {
                const result = await sendCommand('content', args);
                console.log(result);
                break;
            }

            case 'waitfor': {
                const result = await sendCommand('waitfor', args, COMMAND_EXECUTION_TIMEOUT_MS);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'resize': {
                const result = await sendCommand('resize', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'viewport': {
                const result = await sendCommand('viewport', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'run': {
                const code = args.join(' ');
                if (!code) {
                    console.error('No code provided');
                    process.exit(1);
                }
                const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
                if (result !== undefined) {
                    console.log(JSON.stringify(result, null, 2));
                }
                break;
            }

            case 'run-file': {
                const filePath = args[0];
                if (!filePath) {
                    console.error('JS file path required');
                    process.exit(1);
                }
                const code = readFileSync(filePath, 'utf8');
                const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
                if (result !== undefined) {
                    console.log(JSON.stringify(result, null, 2));
                }
                break;
            }

            case 'eval': {
                const code = args.join(' ');
                if (!code) {
                    console.error('No code provided');
                    process.exit(1);
                }
                const result = await sendCommand('eval', [code], COMMAND_EXECUTION_TIMEOUT_MS);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'openPdf': {
                const pdfPath = args[0];
                if (!pdfPath) {
                    console.error('PDF path required');
                    process.exit(1);
                }
                const result = await sendCommand('openPdf', [pdfPath], COMMAND_EXECUTION_TIMEOUT_MS);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'health': {
                const result = await sendCommand('health');
                console.log(JSON.stringify(result, null, 2));
                break;
            }
        }
    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
