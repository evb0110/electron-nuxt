import { createServer } from 'node:http';
import {
    execFileSync,
    execSync,
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    join,
} from 'node:path';
import puppeteer, {
    type Browser,
    type HTTPResponse,
    type Page,
} from 'puppeteer-core';
import { safeDestr } from 'destr';
import { uniq } from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';
import { createCommandHandler } from './commands';
import {
    DEFAULT_NUXT_PORT,
    getNuxtPort,
    setNuxtPort,
    SESSION_WAIT_TIMEOUT_MS,
    cleanupStaleSessionArtifacts,
    clearSessionStarting,
    electronUserDataPath,
    findPidsByCommandSubstring,
    findFreePort,
    getCurrentSessionName,
    getPidsOnPort,
    getSessionInfo,
    getSessionStartingInfo,
    isProcessAlive,
    isSessionRunning,
    isSessionStarting,
    killProcessTree,
    killPids,
    listAllSessionNames,
    listRunningSessions,
    markSessionStarting,
    parseElectronRunCommandRequest,
    projectRoot,
    readSessionLogTail,
    sessionDir,
    sessionFilePath,
    sessionLogFilePath,
    type ISessionState,
} from './shared';

let sessionState: ISessionState | null = null;

const handleCommand = createCommandHandler(() => sessionState);
const MAX_CONSOLE_MESSAGES = 400;
const MAX_DEVTOOLS_EVENTS = 1200;
const RENDERER_READY_TIMEOUT_MS = 15_000;
const ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS = 20_000;
const VITE_OPTIMIZE_DEP_ERROR_MARKER = 'VITE_OPTIMIZE_DEP_504';
const ELECTRON_START_TIMEOUT_MS = 45_000;
const ELECTRON_STARTUP_LOG_MAX_LINES = 300;
const ELECTRON_STARTUP_LOG_TAIL_LINES = 60;
const ELECTRON_SERVER_PATH = '/electron';
const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const KEEP_NUXT_ON_STOP_MARKER = 'keep-nuxt-on-stop';
const TRUTHY_ENV_VALUES = new Set([
    '1',
    'true',
    'yes',
    'on',
]);

function formatElapsedMs(startedAt: number) {
    return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

function createStartupLogger(startedAt = Date.now()) {
    return (message: string) => {
        console.log(`[Startup +${formatElapsedMs(startedAt)}] ${message}`);
    };
}

function pushBounded<T>(collection: T[], item: T, maxSize: number) {
    collection.push(item);
    if (collection.length > maxSize) {
        collection.splice(0, collection.length - maxSize);
    }
}

function createViteOptimizeDepError(details = '') {
    const message = details
        ? `${VITE_OPTIMIZE_DEP_ERROR_MARKER}: ${details}`
        : VITE_OPTIMIZE_DEP_ERROR_MARKER;
    const error = new Error(message);
    error.name = 'ViteOptimizeDepError';
    return error;
}

function isViteOptimizeDepError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === 'ViteOptimizeDepError'
        || error.message.includes(VITE_OPTIMIZE_DEP_ERROR_MARKER)
        || error.message.includes('Outdated Optimize Dep')
        || error.message.includes('optimize-dep');
}

function isTransientPageContextError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.message.includes('Execution context was destroyed')
        || error.message.includes('Attempted to use detached Frame')
        || error.message.includes('Cannot find context with specified id')
        || error.message.includes('Most likely the page has been closed');
}

export function shouldDisableAutomationSandbox(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
) {
    const explicitSetting = env.EVB_AUTOMATION_DISABLE_SANDBOX?.trim().toLowerCase();
    if (explicitSetting) {
        return TRUTHY_ENV_VALUES.has(explicitSetting);
    }

    return platform === 'linux' && env.CI === 'true';
}

export function buildElectronAutomationArgs(options: {
    cdpPort: number;
    automationUserDataDir: string;
    mainJs: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}) {
    const args = [
        `--remote-debugging-port=${options.cdpPort}`,
        `--user-data-dir=${options.automationUserDataDir}`,
        '--disable-http-cache',
        options.mainJs,
    ];

    if (shouldDisableAutomationSandbox(options.env, options.platform)) {
        args.unshift(
            '--disable-setuid-sandbox',
            '--no-sandbox',
        );
    }

    return args;
}

export function sanitizeElectronLaunchEnv(env: NodeJS.ProcessEnv) {
    const launchEnv = { ...env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    return launchEnv;
}

export function buildNuxtDevServerEnv(env: NodeJS.ProcessEnv, port: number) {
    return {
        ...env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_IGNORE_LOCK: env.NUXT_IGNORE_LOCK ?? '1',
    };
}

export function resolveAutomationWindowEnv(
    env: NodeJS.ProcessEnv = process.env,
    options?: { isTTY?: boolean },
) {
    const isTTY = options?.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    const defaultFlag = isTTY ? '0' : '1';
    const noFocus = env.EVB_AUTOMATION_NO_FOCUS ?? defaultFlag;
    const hideWindow = env.EVB_AUTOMATION_HIDE_WINDOW ?? env.EVB_AUTOMATION_NO_FOCUS ?? defaultFlag;

    return {
        EVB_AUTOMATION_NO_FOCUS: noFocus,
        EVB_AUTOMATION_HIDE_WINDOW: hideWindow,
    };
}

export function shouldUseMacOSHiddenAppLauncher(
    env: NodeJS.ProcessEnv,
    platform = process.platform,
) {
    return platform === 'darwin'
        && (env.EVB_AUTOMATION_HIDE_WINDOW === '1' || env.EVB_AUTOMATION_NO_FOCUS === '1');
}

export function shouldBootstrapInteractiveDevProfile(options: {
    env?: NodeJS.ProcessEnv;
    sessionName?: string;
    automationWindowEnv?: ReturnType<typeof resolveAutomationWindowEnv>;
    isTTY?: boolean;
}) {
    const env = options.env ?? process.env;
    const sessionName = options.sessionName ?? getCurrentSessionName();
    const automationWindowEnv = options.automationWindowEnv ?? resolveAutomationWindowEnv(env, { isTTY: options.isTTY });

    return env.CI !== 'true'
        && sessionName === 'default'
        && automationWindowEnv.EVB_AUTOMATION_NO_FOCUS === '0'
        && automationWindowEnv.EVB_AUTOMATION_HIDE_WINDOW === '0';
}

export function buildMacOSHiddenAppBundlePaths(options: {
    sourceAppPath: string;
    destinationRoot: string;
}) {
    const appPath = join(options.destinationRoot, basename(options.sourceAppPath));
    return {
        appPath,
        executablePath: join(
            appPath,
            'Contents',
            'MacOS',
            basename(options.sourceAppPath, '.app'),
        ),
        infoPlistPath: join(appPath, 'Contents', 'Info.plist'),
    };
}

export function buildElectronExecutablePath(options?: {
    platform?: NodeJS.Platform;
    rootDir?: string;
}) {
    const platform = options?.platform ?? process.platform;
    const rootDir = options?.rootDir ?? projectRoot;
    const distDir = join(rootDir, 'node_modules', 'electron', 'dist');

    // Automation must launch the real Electron binary here.
    // The npm shim can fail in CI/package environments before Electron starts.
    if (platform === 'darwin') {
        return join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    }

    if (platform === 'win32') {
        return join(distDir, 'electron.exe');
    }

    return join(distDir, 'electron');
}

function setMacOSAutomationAgentMode(infoPlistPath: string) {
    const replaceArgs = [
        '-replace',
        'LSUIElement',
        '-bool',
        'YES',
        infoPlistPath,
    ];
    const insertArgs = [
        '-insert',
        'LSUIElement',
        '-bool',
        'YES',
        infoPlistPath,
    ];

    try {
        execFileSync('/usr/bin/plutil', replaceArgs, { stdio: 'ignore' });
    } catch {
        execFileSync('/usr/bin/plutil', insertArgs, { stdio: 'ignore' });
    }
}

function prepareMacOSHiddenAppBundle(options: {
    sourceAppPath: string;
    destinationRoot: string;
}) {
    const bundlePaths = buildMacOSHiddenAppBundlePaths(options);
    rmSync(bundlePaths.appPath, {
        recursive: true,
        force: true,
    });
    mkdirSync(options.destinationRoot, { recursive: true });
    execFileSync('/usr/bin/ditto', [
        options.sourceAppPath,
        bundlePaths.appPath,
    ], { stdio: 'ignore' });
    setMacOSAutomationAgentMode(bundlePaths.infoPlistPath);
    return bundlePaths;
}

export function buildMacOSAutomationAppEntryPaths(destinationRoot: string) {
    const appPath = join(destinationRoot, 'automation-app');
    return {
        appPath,
        packageJsonPath: join(appPath, 'package.json'),
        mainJsPath: join(appPath, 'main.js'),
    };
}

function prepareMacOSAutomationAppEntry(options: {
    destinationRoot: string;
    mainJs: string;
}) {
    const entryPaths = buildMacOSAutomationAppEntryPaths(options.destinationRoot);
    rmSync(entryPaths.appPath, {
        recursive: true,
        force: true,
    });
    mkdirSync(entryPaths.appPath, { recursive: true });
    writeFileSync(entryPaths.packageJsonPath, JSON.stringify({
        name: 'evb-automation-app',
        main: 'main.js',
    }, null, 2));
    writeFileSync(entryPaths.mainJsPath, [
        '(async () => {',
        `  await import(${JSON.stringify(options.mainJs)});`,
        '})();',
        '',
    ].join('\n'));
    return entryPaths;
}

async function killProcessTreeForPids(pids: number[], graceMs = 1200) {
    for (const pid of uniq(pids)) {
        await killProcessTree(pid, graceMs);
    }
}

function getDescendantPids(rootPid: number) {
    if (!Number.isFinite(rootPid) || rootPid <= 0 || process.platform === 'win32') {
        return [] as number[];
    }

    try {
        const output = execSync('ps -eo pid=,ppid=', { encoding: 'utf8' });
        const childrenByParent = new Map<number, number[]>();
        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            const parts = trimmed.split(/\s+/);
            const pid = Number(parts[0]);
            const ppid = Number(parts[1]);
            if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0 || ppid <= 0) {
                continue;
            }

            const bucket = childrenByParent.get(ppid) ?? [];
            bucket.push(pid);
            childrenByParent.set(ppid, bucket);
        }

        const descendants: number[] = [];
        const stack = [rootPid];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const children = childrenByParent.get(current) ?? [];
            for (const childPid of children) {
                descendants.push(childPid);
                stack.push(childPid);
            }
        }
        return descendants;
    } catch {
        return [] as number[];
    }
}

async function killElectronProcessesByCdpPort(cdpPort: number | null | undefined) {
    if (!Number.isFinite(cdpPort) || (cdpPort ?? 0) <= 0) {
        return;
    }

    const pids = findPidsByCommandSubstring(`--remote-debugging-port=${cdpPort}`);
    await killProcessTreeForPids(pids, 500);
}

async function isNuxtRunning(): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${getNuxtPort()}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(500),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export function isReusableNuxtResponse(options: {
    poweredBy: string | null;
    body: string;
}) {
    return (options.poweredBy?.toLowerCase() ?? '').includes('nuxt')
        && options.body.includes('/_nuxt/');
}

async function isReusableNuxtServer(): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${getNuxtPort()}${ELECTRON_SERVER_PATH}`, {
            method: 'GET',
            signal: AbortSignal.timeout(1000),
        });
        if (!res.ok) {
            return false;
        }
        const poweredBy = res.headers.get('x-powered-by')?.toLowerCase() ?? '';
        const text = await res.text();
        return isReusableNuxtResponse({
            poweredBy,
            body: text,
        });
    } catch {
        return false;
    }
}

async function waitForReusableNuxtServer(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isReusableNuxtServer()) {
            return true;
        }
        await delay(250);
    }
    return false;
}

export async function killExistingNuxt(): Promise<void> {
    try {
        const pids = getPidsOnPort(getNuxtPort());
        await killProcessTreeForPids(pids, 1200);
        killPids(pids);
        await delay(500);
    } catch {}
}

function clearViteCache(): void {
    const cachePaths = [
        join(projectRoot, 'node_modules', '.vite'),
        join(projectRoot, 'node_modules', '.cache', 'vite'),
        join(projectRoot, '.nuxt'),
    ];

    for (const cachePath of cachePaths) {
        try {
            rmSync(cachePath, {
                recursive: true,
                force: true,
            });
            console.log(`[Cache] Cleared ${cachePath.replace(projectRoot + '/', '')}`);
        } catch {}
    }
}

async function cleanupStaleNuxtPortOwners(reason: string) {
    const pidsOnPort = getPidsOnPort(getNuxtPort());
    if (pidsOnPort.length === 0) {
        return false;
    }

    const managedNuxtPids = new Set<number>();
    const runningSessions = listRunningSessions();
    for (const name of runningSessions) {
        const info = getSessionInfo(name);
        const nuxtPid = info?.nuxtPid ?? null;
        if (!nuxtPid || !isProcessAlive(nuxtPid)) {
            continue;
        }
        managedNuxtPids.add(nuxtPid);
        for (const childPid of getDescendantPids(nuxtPid)) {
            managedNuxtPids.add(childPid);
        }
    }

    const stalePids = pidsOnPort.filter(pid => !managedNuxtPids.has(pid));
    if (stalePids.length === 0) {
        return false;
    }

    console.log(`[Nuxt] Cleaning stale process(es) on port ${getNuxtPort()} (${reason}): ${stalePids.join(', ')}`);
    await killProcessTreeForPids(stalePids, 1200);
    killPids(stalePids);
    await delay(500);
    return true;
}

async function startNuxtServer(forceClean = false): Promise<ChildProcess | null> {
    const logTiming = createStartupLogger();
    const isDefaultSession = getCurrentSessionName() === 'default';
    if (isDefaultSession) {
        setNuxtPort(DEFAULT_NUXT_PORT);
        console.log(`[Nuxt] Using fixed dev port ${getNuxtPort()}`);
    } else {
        const freePort = await findFreePort();
        setNuxtPort(freePort);
        console.log(`[Nuxt] Using isolated port ${getNuxtPort()} for session '${getCurrentSessionName()}'`);
    }
    console.log(`[Nuxt] Browser dev server: http://localhost:${getNuxtPort()}/`);

    if (!forceClean && await isReusableNuxtServer()) {
        console.log(`[Nuxt] Reusing existing dev server at http://127.0.0.1:${getNuxtPort()}`);
        logTiming('Nuxt existing dev server reused');
        return null;
    }

    await cleanupStaleNuxtPortOwners('before start');
    logTiming('Nuxt port cleanup complete');

    if (forceClean) {
        console.log('[Nuxt] Force clean start...');
        clearViteCache();
        logTiming('Nuxt cache cleanup complete');
    }

    const timeout = 120_000;
    const WARMUP_GRACE_MS = 5_000;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        console.log(`[Nuxt] Starting dev server on port ${getNuxtPort()} (attempt ${attempt + 1}/2)...`);
        const nuxt = spawn(PNPM_COMMAND, [
            'run',
            'dev:nuxt',
        ], {
            cwd: projectRoot,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            env: buildNuxtDevServerEnv(process.env, getNuxtPort()),
        });

        let viteClientBuilt = false;
        let viteServerBuilt = false;
        let nitroBuilt = false;
        let viteClientWarmed = false;
        let retryWithFreshPort = false;
        let sawPortCollision = false;
        let nuxtExited = false;
        let nuxtExitCode: number | null = null;
        let nuxtExitSignal: NodeJS.Signals | null = null;
        nuxt.on('exit', (code, signal) => {
            nuxtExited = true;
            nuxtExitCode = code;
            nuxtExitSignal = signal;
        });

        const checkOutput = (text: string) => {
            if (text.includes('Vite client built')) {
                console.log('[Nuxt] Vite client built');
                logTiming('Nuxt Vite client built');
                viteClientBuilt = true;
            }
            if (text.includes('Vite server built')) {
                console.log('[Nuxt] Vite server built');
                logTiming('Nuxt Vite server built');
                viteServerBuilt = true;
            }
            if (text.includes('Nitro server built') || text.includes('Nitro') && text.includes('built')) {
                console.log('[Nuxt] Nitro server built');
                logTiming('Nuxt Nitro server built');
                nitroBuilt = true;
            }
            if (text.includes('Vite client warmed up')) {
                console.log('[Nuxt] Vite client warmed up');
                logTiming('Nuxt Vite client warmed up');
                viteClientWarmed = true;
            }
            if (text.toLowerCase().includes('address already in use') || text.toLowerCase().includes('eaddrinuse')) {
                sawPortCollision = true;
            }
        };

        nuxt.stdout?.on('data', (data: Buffer) => checkOutput(data.toString()));
        nuxt.stderr?.on('data', (data: Buffer) => checkOutput(data.toString()));

        const start = Date.now();
        let lastLog = 0;

        // Electron can now wait for the externally managed Nuxt server, so keep
        // the expensive dev-server build and Electron startup overlapped.
        await delay(750);
        if (!nuxtExited) {
            console.log('[Nuxt] Dev process started; Electron will wait for HTTP readiness.');
            logTiming('Nuxt dev process spawned');
            return nuxt;
        }

        while (Date.now() - start < timeout) {
            const serverUp = await isNuxtRunning();
            const buildsComplete = viteClientBuilt && viteServerBuilt && nitroBuilt;
            const warmupComplete = viteClientWarmed || (Date.now() - start > WARMUP_GRACE_MS);
            const elapsedMs = Date.now() - start;

            if (buildsComplete && warmupComplete) {
                if (!serverUp) {
                    console.log('[Nuxt] Build markers complete; Electron will wait for HTTP readiness.');
                    logTiming('Nuxt build markers complete');
                    return nuxt;
                }

                console.log('[Nuxt] Server ready at http://127.0.0.1:' + getNuxtPort());
                logTiming('Nuxt server ready');

                console.log('[Nuxt] Warming up dependencies...');
                try {
                    await fetch(getElectronAppUrl(), { method: 'GET' });
                } catch {}
                logTiming('Nuxt dependency warmup complete');

                return nuxt;
            }

            if (serverUp && elapsedMs > 15_000) {
                console.log('[Nuxt] Server responded without full build markers; proceeding with existing readiness signal.');
                logTiming('Nuxt server ready from HTTP fallback');
                return nuxt;
            }

            if (nuxtExited) {
                const cleaned = await cleanupStaleNuxtPortOwners('spawn process exited');
                if ((cleaned || sawPortCollision) && attempt === 0) {
                    retryWithFreshPort = true;
                    break;
                }

                const pids = getPidsOnPort(getNuxtPort());
                const suffix = pids.length > 0 ? ` Port owners: ${pids.join(', ')}` : '';
                throw new Error(
                    `Nuxt process exited before startup completed (code=${nuxtExitCode ?? 'null'}, signal=${nuxtExitSignal ?? 'null'}).${suffix}`,
                );
            }

            const now = Date.now();
            if (serverUp && !buildsComplete && now - lastLog > 5000) {
                const nuxtPid = nuxt.pid ?? null;
                if (nuxtPid && nuxtPid > 0) {
                    const ownedPids = new Set<number>([
                        nuxtPid,
                        ...getDescendantPids(nuxtPid),
                    ]);
                    const pidsOnPort = getPidsOnPort(getNuxtPort());
                    const ownsRespondingServer = pidsOnPort.some(pid => ownedPids.has(pid));
                    if (pidsOnPort.length > 0 && !ownsRespondingServer) {
                        console.log(`[Nuxt] Port ${getNuxtPort()} is already served by unrelated process(es): ${pidsOnPort.join(', ')}. Reusing existing server.`);
                        if (isProcessAlive(nuxtPid)) {
                            await killProcessTree(nuxtPid, 800);
                        }
                        return null;
                    }
                }

                const missing = [];
                if (!viteClientBuilt) {
                    missing.push('Vite client');
                }
                if (!viteServerBuilt) {
                    missing.push('Vite server');
                }
                if (!nitroBuilt) {
                    missing.push('Nitro');
                }
                if (!viteClientWarmed) {
                    missing.push('Vite warmup');
                }
                console.log(`[Nuxt] Waiting for builds: ${missing.join(', ')}`);
                lastLog = now;
            }

            await delay(500);
        }

        if (retryWithFreshPort) {
            continue;
        }

        if (nuxt.pid && isProcessAlive(nuxt.pid)) {
            await killProcessTree(nuxt.pid, 800);
        } else {
            nuxt.kill();
        }

        if (attempt === 0) {
            const cleaned = await cleanupStaleNuxtPortOwners('startup timeout');
            if (cleaned) {
                continue;
            }
        }
    }

    throw new Error('Nuxt server failed to start');
}

async function startElectron(cdpPort: number): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.js');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.js not found. Run `pnpm run build:electron` first.');
    }

    console.log('[Electron] Starting with CDP on port', cdpPort);
    mkdirSync(sessionDir(), { recursive: true });

    const startupLogLines: string[] = [];
    const pushStartupLogChunk = (stream: 'stdout' | 'stderr', chunk: string) => {
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
    };

    const formatStartupFailure = (reason: string, details: {
        code: number | null;
        signal: NodeJS.Signals | null 
    }) => {
        const tail = startupLogLines
            .slice(-ELECTRON_STARTUP_LOG_TAIL_LINES)
            .join('\n')
            .trim();
        const exitInfo = `code=${details.code ?? 'null'}, signal=${details.signal ?? 'null'}`;
        return tail
            ? `${reason} (${exitInfo})\n--- Electron output tail ---\n${tail}`
            : `${reason} (${exitInfo})`;
    };

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
        EVB_WAIT_FOR_EXTERNAL_DEV_SERVER: '1',
        ...automationWindowEnv,
        EVB_AUTOMATION_USER_DATA_DIR: automationUserDataDir,
        EVB_AUTOMATION_SESSION_NAME: getCurrentSessionName(),
        EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE: shouldBootstrapDevProfile ? '1' : '0',
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
        ELECTRON_ENABLE_STACK_DUMPING: process.env.ELECTRON_ENABLE_STACK_DUMPING ?? '1',
    } satisfies NodeJS.ProcessEnv;

    const electronArgs = buildElectronAutomationArgs({
        cdpPort,
        automationUserDataDir,
        mainJs,
        env: electronRuntimeEnv,
    });
    const electronPath = buildElectronExecutablePath();
    const electronAppPath = join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
    const launchViaHiddenMacApp = shouldUseMacOSHiddenAppLauncher(automationWindowEnv)
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
            destinationRoot: join(sessionDir(), 'automation-electron-app'),
        })
        : null;
    const hiddenAutomationAppEntryPath = launchViaHiddenMacApp
        ? prepareMacOSAutomationAppEntry({
            destinationRoot: join(sessionDir(), 'automation-electron-app-entry'),
            mainJs,
        }).appPath
        : mainJs;
    const launchCommand = launchViaHiddenMacApp
        ? hiddenAutomationBundlePaths!.executablePath
        : electronPath;
    const launchArgs = launchViaHiddenMacApp
        ? [
            ...electronArgs.slice(0, -1),
            hiddenAutomationAppEntryPath,
        ]
        : electronArgs;
    const electron = spawn(launchCommand, launchArgs, {
        cwd: projectRoot,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        env: sanitizeElectronLaunchEnv(electronRuntimeEnv),
    });

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    electron.on('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
    });

    const onElectronOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
        const text = data.toString();
        pushStartupLogChunk(stream, text);
        if (text.includes('DevTools listening')) {
            console.log('[Electron] CDP ready');
        }
    };
    electron.stdout?.on('data', (data: Buffer) => onElectronOutput('stdout', data));
    electron.stderr?.on('data', (data: Buffer) => onElectronOutput('stderr', data));

    const timeout = ELECTRON_START_TIMEOUT_MS;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const electronPid = electron.pid ?? null;
        const hasKnownPid = typeof electronPid === 'number' && electronPid > 0;
        const exited = exitCode !== null || exitSignal !== null || (hasKnownPid && !isProcessAlive(electronPid));
        if (exited) {
            throw new Error(formatStartupFailure('Electron exited before CDP became ready', {
                code: exitCode,
                signal: exitSignal,
            }));
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

    await killElectronProcessesByCdpPort(cdpPort);
    if (electron.pid && isProcessAlive(electron.pid)) {
        await killProcessTree(electron.pid, 800);
    } else {
        electron.kill();
    }
    throw new Error(formatStartupFailure('Electron failed to start CDP before timeout', {
        code: exitCode,
        signal: exitSignal,
    }));
}

async function checkHydration(page: Page): Promise<boolean> {
    try {
        return await page.evaluate(() => {
            const nuxtEl = document.querySelector('#__nuxt');
            return !!(
                (window as any).__appReady
                || (nuxtEl && nuxtEl.children.length > 0)
            );
        });
    } catch {
        return false;
    }
}

interface IRendererState {
    bodyExists: boolean;
    openFileDirect: string;
    electronAPI: string;
    nuxtRootChildren: number;
    bodyTextLength: number;
    url: string;
}

function readRendererState(page: Page): Promise<IRendererState> {
    return page.evaluate(() => {
        const nuxtEl = document.querySelector('#__nuxt');
        return {
            bodyExists: document.body !== null,
            openFileDirect: typeof (window as any).__openFileDirect,
            electronAPI: typeof (window as any).electronAPI,
            nuxtRootChildren: nuxtEl?.children.length ?? 0,
            bodyTextLength: (document.body?.innerText ?? '').trim().length,
            url: window.location.href,
        };
    });
}

function isRendererReady(state: IRendererState) {
    return state.bodyExists
        && state.openFileDirect === 'function'
        && state.electronAPI === 'object'
        && state.nuxtRootChildren > 0;
}

async function waitForRendererBindings(page: Page, timeoutMs = RENDERER_READY_TIMEOUT_MS): Promise<IRendererState> {
    const start = Date.now();
    let lastState: IRendererState = {
        bodyExists: false,
        openFileDirect: 'undefined',
        electronAPI: 'undefined',
        nuxtRootChildren: 0,
        bodyTextLength: 0,
        url: page.url(),
    };
    while (Date.now() - start < timeoutMs) {
        try {
            lastState = await readRendererState(page);
        } catch (error) {
            if (!isTransientPageContextError(error)) {
                throw error;
            }
            await delay(250);
            continue;
        }
        if (isRendererReady(lastState)) {
            return lastState;
        }
        await delay(250);
    }
    return lastState;
}

async function reattachToAppPage(
    browser: Browser,
    currentPage: Page,
    onPageChanged?: (page: Page) => void,
): Promise<Page> {
    const freshPage = await findAppPage(browser);
    if (freshPage && freshPage !== currentPage) {
        onPageChanged?.(freshPage);
        return freshPage;
    }
    return currentPage;
}

function isAppPageUrl(url: string): boolean {
    const port = getNuxtPort();
    return url.includes(`localhost:${port}`) || url.includes(`127.0.0.1:${port}`);
}

function getElectronAppUrl(): string {
    return `http://127.0.0.1:${getNuxtPort()}${ELECTRON_SERVER_PATH}`;
}

async function findAppPage(browser: Browser): Promise<Page | null> {
    const pages = await browser.pages();
    return pages.find(page => isAppPageUrl(page.url())) ?? null;
}

async function waitForAppPage(browser: Browser, timeoutMs: number): Promise<Page | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const page = await findAppPage(browser);
        if (page) {
            return page;
        }
        await delay(250);
    }
    return null;
}

function isNavigationAbortedError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.message.includes('net::ERR_ABORTED');
}

async function waitForElectronPageTarget(cdpPort: number, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    let lastLoggedTargets = '';
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
            if (res.ok) {
                const targets = await res.json() as Array<{
                    type: string;
                    url: string;
                    webSocketDebuggerUrl?: string;
                }>;
                const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
                if (pageTarget?.webSocketDebuggerUrl) {
                    console.log(`[CDP] Discovered page target: ${pageTarget.url}`);
                    return;
                }
                const summary = JSON.stringify(targets.map(t => ({
                    type: t.type,
                    url: t.url,
                })));
                if (summary !== lastLoggedTargets) {
                    console.log(`[CDP] /json/list targets: ${summary}`);
                    lastLoggedTargets = summary;
                }
            }
        } catch {
            // CDP endpoint not ready yet.
        }
        await delay(500);
    }
    throw new Error(`No Electron page target found via /json/list within ${Math.round(timeoutMs / 1000)}s`);
}

async function getBrowserWsEndpoint(cdpPort: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!res.ok) {
        throw new Error(`Failed to fetch /json/version: HTTP ${res.status}`);
    }
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) {
        throw new Error('/json/version did not include webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
}

async function connectToBrowser(cdpPort: number): Promise<{
    browser: Browser;
    page: Page
}> {
    const logTiming = createStartupLogger();
    console.log('[Puppeteer] Connecting via CDP...');

    // Wait for the Electron BrowserWindow page target to appear in CDP,
    // then connect to the browser-level WebSocket endpoint.
    await waitForElectronPageTarget(cdpPort);
    logTiming('Electron page target available');
    const browserWsUrl = await getBrowserWsEndpoint(cdpPort);

    let browser: Browser | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            browser = await Promise.race([
                puppeteer.connect({
                    browserWSEndpoint: browserWsUrl,
                    defaultViewport: null,
                }),
                delay(5000).then(() => {
                    throw new Error('CDP connect timeout');
                }),
            ]);
            logTiming('Puppeteer connected to CDP');
            break;
        } catch (error) {
            if (attempt === 0 || attempt === 4 || attempt === 9) {
                const message = error instanceof Error ? error.message : String(error);
                console.log(`[Puppeteer] CDP connect retry ${attempt + 1}/10: ${message}`);
            }
            await delay(500);
        }
    }

    if (!browser) {
        throw new Error('Could not connect to Electron CDP');
    }

    let page: Page | null = null;
    for (let i = 0; i < 30; i += 1) {
        page = await findAppPage(browser);
        if (!page) {
            const allPages = await browser.pages();
            page = allPages.find(candidate => !candidate.isClosed()) ?? null;
        }
        if (page) {
            break;
        }
        await delay(500);
    }

    if (!page) {
        throw new Error('No Electron page found after CDP connection');
    }

    if (!isAppPageUrl(page.url())) {
        const appLoadedPage = await waitForAppPage(browser, ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS);
        if (appLoadedPage) {
            page = appLoadedPage;
            logTiming('Electron app page appeared without fallback navigation');
        } else {
            try {
                await waitForReusableNuxtServer(30_000);
                await page.goto(getElectronAppUrl(), {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });
                logTiming('Fallback navigation to Electron app URL complete');
            } catch (error) {
                if (!isNavigationAbortedError(error)) {
                    throw error;
                }
                const recoveredPage = await waitForAppPage(browser, ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS);
                if (!recoveredPage) {
                    throw error;
                }
                page = recoveredPage;
                logTiming('Recovered from aborted fallback navigation');
            }
        }
    }

    let trackedPage: Page | null = null;
    let responseListener: ((response: HTTPResponse) => void) | null = null;
    let sawOutdatedOptimizeDep = false;
    let optimizeDepUrl: string | null = null;
    const attachOptimizeDepWatcher = (nextPage: Page) => {
        if (trackedPage && responseListener) {
            trackedPage.off('response', responseListener);
        }
        trackedPage = nextPage;
        responseListener = (response) => {
            if (response.status() === 504 && isAppPageUrl(response.url())) {
                sawOutdatedOptimizeDep = true;
                optimizeDepUrl = response.url();
            }
        };
        trackedPage.on('response', responseListener);
    };
    attachOptimizeDepWatcher(page);

    try {
        try {
            await page.waitForSelector('body', { timeout: 30000 });
        } catch {
            console.log('[Puppeteer] Page navigated during initial load, re-finding...');
            await delay(2000);
            page = await findAppPage(browser);
            if (!page) {
                throw new Error('Lost app page after navigation');
            }
            attachOptimizeDepWatcher(page);
            await page.waitForSelector('body', { timeout: 15000 });
        }

        console.log('[Puppeteer] Waiting for Vue to hydrate...');
        logTiming('Renderer body available');
        let hydrated = false;
        let navigationCount = 0;
        const MAX_NAVIGATIONS = 3;

        for (let attempt = 0; attempt < 30; attempt += 1) {
            if (sawOutdatedOptimizeDep) {
                console.log('[Puppeteer] Detected Vite 504 (Outdated Optimize Dep), reloading...');
                break;
            }

            let isReady = false;
            try {
                isReady = await checkHydration(page);
            } catch (error) {
                if (!isTransientPageContextError(error)) {
                    throw error;
                }
                page = await reattachToAppPage(browser, page, attachOptimizeDepWatcher);
                await delay(250);
                continue;
            }
            if (isReady) {
                hydrated = true;
                break;
            }

            if (attempt > 0 && attempt % 5 === 0) {
                const freshPage = await findAppPage(browser);
                if (freshPage && freshPage !== page) {
                    navigationCount += 1;
                    console.log(`[Puppeteer] Page navigated (${navigationCount}/${MAX_NAVIGATIONS}), re-attaching...`);
                    if (navigationCount > MAX_NAVIGATIONS) {
                        console.log('[Puppeteer] Too many navigations, proceeding with current page');
                        break;
                    }
                    page = freshPage;
                    attachOptimizeDepWatcher(page);
                }
            }

            await delay(500);
        }

        if (!hydrated || sawOutdatedOptimizeDep) {
            if (!hydrated) {
                console.log('[Puppeteer] Vue not ready, reloading page...');
            }
            sawOutdatedOptimizeDep = false;
            optimizeDepUrl = null;
            try {
                await page.reload({ waitUntil: 'networkidle2' });
            } catch {
                await delay(2000);
                page = await findAppPage(browser) ?? page;
                attachOptimizeDepWatcher(page);
            }

            await delay(1500);
            page = await reattachToAppPage(browser, page, attachOptimizeDepWatcher);
            let hydratedAfterReload = false;
            for (let attempt = 0; attempt < 30; attempt += 1) {
                if (sawOutdatedOptimizeDep) {
                    break;
                }
                try {
                    if (await checkHydration(page)) {
                        hydratedAfterReload = true;
                        break;
                    }
                } catch (error) {
                    if (!isTransientPageContextError(error)) {
                        throw error;
                    }
                    page = await reattachToAppPage(browser, page, attachOptimizeDepWatcher);
                    await delay(250);
                    continue;
                }
                if (attempt > 0 && attempt % 5 === 0) {
                    page = await reattachToAppPage(browser, page, attachOptimizeDepWatcher);
                }
                await delay(350);
            }

            if (sawOutdatedOptimizeDep) {
                throw createViteOptimizeDepError(optimizeDepUrl ?? 'Outdated Optimize Dep after reload');
            }
            if (!hydratedAfterReload) {
                console.log('[Puppeteer] Warning: Vue may not be fully hydrated after reload');
            }
        }

        page = await reattachToAppPage(browser, page, attachOptimizeDepWatcher);
        let rendererState: IRendererState;
        try {
            rendererState = await waitForRendererBindings(page, RENDERER_READY_TIMEOUT_MS);
        } catch (error) {
            if (!isTransientPageContextError(error)) {
                throw error;
            }
            page = await reattachToAppPage(browser, page, attachOptimizeDepWatcher);
            rendererState = await waitForRendererBindings(page, RENDERER_READY_TIMEOUT_MS);
        }
        if (!isRendererReady(rendererState)) {
            if (sawOutdatedOptimizeDep) {
                throw createViteOptimizeDepError(optimizeDepUrl ?? 'Outdated Optimize Dep while waiting for renderer bindings');
            }
            throw new Error(`Renderer readiness timeout (openFileDirect=${rendererState.openFileDirect}, electronAPI=${rendererState.electronAPI}, nuxtChildren=${rendererState.nuxtRootChildren}, text=${rendererState.bodyTextLength}, url=${rendererState.url})`);
        }

        console.log('[Puppeteer] Connected to app');
        logTiming('Renderer bindings ready');
        return {
            browser,
            page,
        };
    } finally {
        if (trackedPage && responseListener) {
            trackedPage.off('response', responseListener);
        }
    }
}

export async function startSession(forceClean = false) {
    const logTiming = createStartupLogger();
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running. Use \`pnpm electron:run stop --session=${getCurrentSessionName()}\` to stop it.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Session '${getCurrentSessionName()}' startup is stuck. Run stop and retry.`);
        }
        return;
    }
    markSessionStarting(process.pid);

    console.log(`Starting Electron Puppeteer session '${getCurrentSessionName()}'...\n`);

    try {
        const otherRunning = listRunningSessions().filter(name => name !== getCurrentSessionName());
        if (forceClean && otherRunning.length > 0) {
            console.log(`[Nuxt] ${otherRunning.length} other session(s) running (${otherRunning.join(', ')}), skipping Nuxt restart`);
            forceClean = false;
        }

        let nuxtProcess = await startNuxtServer(forceClean);
        logTiming('Nuxt startup phase complete');

        if (forceClean) {
            try {
                rmSync(electronUserDataPath(), {
                    recursive: true,
                    force: true, 
                });
                console.log(`[Cache] Cleared ${electronUserDataPath().replace(projectRoot + '/', '')}`);
            } catch {}
        }

        const staleInfo = getSessionInfo();
        if (staleInfo?.electronPid && isProcessAlive(staleInfo.electronPid)) {
            await killProcessTree(staleInfo.electronPid, 500);
            await killElectronProcessesByCdpPort(staleInfo.cdpPort);
            await delay(500);
        }

        const serverPort = await findFreePort();
        let cdpPort = await findFreePort();
        console.log(`[Ports] CDP: ${cdpPort}, HTTP server: ${serverPort}`);
        logTiming('Automation ports allocated');

        let electronProcess: ChildProcess | null = null;
        let browser: Browser | null = null;
        let page: Page | null = null;
        let launchError: unknown = null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt > 0) {
                cdpPort = await findFreePort();
                console.log(`[Recovery] Retrying launch (attempt ${attempt + 1}/2) with CDP port ${cdpPort}`);
            }

            electronProcess = await startElectron(cdpPort);
            logTiming('Electron process/CDP ready');

            try {
                ({
                    browser,
                    page,
                } = await connectToBrowser(cdpPort));
                logTiming('Browser automation attached');
                launchError = null;
                break;
            } catch (error) {
                launchError = error;
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[Session] Failed to connect to browser: ${message}`);

                try {
                    if (electronProcess.pid && isProcessAlive(electronProcess.pid)) {
                        await killProcessTree(electronProcess.pid, 800);
                    } else {
                        electronProcess.kill();
                    }
                } catch {}
                await killElectronProcessesByCdpPort(cdpPort);
                electronProcess = null;
                browser = null;
                page = null;

                if (attempt === 0 && isViteOptimizeDepError(error)) {
                    if (otherRunning.length > 0) {
                        launchError = new Error(`Detected Vite optimize-dep failure, but other sessions are active (${otherRunning.join(', ')}). Stop them and run cleanstart.`);
                        break;
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

                break;
            }
        }

        if (!electronProcess || !browser || !page) {
            console.error('[Session] Failed to initialize app session, cleaning up...');
            try {
                if (nuxtProcess?.pid && isProcessAlive(nuxtProcess.pid)) {
                    await killProcessTree(nuxtProcess.pid, 1200);
                } else {
                    nuxtProcess?.kill();
                }
            } catch {}
            if (launchError instanceof Error) {
                throw launchError;
            }
            throw new Error('Failed to initialize Electron session');
        }

        const consoleMessages: ISessionState['consoleMessages'] = [];
        const devtoolsEvents: ISessionState['devtoolsEvents'] = [];
        const pushConsoleMessage = (entry: ISessionState['consoleMessages'][number]) => {
            pushBounded(consoleMessages, entry, MAX_CONSOLE_MESSAGES);
            pushBounded(devtoolsEvents, {
                kind: 'console',
                timestamp: entry.timestamp,
                level: entry.type,
                text: entry.text,
            }, MAX_DEVTOOLS_EVENTS);
        };
        const pushDevtoolsEvent = (entry: ISessionState['devtoolsEvents'][number]) => {
            pushBounded(devtoolsEvents, entry, MAX_DEVTOOLS_EVENTS);
        };
        type TConsoleEntry = ISessionState['consoleMessages'][number];

        page.on('console', (msg) => {
            const entry: TConsoleEntry = {
                type: msg.type(),
                text: msg.text(),
                timestamp: Date.now(),
            };
            pushConsoleMessage(entry);
            console.log(`[${entry.type.toUpperCase()}] ${entry.text}`);
        });

        page.on('request', (request) => {
            pushDevtoolsEvent({
                kind: 'request',
                timestamp: Date.now(),
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                isNavigationRequest: request.isNavigationRequest(),
            });
        });

        page.on('response', (response) => {
            pushDevtoolsEvent({
                kind: 'response',
                timestamp: Date.now(),
                url: response.url(),
                status: response.status(),
                ok: response.ok(),
                fromCache: response.fromCache(),
                fromServiceWorker: response.fromServiceWorker(),
                resourceType: response.request().resourceType(),
                method: response.request().method(),
            });
        });

        page.on('requestfailed', (request) => {
            pushDevtoolsEvent({
                kind: 'requestfailed',
                timestamp: Date.now(),
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                failureText: request.failure()?.errorText ?? 'unknown request failure',
            });
        });

        page.on('error', (error) => {
            const entry: TConsoleEntry = {
                type: 'error',
                text: `[PAGE ERROR] ${error.message}`,
                timestamp: Date.now(),
            };
            pushConsoleMessage(entry);
            pushDevtoolsEvent({
                kind: 'error',
                timestamp: entry.timestamp,
                text: entry.text,
            });
            console.log(`[ERROR] ${error.message}`);
        });

        page.on('pageerror', (error) => {
            const message = error instanceof Error ? error.message : String(error);
            const entry: TConsoleEntry = {
                type: 'error',
                text: `[PAGE CRASH] ${message}`,
                timestamp: Date.now(),
            };
            pushConsoleMessage(entry);
            pushDevtoolsEvent({
                kind: 'pageerror',
                timestamp: entry.timestamp,
                text: message,
            });
            console.log(`[ERROR] ${message}`);
        });

        sessionState = {
            browser,
            page,
            electronProcess,
            nuxtProcess,
            consoleMessages,
            devtoolsEvents,
        };

        let isShuttingDown = false;
        let httpServer: ReturnType<typeof createServer> | null = null;

        const cleanupAndExit = async (exitCode: number) => {
            if (isShuttingDown) {
                return;
            }
            isShuttingDown = true;

            console.log('\nShutting down...');
            const keepNuxtOnStop = existsSync(join(sessionDir(), KEEP_NUXT_ON_STOP_MARKER));
            if (keepNuxtOnStop) {
                console.log('[Nuxt] Keeping dev server alive for fast restart');
            }
            try {
                unlinkSync(sessionFilePath());
            } catch {}
            try {
                unlinkSync(join(sessionDir(), KEEP_NUXT_ON_STOP_MARKER));
            } catch {}
            clearSessionStarting();
            httpServer?.close();

            await sessionState?.browser.disconnect().catch(() => {});
            try {
                if (sessionState?.electronProcess.pid && isProcessAlive(sessionState.electronProcess.pid)) {
                    await killProcessTree(sessionState.electronProcess.pid, 800);
                } else {
                    sessionState?.electronProcess.kill();
                }
            } catch {}

            if (sessionState?.nuxtProcess && !keepNuxtOnStop) {
                const otherNames = listAllSessionNames().filter(name => name !== getCurrentSessionName());
                const othersAlive = otherNames.some((name) => {
                    const info = getSessionInfo(name);
                    return !!(info && isProcessAlive(info.pid));
                });
                if (!othersAlive) {
                    try {
                        if (sessionState.nuxtProcess.pid && isProcessAlive(sessionState.nuxtProcess.pid)) {
                            await killProcessTree(sessionState.nuxtProcess.pid, 1200);
                        } else {
                            sessionState.nuxtProcess.kill();
                        }
                    } catch {}
                } else {
                    console.log('[Nuxt] Left running (other sessions active)');
                }
            } else if (sessionState?.nuxtProcess && keepNuxtOnStop) {
                sessionState.nuxtProcess.unref();
            }

            sessionState = null;
            process.exit(exitCode);
        };

        electronProcess.on('exit', (code, signal) => {
            if (isShuttingDown) {
                return;
            }
            console.log(`\n[Electron] Process exited (code: ${code}, signal: ${signal})`);
            console.log('[Session] Electron died - shutting down session...');
            void cleanupAndExit(1);
        });

        browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
            console.log('\n[Puppeteer] Browser disconnected');
            console.log('[Session] Lost connection to Electron - shutting down session...');
            void cleanupAndExit(1);
        });

        const server = createServer((req, res) => {
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
                    const requestPayload = parseElectronRunCommandRequest(safeDestr(body));
                    if (!requestPayload) {
                        throw new Error('Malformed command payload');
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

        httpServer = server;

        server.listen(serverPort, () => {
            mkdirSync(sessionDir(), { recursive: true });
            writeFileSync(sessionFilePath(), JSON.stringify({
                port: serverPort,
                pid: process.pid,
                cdpPort,
                electronPid: electronProcess.pid ?? null,
                nuxtPid: nuxtProcess?.pid ?? null,
                nuxtPort: getNuxtPort(),
            }));
            clearSessionStarting();

            console.log(`\n\u2713 Session '${getCurrentSessionName()}' ready on port ${serverPort}`);
            logTiming('Session command server ready');
            console.log('  Press Ctrl+C to stop\n');
        });

        process.on('SIGINT', () => {
            void cleanupAndExit(0);
        });
        process.on('SIGTERM', () => {
            void cleanupAndExit(0);
        });

        await new Promise(() => {});
    } catch (error) {
        clearSessionStarting();
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

export async function stopSingleSession(name: string, options: {keepNuxt?: boolean} = {}) {
    await cleanupStaleSessionArtifacts(name);

    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);

    if (!info && !starting) {
        console.log(`No session '${name}' running.`);
        return;
    }

    if (info) {
        if (options.keepNuxt && info.nuxtPid && isProcessAlive(info.nuxtPid)) {
            mkdirSync(sessionDir(name), {recursive: true});
            writeFileSync(join(sessionDir(name), KEEP_NUXT_ON_STOP_MARKER), String(Date.now()));
            try {
                process.kill(info.pid, 'SIGTERM');
            } catch {}
            const didExit = await waitForProcessExit(info.pid, 2500);
            if (!didExit && isProcessAlive(info.pid)) {
                await killProcessTree(info.pid, 1500);
            }
        } else if (isProcessAlive(info.pid)) {
            await killProcessTree(info.pid, 1500);
        }

        if (info.electronPid && isProcessAlive(info.electronPid)) {
            await killProcessTree(info.electronPid, 800);
        }
        await killElectronProcessesByCdpPort(info.cdpPort);

        if (info.nuxtPid && isProcessAlive(info.nuxtPid) && !options.keepNuxt) {
            const others = listAllSessionNames().filter(sessionName => sessionName !== name);
            const othersAlive = others.some((sessionName) => {
                const otherInfo = getSessionInfo(sessionName);
                return !!(otherInfo && isProcessAlive(otherInfo.pid));
            });
            if (!othersAlive) {
                await killProcessTree(info.nuxtPid, 1200);
            } else {
                console.log('[Nuxt] Left running (other sessions active)');
            }
        } else if (info.nuxtPid && isProcessAlive(info.nuxtPid) && options.keepNuxt) {
            console.log('[Nuxt] Left running for fast restart');
        }

        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
        try {
            unlinkSync(join(sessionDir(name), KEEP_NUXT_ON_STOP_MARKER));
        } catch {}
    }

    if (starting?.pid && isProcessAlive(starting.pid)) {
        await killProcessTree(starting.pid, 1000);
    }
    clearSessionStarting(name);

    await delay(250);
    console.log(`Session '${name}' stopped.`);
}

export async function stopAllSessions() {
    const names = listAllSessionNames();
    if (names.length === 0) {
        await killExistingNuxt();
        console.log('No sessions found.');
        return;
    }

    for (const name of names) {
        await stopSingleSession(name);
    }

    await killExistingNuxt();
    console.log('All sessions stopped.');
}

export async function stopSession(options: {
    stopAll?: boolean;
    keepNuxt?: boolean;
} = {}) {
    if (options.stopAll) {
        await stopAllSessions();
    } else {
        await stopSingleSession(getCurrentSessionName(), {keepNuxt: options.keepNuxt});
    }
}

export async function waitForSessionReady(timeoutMs = SESSION_WAIT_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            return true;
        }
        await delay(250);
    }
    return false;
}

export async function startSessionDetached() {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Startup is still pending. Check logs: ${sessionLogFilePath()}`);
        }
        console.log('Session is ready.');
        return;
    }

    mkdirSync(sessionDir(), { recursive: true });
    const logFd = openSync(sessionLogFilePath(), 'w');
    const child = spawn(PNPM_COMMAND, [
        'electron:run',
        `--session=${getCurrentSessionName()}`,
        'start',
    ], {
        cwd: projectRoot,
        detached: true,
        shell: false,
        stdio: [
            'ignore',
            logFd,
            logFd,
        ],
        env: { ...process.env },
    });
    closeSync(logFd);
    child.unref();

    const timeoutMs = 120_000;
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            ready = true;
            break;
        }
        if (child.pid && !isProcessAlive(child.pid) && !isSessionStarting()) {
            break;
        }
        await delay(300);
    }
    if (!ready) {
        const tail = readSessionLogTail();
        const details = tail ? `\n\n--- Recent session log ---\n${tail}` : '';
        throw new Error(`Detached session failed to become ready in ${Math.round(timeoutMs / 1000)}s. Check logs: ${sessionLogFilePath()}${details}`);
    }

    console.log(`Session '${getCurrentSessionName()}' started in background (pid: ${child.pid ?? 'unknown'}).`);
    console.log(`Logs: ${sessionLogFilePath()}`);
}
