import { createServer } from 'node:http';
import {
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { safeJsonParse } from '@contracts/safeJsonParse';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';
import { createCommandHandler } from '@scripts/electron-run/createCommandHandler';
import {
    buildElectronAutomationArgs,
    buildElectronExecutablePath,
    prepareAutomationAppEntry,
    prepareMacOSHiddenAppBundle,
    resolveAutomationRendererReadyEnv,
    resolveAutomationWindowEnv,
    sanitizeElectronLaunchEnv,
    shouldBootstrapInteractiveDevProfile,
    shouldUseMacOSHiddenAppLauncher,
} from '@scripts/electron-run/electronRunLaunchConfig';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { attachPageDiagnostics } from '@scripts/electron-run/attachPageDiagnostics';
import { applyE2ESharedRendererPort } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { E2E_RUN_ID_ENV } from '@scripts/electron-run/electronRunRunId';
import {
    closeActiveDevServerOutputTee,
    getActiveDevServerOutputTee,
    installDevServerOutputTee,
} from '@scripts/electron-run/devServerOutputTee';
import {
    ELECTRON_SERVER_PATH,
    hasOtherAliveSessionUsingNuxt,
    startNuxtServer,
    waitForReusableNuxtServer,
    type INuxtSessionShareMetadata,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    findFreePort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    findSessionOwnedElectronPids,
    isVerifiedSessionProcess,
    killVerifiedSessionProcess,
} from '@scripts/electron-run/electronRunProcessIdentity';
import { formatElectronStartupDiagnostics } from '@scripts/electron-run/electronRunStartupDiagnostics';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { parseElectronRunCommandRequest } from '@scripts/electron-run/electronRunProtocol';
import {
    cleanupStaleSessionArtifacts,
    cleanupSessionStartingAttempt,
    clearSessionStarting,
    getSessionInfo,
    isSessionRunning,
    isSessionStarting,
    listAllSessionNames,
    listRunningSessions,
    markSessionStarting,
    recordSessionStartingAttempt,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    getCurrentSessionName,
    sessionDir,
    sessionFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import type { ISessionState } from '@scripts/electron-run/electronRunSessionTypes';
import { clearAutomationWorkspaceCrashCheckpoint } from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import { SESSION_WAIT_TIMEOUT_MS } from '@scripts/electron-run/electronRunTimeouts';
import {
    connectToBrowser,
    isRendererReadinessError,
    isViteOptimizeDepError,
} from '@scripts/electron-run/rendererReadiness';

export * from '@scripts/electron-run/electronRunLaunchConfig';
export {
    hasOtherAliveSessionUsingNuxt,
    killExistingNuxt,
    selectOrphanedProjectNuxtRootCleanupTargets,
    selectStaleNuxtPortOwnerCleanupTargets,
} from '@scripts/electron-run/electronRunNuxtServer';
export type {
    INuxtPortOwnerSessionMetadata,
    INuxtSessionShareMetadata,
    IProjectNuxtRootProcessMetadata,
} from '@scripts/electron-run/electronRunNuxtServer';
export { isReusableNuxtResponse } from '@scripts/electron-run/isReusableNuxtResponse';
export {
    isElectronAppPageUrl,
    isNuxtDevServerUrl,
    isRendererReadinessError,
} from '@scripts/electron-run/rendererReadiness';
export { startSessionDetached } from '@scripts/electron-run/startSessionDetached';
export {
    stopAllSessions,
    stopSession,
    stopSingleSession,
} from '@scripts/electron-run/stopSession';

let sessionState: ISessionState | null = null;

const handleCommand = createCommandHandler(() => sessionState);
const ELECTRON_START_TIMEOUT_MS = 45_000;
const ELECTRON_LAUNCH_ATTEMPTS = 3;
const ELECTRON_LAUNCH_RETRY_DELAY_MS = 5_000;
const ELECTRON_STARTUP_LOG_MAX_LINES = 300;
const ELECTRON_STARTUP_LOG_TAIL_LINES = 60;
const KEEP_NUXT_ON_STOP_MARKER = 'keep-nuxt-on-stop';
const INITIAL_OPEN_PATHS_ENV = 'EVB_AUTOMATION_INITIAL_OPEN_PATHS';
const ELECTRON_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

export function shouldClearAutomationWorkspaceCrashCheckpointOnExit(exitCode: number) {
    return [
        0,
        130,
        143,
    ].includes(exitCode);
}

export function clearAutomationWorkspaceCrashCheckpointAfterSessionExit(
    exitCode: number,
    sessionName = getCurrentSessionName(),
) {
    return shouldClearAutomationWorkspaceCrashCheckpointOnExit(exitCode)
        && clearAutomationWorkspaceCrashCheckpoint(sessionName);
}

function formatElapsedMs(startedAt: number) {
    return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

function createStartupLogger(startedAt = Date.now()) {
    return (message: string) => {
        console.log(`[Startup +${formatElapsedMs(startedAt)}] ${message}`);
    };
}

async function killProcessTreeForPids(pids: number[], graceMs = 1200) {
    for (const pid of new Set(pids)) {
        await killProcessTree(pid, graceMs);
    }
}

async function killElectronProcessesByCdpPort(cdpPort: number | null | undefined) {
    if (!Number.isFinite(cdpPort) || (cdpPort ?? 0) <= 0) {
        return;
    }

    const pids = findSessionOwnedElectronPids({
        kind: 'electron',
        sessionName: getCurrentSessionName(),
        cdpPort,
    });
    await killProcessTreeForPids(pids, 500);
}

function createElectronStartupLog() {
    const startupLogLines: string[] = [];
    return {
        push(stream: 'stdout' | 'stderr', chunk: string) {
            if (!chunk) {
                return;
            }

            const lines = chunk
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);
            for (const line of lines) {
                startupLogLines.push(`[${stream}] ${line}`);
            }
            if (startupLogLines.length > ELECTRON_STARTUP_LOG_MAX_LINES) {
                startupLogLines.splice(0, startupLogLines.length - ELECTRON_STARTUP_LOG_MAX_LINES);
            }
        },
        formatFailure(reason: string, details: {
            code: number | null;
            signal: NodeJS.Signals | null
        }) {
            const tail = startupLogLines
                .slice(-ELECTRON_STARTUP_LOG_TAIL_LINES)
                .join('\n')
                .trim();
            const exitInfo = `code=${details.code ?? 'null'}, signal=${details.signal ?? 'null'}`;
            const baseMessage = tail
                ? `${reason} (${exitInfo})\n--- Electron output tail ---\n${tail}`
                : `${reason} (${exitInfo})`;
            const includeMacOSLog = details.signal === 'SIGKILL';
            return `${baseMessage}\n${formatElectronStartupDiagnostics({ includeMacOSLog })}`;
        },
    };
}

function buildElectronRuntimeEnv(cdpPort: number, mainJs: string, initialOpenPaths: string[] = []) {
    const automationUserDataDir = electronUserDataPath();
    const automationWindowEnv = resolveAutomationWindowEnv(process.env);
    const shouldBootstrapDevProfile = shouldBootstrapInteractiveDevProfile({
        env: process.env,
        sessionName: getCurrentSessionName(),
        automationWindowEnv,
    });
    const electronRuntimeEnv = {
        ...process.env,
        EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
        EVB_SERVER_PORT: String(getNuxtPort()),
        EVB_SERVER_PATH: ELECTRON_SERVER_PATH,
        EVB_WAIT_RENDERER_READY: resolveAutomationRendererReadyEnv(process.env, automationWindowEnv),
        ...automationWindowEnv,
        EVB_AUTOMATION_USER_DATA_DIR: automationUserDataDir,
        EVB_AUTOMATION_SESSION_NAME: getCurrentSessionName(),
        EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE: shouldBootstrapDevProfile ? '1' : '0',
        EVB_ENABLE_RENDERER_FILE_OPEN_HELPER: '1',
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
        ELECTRON_ENABLE_STACK_DUMPING: process.env.ELECTRON_ENABLE_STACK_DUMPING ?? '1',
    } satisfies NodeJS.ProcessEnv;

    return {
        automationUserDataDir,
        automationWindowEnv,
        electronRuntimeEnv,
        electronArgs: buildElectronAutomationArgs({
            cdpPort,
            automationUserDataDir,
            mainJs,
            initialOpenPaths,
            env: electronRuntimeEnv,
        }),
    };
}

function buildElectronLaunchPlan(cdpPort: number, mainJs: string, initialOpenPaths: string[] = []) {
    const automationAppEntryPath = prepareAutomationAppEntry({
        destinationRoot: join(sessionDir(), 'automation-electron-app-entry'),
        mainJs,
    }).appPath;
    const {
        electronRuntimeEnv,
        electronArgs,
    } = buildElectronRuntimeEnv(cdpPort, automationAppEntryPath, initialOpenPaths);
    const electronPath = buildElectronExecutablePath();
    const electronAppPath = join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
    const launchViaHiddenMacApp = shouldUseMacOSHiddenAppLauncher(electronRuntimeEnv)
        && existsSync(electronAppPath);
    if (!launchViaHiddenMacApp && !existsSync(electronPath)) {
        throw new Error(
            `Electron executable not found at ${electronPath}. `
            + 'Ensure pnpm install completed Electron binary download successfully.',
        );
    }
    const hiddenAutomationBundlePaths = launchViaHiddenMacApp
        ? prepareMacOSHiddenAppBundle({
            sourceAppPath: electronAppPath,
            destinationRoot: join(
                projectRoot,
                '.devkit',
                'tmp',
                'electron-e2e-hidden-app',
                process.env[E2E_RUN_ID_ENV] ?? getCurrentSessionName(),
            ),
        })
        : null;
    const launchCommand = launchViaHiddenMacApp
        ? hiddenAutomationBundlePaths!.executablePath
        : electronPath;

    return {
        launchCommand,
        launchArgs: electronArgs,
        electronRuntimeEnv,
    };
}

function spawnElectronProcess(
    cdpPort: number,
    mainJs: string,
    startupLog: ReturnType<typeof createElectronStartupLog>,
    initialOpenPaths: string[] = [],
) {
    const {
        launchCommand,
        launchArgs,
        electronRuntimeEnv,
    } = buildElectronLaunchPlan(cdpPort, mainJs, initialOpenPaths);
    const electron = spawn(launchCommand, launchArgs, {
        cwd: projectRoot,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        env: sanitizeElectronLaunchEnv(electronRuntimeEnv),
    });

    const onElectronOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
        getActiveDevServerOutputTee()?.write('electron-main-process', stream, data);
        const text = data.toString();
        startupLog.push(stream, text);
        if (text.includes('DevTools listening')) {
            console.log('[Electron] CDP ready');
        }
    };
    electron.stdout?.on('data', (data: Buffer) => onElectronOutput('stdout', data));
    electron.stderr?.on('data', (data: Buffer) => onElectronOutput('stderr', data));
    return electron;
}

function hasElectronExited(electron: ChildProcess, exitDetails: {
    code: number | null;
    signal: NodeJS.Signals | null;
}) {
    const electronPid = electron.pid ?? null;
    const hasKnownPid = typeof electronPid === 'number' && electronPid > 0;
    return exitDetails.code !== null
        || exitDetails.signal !== null
        || (hasKnownPid && !isProcessAlive(electronPid));
}

async function waitForElectronCdp(
    electron: ChildProcess,
    cdpPort: number,
    exitDetails: {
        code: number | null;
        signal: NodeJS.Signals | null;
    },
    startupLog: ReturnType<typeof createElectronStartupLog>,
) {
    const start = Date.now();
    while (Date.now() - start < ELECTRON_START_TIMEOUT_MS) {
        if (hasElectronExited(electron, exitDetails)) {
            throw new Error(startupLog.formatFailure('Electron exited before CDP became ready', exitDetails));
        }

        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
            if (res.ok) {
                console.log('[Electron] App started');
                return electron;
            }
        } catch {}
        await delay(500);
    }

    throw new Error(startupLog.formatFailure('Electron failed to start CDP before timeout', exitDetails));
}

async function stopFailedElectronStartup(electron: ChildProcess, cdpPort: number) {
    await killElectronProcessesByCdpPort(cdpPort);
    if (electron.pid && isProcessAlive(electron.pid)) {
        await killProcessTree(electron.pid, 800);
    } else {
        electron.kill();
    }
}

async function startElectron(cdpPort: number, initialOpenPaths: string[] = []): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.cjs');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.cjs not found. Run `pnpm run build:electron` first.');
    }

    console.log('[Electron] Starting with CDP on port', cdpPort);
    mkdirSync(sessionDir(), { recursive: true });

    const startupLog = createElectronStartupLog();
    const electron = spawnElectronProcess(cdpPort, mainJs, startupLog, initialOpenPaths);
    const exitDetails: {
        code: number | null;
        signal: NodeJS.Signals | null;
    } = {
        code: null,
        signal: null,
    };
    electron.on('exit', (code, signal) => {
        exitDetails.code = code;
        exitDetails.signal = signal;
    });

    try {
        await waitForElectronCdp(electron, cdpPort, exitDetails, startupLog);
        return electron;
    } catch (error) {
        if (!hasElectronExited(electron, exitDetails)) {
            await stopFailedElectronStartup(electron, cdpPort);
        }
        throw error;
    }
}

async function ensureSessionCanStart() {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running. Use \`pnpm electron:run stop --session=${getCurrentSessionName()}\` to stop it.`);
        return false;
    }
    if (!isSessionStarting()) {
        markSessionStarting(process.pid);
        return true;
    }

    console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
    const ready = await waitForSessionReady(90_000);
    if (!ready) {
        throw new Error(`Session '${getCurrentSessionName()}' startup is stuck. Run stop and retry.`);
    }
    return false;
}

function resolveForceCleanStart(forceClean: boolean) {
    const otherRunning = listRunningSessions().filter(name => name !== getCurrentSessionName());
    if (forceClean && otherRunning.length > 0) {
        console.log(`[Nuxt] ${otherRunning.length} other session(s) running (${otherRunning.join(', ')}), skipping Nuxt restart`);
        return {
            forceClean: false,
            otherRunning,
        };
    }
    return {
        forceClean,
        otherRunning,
    };
}

function clearElectronUserDataCache() {
    try {
        rmSync(electronUserDataPath(), {
            recursive: true,
            force: true,
        });
        console.log(`[Cache] Cleared ${electronUserDataPath().replace(projectRoot + '/', '')}`);
    } catch {}
}

async function killStaleElectronForCurrentSession() {
    const staleInfo = getSessionInfo();
    const expectation = {
        kind: 'electron' as const,
        sessionName: getCurrentSessionName(),
        cdpPort: staleInfo?.cdpPort,
    };
    const pids = new Set(findSessionOwnedElectronPids(expectation));

    if (pids.size > 0) {
        await killProcessTreeForPids([...pids], 500);
    }
    if (staleInfo?.electronPid && isProcessAlive(staleInfo.electronPid) && !pids.has(staleInfo.electronPid)) {
        await killVerifiedSessionProcess({
            pid: staleInfo.electronPid,
            expectation,
            graceMs: 500,
        });
    }
    if (staleInfo?.cdpPort) {
        await killElectronProcessesByCdpPort(staleInfo.cdpPort);
    }
    if (pids.size > 0 || staleInfo?.cdpPort) {
        await delay(500);
    }
}

export async function allocateAutomationPorts(logTiming: (message: string) => void) {
    const serverPort = await findFreePort();
    let cdpPort = await findFreePort();
    while (cdpPort === serverPort) cdpPort = await findFreePort();
    const ports = {
        serverPort,
        cdpPort,
    };
    console.log(`[Ports] CDP: ${ports.cdpPort}, HTTP server: ${ports.serverPort}`);
    logTiming('Automation ports allocated');
    return ports;
}

async function stopElectronLaunchAttempt(electronProcess: ChildProcess, cdpPort: number) {
    try {
        if (electronProcess.pid && isProcessAlive(electronProcess.pid)) {
            await killProcessTree(electronProcess.pid, 800);
        } else {
            electronProcess.kill();
        }
    } catch {}
    await killElectronProcessesByCdpPort(cdpPort);
}

async function stopNuxtProcessForFailedSession(nuxtProcess: ChildProcess | null) {
    try {
        if (nuxtProcess?.pid && isProcessAlive(nuxtProcess.pid)) {
            await killProcessTree(nuxtProcess.pid, 1200);
        } else {
            nuxtProcess?.kill();
        }
    } catch {}
}

interface IAutomationLaunchResult {
    electronProcess: ChildProcess;
    browser: Browser;
    page: Page;
    nuxtProcess: ChildProcess | null;
    cdpPort: number;
}

interface IStartSessionOptions {initialOpenPaths?: string[];}

function normalizeInitialOpenPaths(paths: string[] | undefined) {
    return (paths ?? [])
        .map(path => path.trim())
        .filter(Boolean);
}

function readInitialOpenPathsFromEnv(env: NodeJS.ProcessEnv = process.env) {
    const rawValue = env[INITIAL_OPEN_PATHS_ENV];
    if (!rawValue) {
        return [];
    }

    try {
        const parsed = safeJsonParse(rawValue);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return normalizeInitialOpenPaths(parsed.filter((value): value is string => typeof value === 'string'));
    } catch {
        return [];
    }
}

async function launchAutomationSessionWithRecovery(options: {
    cdpPort: number;
    initialOpenPaths: string[];
    nuxtProcess: ChildProcess | null;
    otherRunning: string[];
    usesSharedRenderer: boolean;
    logTiming: (message: string) => void;
}): Promise<IAutomationLaunchResult> {
    let cdpPort = options.cdpPort;
    let nuxtProcess = options.nuxtProcess;
    let launchError: unknown = null;

    for (let attempt = 0; attempt < ELECTRON_LAUNCH_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            cdpPort = await findFreePort();
            console.log(`[Recovery] Retrying launch (attempt ${attempt + 1}/${ELECTRON_LAUNCH_ATTEMPTS}) with CDP port ${cdpPort}`);
        }

        let electronProcess: ChildProcess | null = null;

        try {
            recordSessionStartingAttempt({
                cdpPorts: [cdpPort],
                electronUserDataDir: electronUserDataPath(),
                nuxtPid: nuxtProcess?.pid ?? null,
                nuxtPort: getNuxtPort(),
            });
            electronProcess = await startElectron(cdpPort, options.initialOpenPaths);
            if (electronProcess.pid) {
                recordSessionStartingAttempt({electronPids: [electronProcess.pid]});
            }
            options.logTiming('Electron process/CDP ready');
            const {
                browser,
                page,
            } = await connectToBrowser(cdpPort);
            options.logTiming('Browser automation attached');
            return {
                electronProcess,
                browser,
                page,
                nuxtProcess,
                cdpPort,
            };
        } catch (error) {
            launchError = error;
            const message = error instanceof Error ? error.message : String(error);
            const phase = electronProcess ? 'connect to browser' : 'start Electron';
            console.error(`[Session] Failed to ${phase}: ${message}`);
            if (electronProcess) {
                await stopElectronLaunchAttempt(electronProcess, cdpPort);
            } else {
                await killElectronProcessesByCdpPort(cdpPort);
            }

            if (isRendererReadinessError(error)) {
                throw error;
            }

            if (attempt === 0 && isViteOptimizeDepError(error)) {
                if (options.usesSharedRenderer) {
                    throw new Error('Detected Vite optimize-dep failure from the shared Electron E2E renderer. Restart the Vitest run so globalSetup can recreate the renderer.');
                }
                if (options.otherRunning.length > 0) {
                    throw new Error(`Detected Vite optimize-dep failure, but other sessions are active (${options.otherRunning.join(', ')}). Stop them and run cleanstart.`);
                }
                console.log('[Recovery] Detected Vite optimize-dep issue. Restarting Nuxt with cleared cache...');
                nuxtProcess = await startNuxtServer(true);
                continue;
            }

            if (attempt === 0 && message.includes('frame was detached')) {
                console.log('[Recovery] Frame detached during initial page load — retrying...');
                await delay(2000);
                continue;
            }

            if (attempt < ELECTRON_LAUNCH_ATTEMPTS - 1) {
                console.log('[Recovery] Electron launch failed before readiness — retrying...');
                await delay(ELECTRON_LAUNCH_RETRY_DELAY_MS);
                continue;
            }

            break;
        }
    }

    console.error('[Session] Failed to initialize app session, cleaning up...');
    await stopNuxtProcessForFailedSession(nuxtProcess);
    if (launchError instanceof Error) {
        throw launchError;
    }
    throw new Error('Failed to initialize Electron session');
}

function readNuxtSessionShareMetadata(): INuxtSessionShareMetadata[] {
    return listAllSessionNames()
        .flatMap((name) => {
            const info = getSessionInfo(name);
            if (!info) {
                return [];
            }

            return [{
                name,
                sessionAlive: isVerifiedSessionProcess(info.pid, {
                    kind: 'controller',
                    sessionName: name,
                }),
                nuxtPid: info.nuxtPid,
                nuxtPort: info.nuxtPort,
            }];
        });
}

async function stopSessionElectronProcess(state: ISessionState | null) {
    if (!state) {
        return;
    }

    const electronPid = state.electronProcess.pid ?? null;
    const shutdownStartedAt = Date.now();
    if (state.browser.connected) {
        console.log('[Electron] Requesting graceful app shutdown...');
        const didRequestWindowClose = await Promise.race([
            state.page.evaluate(() => {
                const rendererWindow = window as Window & {electronAPI?: {windowTabs: IWindowTabsCapability}};
                const closeCurrentWindow = rendererWindow.electronAPI?.windowTabs.closeCurrentWindow;
                if (!closeCurrentWindow) {
                    return false;
                }
                void closeCurrentWindow();
                return true;
            }).catch(() => false),
            delay(1_000).then(() => false),
        ]);
        if (!didRequestWindowClose) {
            console.warn('[Electron] Renderer window close request did not complete before the deadline');
        }
    }

    if (electronPid) {
        const remainingMs = Math.max(
            0,
            ELECTRON_GRACEFUL_SHUTDOWN_TIMEOUT_MS - (Date.now() - shutdownStartedAt),
        );
        if (remainingMs > 0 && await waitForProcessExit(electronPid, remainingMs)) {
            console.log('[Electron] Graceful app shutdown complete');
            return;
        }
        if (!isProcessAlive(electronPid)) {
            console.log('[Electron] Graceful app shutdown complete');
            return;
        }
    }

    if (state.browser.connected) {
        await state.browser.close().catch(() => {});
    }
    await state.browser.disconnect().catch(() => {});
    console.warn('[Electron] Graceful shutdown timed out; using process-tree fallback');
    try {
        if (electronPid && isProcessAlive(electronPid)) {
            await killProcessTree(electronPid, 800);
        } else {
            state.electronProcess.kill();
        }
    } catch {}
}

async function stopSessionNuxtProcess(state: ISessionState | null, keepNuxtOnStop: boolean) {
    if (!state?.nuxtProcess) {
        return;
    }
    if (keepNuxtOnStop) {
        state.nuxtProcess.unref();
        return;
    }
    const nuxtPid = state.nuxtProcess.pid ?? null;
    if (
        nuxtPid
        && hasOtherAliveSessionUsingNuxt(
            readNuxtSessionShareMetadata(),
            getCurrentSessionName(),
            nuxtPid,
            getNuxtPort(),
        )
    ) {
        console.log('[Nuxt] Left running (shared with other session)');
        return;
    }
    try {
        if (state.nuxtProcess.pid && isProcessAlive(state.nuxtProcess.pid)) {
            await killProcessTree(state.nuxtProcess.pid, 1200);
        } else {
            state.nuxtProcess.kill();
        }
    } catch {}
}

function clearRuntimeSessionFiles() {
    try {
        unlinkSync(sessionFilePath());
    } catch {}
    try {
        unlinkSync(join(sessionDir(), KEEP_NUXT_ON_STOP_MARKER));
    } catch {}
    clearSessionStarting();
}

async function cleanupSessionAndExit(exitCode: number, httpServer: ReturnType<typeof createServer> | null) {
    console.log('\nShutting down...');
    const keepNuxtOnStop = existsSync(join(sessionDir(), KEEP_NUXT_ON_STOP_MARKER));
    if (keepNuxtOnStop) {
        console.log('[Nuxt] Keeping dev server alive for fast restart');
    }

    clearRuntimeSessionFiles();
    httpServer?.close();
    await stopSessionElectronProcess(sessionState);
    // SIGINT/SIGTERM are normal developer-owned restarts. Electron has already
    // been closed gracefully above, so retaining its checkpoint here turns a
    // successful `pnpm dev` restart into an accidental document restore.
    clearAutomationWorkspaceCrashCheckpointAfterSessionExit(exitCode);
    await stopSessionNuxtProcess(sessionState, keepNuxtOnStop);
    sessionState = null;
    closeActiveDevServerOutputTee();
    process.exit(exitCode);
}

function getSignalExitCode(signal: NodeJS.Signals) {
    if (signal === 'SIGINT') {
        return 130;
    }
    return 143;
}

function installStartupSignalCleanup() {
    let active = true;
    let cleanupStarted = false;
    let cleanupPromise: Promise<void> | null = null;

    const handleStartupSignal = (signal: NodeJS.Signals) => {
        if (!active || cleanupStarted) {
            return;
        }
        cleanupStarted = true;
        console.log(`\n[Session] Received ${signal} during startup, cleaning up...`);
        cleanupPromise = cleanupSessionStartingAttempt()
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[Session] Startup cleanup failed: ${message}`);
            })
            .finally(() => {
                process.exit(getSignalExitCode(signal));
            });
        void cleanupPromise;
    };

    process.once('SIGINT', handleStartupSignal);
    process.once('SIGTERM', handleStartupSignal);

    return {
        disarm() {
            active = false;
            process.off('SIGINT', handleStartupSignal);
            process.off('SIGTERM', handleStartupSignal);
        },
        wasTriggered() {
            return cleanupStarted;
        },
        async waitForCleanup() {
            await cleanupPromise;
        },
    };
}

function createSessionCommandServer(onShutdownRequest: () => void) {
    return createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method not allowed');
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            try {
                const requestPayload = parseElectronRunCommandRequest(safeJsonParse(body));
                if (!requestPayload) {
                    throw new Error('Malformed command payload');
                }
                if (requestPayload.command === 'shutdown') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        result: { accepted: true },
                    }), () => {
                        setImmediate(onShutdownRequest);
                    });
                    return;
                }
                const result = await handleCommand(requestPayload.command, requestPayload.args);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    result,
                }));
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
        });
    });
}

function listenForSessionCommands(options: {
    server: ReturnType<typeof createServer>;
    serverPort: number;
    cdpPort: number;
    electronProcess: ChildProcess;
    nuxtProcess: ChildProcess | null;
    logTiming: (message: string) => void;
}) {
    options.server.listen(options.serverPort, '127.0.0.1', () => {
        mkdirSync(sessionDir(), { recursive: true });
        writeFileSync(sessionFilePath(), JSON.stringify({
            port: options.serverPort,
            pid: process.pid,
            cdpPort: options.cdpPort,
            electronPid: options.electronProcess.pid ?? null,
            nuxtPid: options.nuxtProcess?.pid ?? null,
            nuxtPort: getNuxtPort(),
            runId: process.env[E2E_RUN_ID_ENV] ?? null,
        }));
        clearSessionStarting();

        console.log(`\n\u2713 Session '${getCurrentSessionName()}' ready on port ${options.serverPort}`);
        options.logTiming('Session command server ready');
        console.log('  Press Ctrl+C to stop\n');
    });
}

export async function startSession(forceClean = false, options: IStartSessionOptions = {}) {
    const outputTee = installDevServerOutputTee();
    if (outputTee) {
        console.log(`[DevOutput] Tee logs: ${outputTee.relativeRunDir}`);
    }

    const logTiming = createStartupLogger();
    if (!await ensureSessionCanStart()) {
        closeActiveDevServerOutputTee();
        return;
    }

    console.log(`Starting Electron Puppeteer session '${getCurrentSessionName()}'...\n`);
    const startupSignalCleanup = installStartupSignalCleanup();
    const stopIfStartupInterrupted = async () => {
        if (!startupSignalCleanup.wasTriggered()) {
            return false;
        }
        await startupSignalCleanup.waitForCleanup();
        return true;
    };

    try {
        const sharedRenderer = applyE2ESharedRendererPort(process.env);
        const startupOptions = resolveForceCleanStart(sharedRenderer ? false : forceClean);
        let nuxtProcess: ChildProcess | null = null;
        if (sharedRenderer) {
            console.log(`[Nuxt] Using shared Electron E2E renderer at http://127.0.0.1:${sharedRenderer.port}/electron`);
            if (!await waitForReusableNuxtServer(30_000)) {
                throw new Error(`Shared Electron E2E renderer on port ${sharedRenderer.port} did not become reusable`);
            }
            logTiming('Shared renderer reuse confirmed');
        } else {
            nuxtProcess = await startNuxtServer(startupOptions.forceClean);
            logTiming('Nuxt startup phase complete');
        }
        if (await stopIfStartupInterrupted()) {
            return;
        }

        if (!sharedRenderer && startupOptions.forceClean) {
            clearElectronUserDataCache();
        }

        await killStaleElectronForCurrentSession();
        if (await stopIfStartupInterrupted()) {
            return;
        }
        const ports = await allocateAutomationPorts(logTiming);
        if (await stopIfStartupInterrupted()) {
            return;
        }
        const initialOpenPaths = normalizeInitialOpenPaths([
            ...readInitialOpenPathsFromEnv(),
            ...(options.initialOpenPaths ?? []),
        ]);
        if (initialOpenPaths.length > 0) {
            console.log(`[Electron] Initial open path(s): ${initialOpenPaths.length}`);
        }
        const launch = await launchAutomationSessionWithRecovery({
            cdpPort: ports.cdpPort,
            initialOpenPaths,
            nuxtProcess,
            otherRunning: startupOptions.otherRunning,
            usesSharedRenderer: sharedRenderer !== null,
            logTiming,
        });
        if (await stopIfStartupInterrupted()) {
            return;
        }
        const diagnostics = attachPageDiagnostics(launch.page);

        sessionState = {
            browser: launch.browser,
            page: launch.page,
            electronProcess: launch.electronProcess,
            nuxtProcess: launch.nuxtProcess,
            consoleMessages: diagnostics.consoleMessages,
            devtoolsEvents: diagnostics.devtoolsEvents,
        };

        let isShuttingDown = false;
        let httpServer: ReturnType<typeof createServer> | null = null;
        const cleanupAndExit = async (exitCode: number) => {
            if (isShuttingDown) {
                return;
            }
            isShuttingDown = true;
            await cleanupSessionAndExit(exitCode, httpServer);
        };

        launch.electronProcess.on('exit', (code, signal) => {
            if (isShuttingDown) {
                return;
            }
            console.log(`\n[Electron] Process exited (code: ${code}, signal: ${signal})`);
            console.log('[Session] Electron died - shutting down session...');
            void cleanupAndExit(1);
        });

        launch.browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
            console.log('\n[Puppeteer] Browser disconnected');
            console.log('[Session] Lost connection to Electron - shutting down session...');
            void cleanupAndExit(1);
        });

        const server = createSessionCommandServer(() => {
            void cleanupAndExit(0);
        });
        httpServer = server;
        listenForSessionCommands({
            server,
            serverPort: ports.serverPort,
            cdpPort: launch.cdpPort,
            electronProcess: launch.electronProcess,
            nuxtProcess: launch.nuxtProcess,
            logTiming,
        });

        startupSignalCleanup.disarm();
        process.on('SIGINT', () => {
            void cleanupAndExit(0);
        });
        process.on('SIGTERM', () => {
            void cleanupAndExit(0);
        });

        await new Promise(() => {});
    } catch (error) {
        startupSignalCleanup.disarm();
        await cleanupSessionStartingAttempt();
        clearSessionStarting();
        closeActiveDevServerOutputTee();
        throw error;
    }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessAlive(pid);
}

export async function waitForSessionReady(timeoutMs = SESSION_WAIT_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            return true;
        }
        await delay(250);
    }
    return false;
}
