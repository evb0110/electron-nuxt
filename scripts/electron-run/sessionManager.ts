import { createServer } from 'node:http';
import {
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
import { join } from 'node:path';
import puppeteer, {
    type Browser,
    type HTTPResponse,
    type Page,
} from 'puppeteer-core';
import { safeDestr } from 'destr';
import { delay } from 'es-toolkit/promise';
import { createCommandHandler } from '@scripts/electron-run/createCommandHandler';
import {
    buildElectronAutomationArgs,
    buildElectronExecutablePath,
    prepareMacOSAutomationAppEntry,
    prepareMacOSHiddenAppBundle,
    resolveAutomationWindowEnv,
    sanitizeElectronLaunchEnv,
    shouldBootstrapInteractiveDevProfile,
    shouldUseMacOSHiddenAppLauncher,
} from '@scripts/electron-run/electronRunLaunchConfig';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { applyE2ESharedRendererPort } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import {
    ELECTRON_SERVER_PATH,
    cleanupOrphanedProjectNuxtRoots,
    getElectronAppUrl,
    hasOtherAliveSessionUsingNuxt,
    killExistingNuxt,
    startNuxtServer,
    waitForReusableNuxtServer,
    type INuxtSessionShareMetadata,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    findFreePort,
    findPidsByCommandSubstring,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import { formatElectronStartupDiagnostics } from '@scripts/electron-run/electronRunStartupDiagnostics';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { parseElectronRunCommandRequest } from '@scripts/electron-run/electronRunProtocol';
import {
    cleanupStaleSessionArtifacts,
    clearSessionStarting,
    getSessionInfo,
    getSessionStartingInfo,
    isSessionRunning,
    isSessionStarting,
    listAllSessionNames,
    listRunningSessions,
    markSessionStarting,
    readSessionLogTail,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    getCurrentSessionName,
    sessionDir,
    sessionFilePath,
    sessionLogFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import type {
    ISessionInfo,
    ISessionState,
} from '@scripts/electron-run/electronRunSessionTypes';
import { SESSION_WAIT_TIMEOUT_MS } from '@scripts/electron-run/electronRunTimeouts';

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

let sessionState: ISessionState | null = null;

const handleCommand = createCommandHandler(() => sessionState);
const MAX_CONSOLE_MESSAGES = 400;
const MAX_DEVTOOLS_EVENTS = 1200;
const RENDERER_READY_TIMEOUT_MS = 15_000;
const ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS = 20_000;
const VITE_OPTIMIZE_DEP_ERROR_MARKER = 'VITE_OPTIMIZE_DEP_504';
const ELECTRON_START_TIMEOUT_MS = 45_000;
const ELECTRON_LAUNCH_ATTEMPTS = 3;
const ELECTRON_LAUNCH_RETRY_DELAY_MS = 5_000;
const ELECTRON_STARTUP_LOG_MAX_LINES = 300;
const ELECTRON_STARTUP_LOG_TAIL_LINES = 60;
const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const KEEP_NUXT_ON_STOP_MARKER = 'keep-nuxt-on-stop';

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

async function killProcessTreeForPids(pids: number[], graceMs = 1200) {
    for (const pid of new Set(pids)) {
        await killProcessTree(pid, graceMs);
    }
}

async function killElectronProcessesByCdpPort(cdpPort: number | null | undefined) {
    if (!Number.isFinite(cdpPort) || (cdpPort ?? 0) <= 0) {
        return;
    }

    const pids = findPidsByCommandSubstring(`--remote-debugging-port=${cdpPort}`);
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

function buildElectronRuntimeEnv(cdpPort: number, mainJs: string) {
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
            env: electronRuntimeEnv,
        }),
    };
}

function buildElectronLaunchPlan(cdpPort: number, mainJs: string) {
    const {
        electronRuntimeEnv,
        electronArgs,
    } = buildElectronRuntimeEnv(cdpPort, mainJs);
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

    return {
        launchCommand,
        launchArgs,
        electronRuntimeEnv,
    };
}

function spawnElectronProcess(cdpPort: number, mainJs: string, startupLog: ReturnType<typeof createElectronStartupLog>) {
    const {
        launchCommand,
        launchArgs,
        electronRuntimeEnv,
    } = buildElectronLaunchPlan(cdpPort, mainJs);
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

async function startElectron(cdpPort: number): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.cjs');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.cjs not found. Run `pnpm run build:electron` first.');
    }

    console.log('[Electron] Starting with CDP on port', cdpPort);
    mkdirSync(sessionDir(), { recursive: true });

    const startupLog = createElectronStartupLog();
    const electron = spawnElectronProcess(cdpPort, mainJs, startupLog);
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

async function checkHydration(page: Page) {
    try {
        return await page.evaluate(() => {
            const automationWindow = window as Window & {__appReady?: boolean;};
            const nuxtEl = document.querySelector('#__nuxt');
            return !!(
                automationWindow.__appReady === true
                || (nuxtEl !== null && nuxtEl.children.length > 0)
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
    bodyTextSnippet: string;
    url: string;
}

function readRendererState(page: Page): Promise<IRendererState> {
    return page.evaluate(() => {
        const automationWindow = window as Window & {
            __openFileDirect?: unknown;
            electronAPI?: unknown;
        };
        const nuxtEl = document.querySelector('#__nuxt');
        return {
            bodyExists: document.body !== null,
            openFileDirect: typeof automationWindow.__openFileDirect,
            electronAPI: typeof automationWindow.electronAPI,
            nuxtRootChildren: nuxtEl?.children.length ?? 0,
            bodyTextLength: (document.body?.innerText ?? '').trim().length,
            bodyTextSnippet: (document.body?.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 240),
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
        bodyTextSnippet: '',
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

function isAppPageUrl(url: string) {
    const port = getNuxtPort();
    return url.startsWith('evb-viewer://app/')
        || url.includes(`localhost:${port}`)
        || url.includes(`127.0.0.1:${port}`);
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

async function waitForElectronPageTarget(cdpPort: number, timeoutMs = 30_000) {
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

async function getBrowserWsEndpoint(cdpPort: number) {
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

async function connectPuppeteerWithRetries(browserWsUrl: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            return await Promise.race([
                puppeteer.connect({
                    browserWSEndpoint: browserWsUrl,
                    defaultViewport: null,
                }),
                delay(5000).then(() => {
                    throw new Error('CDP connect timeout');
                }),
            ]);
        } catch (error) {
            if (attempt === 0 || attempt === 4 || attempt === 9) {
                const message = error instanceof Error ? error.message : String(error);
                console.log(`[Puppeteer] CDP connect retry ${attempt + 1}/10: ${message}`);
            }
            await delay(500);
        }
    }

    throw new Error('Could not connect to Electron CDP');
}

async function findInitialElectronPage(browser: Browser) {
    for (let i = 0; i < 30; i += 1) {
        const page = await findAppPage(browser);
        if (!page) {
            const allPages = await browser.pages();
            const fallbackPage = allPages.find(candidate => !candidate.isClosed()) ?? null;
            if (fallbackPage) {
                return fallbackPage;
            }
        } else {
            return page;
        }
        await delay(500);
    }

    throw new Error('No Electron page found after CDP connection');
}

async function ensureAppPageLoaded(
    browser: Browser,
    page: Page,
    logTiming: (message: string) => void,
) {
    if (isAppPageUrl(page.url())) {
        return page;
    }

    const appLoadedPage = await waitForAppPage(browser, ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS);
    if (appLoadedPage) {
        logTiming('Electron app page appeared without fallback navigation');
        return appLoadedPage;
    }

    try {
        await waitForReusableNuxtServer(30_000);
        await page.goto(getElectronAppUrl(), {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
        logTiming('Fallback navigation to Electron app URL complete');
        return page;
    } catch (error) {
        if (!isNavigationAbortedError(error)) {
            throw error;
        }
        const recoveredPage = await waitForAppPage(browser, ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS);
        if (!recoveredPage) {
            throw error;
        }
        logTiming('Recovered from aborted fallback navigation');
        return recoveredPage;
    }
}

function createOptimizeDepWatcher() {
    let trackedPage: Page | null = null;
    let responseListener: ((response: HTTPResponse) => void) | null = null;
    let sawOutdatedOptimizeDep = false;
    let optimizeDepUrl: string | null = null;

    return {
        attach(nextPage: Page) {
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
        },
        detach() {
            if (trackedPage && responseListener) {
                trackedPage.off('response', responseListener);
            }
        },
        reset() {
            sawOutdatedOptimizeDep = false;
            optimizeDepUrl = null;
        },
        sawOutdatedOptimizeDep() {
            return sawOutdatedOptimizeDep;
        },
        optimizeDepUrl() {
            return optimizeDepUrl;
        },
    };
}

type TOptimizeDepWatcher = ReturnType<typeof createOptimizeDepWatcher>;

async function waitForBodyElement(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
) {
    try {
        await page.waitForSelector('body', { timeout: 30000 });
        return page;
    } catch {
        console.log('[Puppeteer] Page navigated during initial load, re-finding...');
        await delay(2000);
        const nextPage = await findAppPage(browser);
        if (!nextPage) {
            throw new Error('Lost app page after navigation');
        }
        watcher.attach(nextPage);
        await nextPage.waitForSelector('body', { timeout: 15000 });
        return nextPage;
    }
}

async function waitForHydration(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
): Promise<{
    page: Page;
    hydrated: boolean;
}> {
    let navigationCount = 0;
    const MAX_NAVIGATIONS = 3;

    return pollHydration(browser, page, watcher, {
        delayMs: 500,
        onOutdated: () => {
            console.log('[Puppeteer] Detected Vite 504 (Outdated Optimize Dep), reloading...');
        },
        onInterval: async (current) => {
            const freshPage = await findAppPage(browser);
            if (freshPage && freshPage !== current) {
                navigationCount += 1;
                console.log(`[Puppeteer] Page navigated (${navigationCount}/${MAX_NAVIGATIONS}), re-attaching...`);
                if (navigationCount > MAX_NAVIGATIONS) {
                    console.log('[Puppeteer] Too many navigations, proceeding with current page');
                    return null;
                }
                watcher.attach(freshPage);
                return freshPage;
            }
            return current;
        },
    });
}

async function reloadAndWaitForHydration(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
): Promise<{
    page: Page;
    hydrated: boolean;
}> {
    let currentPage = page;
    try {
        await currentPage.goto(getElectronAppUrl(), { waitUntil: 'networkidle2' });
    } catch {
        await delay(2000);
        currentPage = await findAppPage(browser) ?? currentPage;
        watcher.attach(currentPage);
    }

    await delay(1500);
    currentPage = await reattachToAppPage(browser, currentPage, watcher.attach);
    return pollHydration(browser, currentPage, watcher, {
        delayMs: 350,
        onInterval: async (page) => reattachToAppPage(browser, page, watcher.attach),
    });
}

async function pollHydration(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
    options: {
        delayMs: number;
        onInterval: (page: Page, attempt: number) => Promise<Page | null>;
        onOutdated?: () => void;
    },
): Promise<{
    page: Page;
    hydrated: boolean;
}> {
    let currentPage = page;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (watcher.sawOutdatedOptimizeDep()) {
            options.onOutdated?.();
            break;
        }
        try {
            if (await checkHydration(currentPage)) {
                return {
                    page: currentPage,
                    hydrated: true,
                };
            }
        } catch (error) {
            if (!isTransientPageContextError(error)) {
                throw error;
            }
            currentPage = await reattachToAppPage(browser, currentPage, watcher.attach);
            await delay(250);
            continue;
        }
        if (attempt > 0 && attempt % 5 === 0) {
            const next = await options.onInterval(currentPage, attempt);
            if (next === null) {
                break;
            }
            currentPage = next;
        }
        await delay(options.delayMs);
    }

    return {
        page: currentPage,
        hydrated: false,
    };
}

async function waitForReadyRenderer(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
) {
    let currentPage = await reattachToAppPage(browser, page, watcher.attach);
    let rendererState: IRendererState;
    try {
        rendererState = await waitForRendererBindings(currentPage, RENDERER_READY_TIMEOUT_MS);
    } catch (error) {
        if (!isTransientPageContextError(error)) {
            throw error;
        }
        currentPage = await reattachToAppPage(browser, currentPage, watcher.attach);
        rendererState = await waitForRendererBindings(currentPage, RENDERER_READY_TIMEOUT_MS);
    }
    if (!isRendererReady(rendererState)) {
        if (watcher.sawOutdatedOptimizeDep()) {
            throw createViteOptimizeDepError(watcher.optimizeDepUrl() ?? 'Outdated Optimize Dep while waiting for renderer bindings');
        }
        throw new Error(`Renderer readiness timeout (openFileDirect=${rendererState.openFileDirect}, electronAPI=${rendererState.electronAPI}, nuxtChildren=${rendererState.nuxtRootChildren}, text=${rendererState.bodyTextLength}, url=${rendererState.url}, body="${rendererState.bodyTextSnippet}")`);
    }
    return currentPage;
}

async function connectToBrowser(cdpPort: number): Promise<{
    browser: Browser;
    page: Page
}> {
    const logTiming = createStartupLogger();
    console.log('[Puppeteer] Connecting via CDP...');

    await waitForElectronPageTarget(cdpPort);
    logTiming('Electron page target available');
    const browser = await connectPuppeteerWithRetries(await getBrowserWsEndpoint(cdpPort));
    logTiming('Puppeteer connected to CDP');

    let page = await findInitialElectronPage(browser);
    page = await ensureAppPageLoaded(browser, page, logTiming);

    const optimizeDepWatcher = createOptimizeDepWatcher();
    optimizeDepWatcher.attach(page);
    try {
        page = await waitForBodyElement(browser, page, optimizeDepWatcher);
        console.log('[Puppeteer] Waiting for Vue to hydrate...');
        logTiming('Renderer body available');

        const hydrationResult = await waitForHydration(browser, page, optimizeDepWatcher);
        page = hydrationResult.page;
        if (!hydrationResult.hydrated || optimizeDepWatcher.sawOutdatedOptimizeDep()) {
            if (!hydrationResult.hydrated) {
                console.log('[Puppeteer] Vue not ready, reloading page...');
            }
            optimizeDepWatcher.reset();
            const reloadResult = await reloadAndWaitForHydration(browser, page, optimizeDepWatcher);
            page = reloadResult.page;
            if (optimizeDepWatcher.sawOutdatedOptimizeDep()) {
                throw createViteOptimizeDepError(optimizeDepWatcher.optimizeDepUrl() ?? 'Outdated Optimize Dep after reload');
            }
            if (!reloadResult.hydrated) {
                console.log('[Puppeteer] Warning: Vue may not be fully hydrated after reload');
            }
        }

        page = await waitForReadyRenderer(browser, page, optimizeDepWatcher);
        console.log('[Puppeteer] Connected to app');
        logTiming('Renderer bindings ready');
        return {
            browser,
            page,
        };
    } finally {
        optimizeDepWatcher.detach();
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
    if (!staleInfo?.electronPid || !isProcessAlive(staleInfo.electronPid)) {
        return;
    }
    await killProcessTree(staleInfo.electronPid, 500);
    await killElectronProcessesByCdpPort(staleInfo.cdpPort);
    await delay(500);
}

async function allocateAutomationPorts(logTiming: (message: string) => void) {
    const ports = {
        serverPort: await findFreePort(),
        cdpPort: await findFreePort(),
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

async function launchAutomationSessionWithRecovery(options: {
    cdpPort: number;
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
            electronProcess = await startElectron(cdpPort);
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

function attachPageDiagnostics(page: Page) {
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

    return {
        consoleMessages,
        devtoolsEvents,
    };
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
                sessionAlive: isProcessAlive(info.pid),
                nuxtPid: info.nuxtPid,
                nuxtPort: info.nuxtPort,
            }];
        });
}

async function stopSessionElectronProcess(state: ISessionState | null) {
    await state?.browser.disconnect().catch(() => {});
    try {
        if (state?.electronProcess.pid && isProcessAlive(state.electronProcess.pid)) {
            await killProcessTree(state.electronProcess.pid, 800);
        } else {
            state?.electronProcess.kill();
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
    await stopSessionNuxtProcess(sessionState, keepNuxtOnStop);
    sessionState = null;
    process.exit(exitCode);
}

function createSessionCommandServer() {
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
        }));
        clearSessionStarting();

        console.log(`\n\u2713 Session '${getCurrentSessionName()}' ready on port ${options.serverPort}`);
        options.logTiming('Session command server ready');
        console.log('  Press Ctrl+C to stop\n');
    });
}

export async function startSession(forceClean = false) {
    const logTiming = createStartupLogger();
    if (!await ensureSessionCanStart()) {
        return;
    }

    console.log(`Starting Electron Puppeteer session '${getCurrentSessionName()}'...\n`);

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

        if (!sharedRenderer && startupOptions.forceClean) {
            clearElectronUserDataCache();
        }

        await killStaleElectronForCurrentSession();
        const ports = await allocateAutomationPorts(logTiming);
        const launch = await launchAutomationSessionWithRecovery({
            cdpPort: ports.cdpPort,
            nuxtProcess,
            otherRunning: startupOptions.otherRunning,
            usesSharedRenderer: sharedRenderer !== null,
            logTiming,
        });
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

        const server = createSessionCommandServer();
        httpServer = server;
        listenForSessionCommands({
            server,
            serverPort: ports.serverPort,
            cdpPort: launch.cdpPort,
            electronProcess: launch.electronProcess,
            nuxtProcess: launch.nuxtProcess,
            logTiming,
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

function markKeepNuxtOnStop(name: string) {
    mkdirSync(sessionDir(name), {recursive: true});
    writeFileSync(join(sessionDir(name), KEEP_NUXT_ON_STOP_MARKER), String(Date.now()));
}

async function stopSessionController(info: ISessionInfo, name: string, keepNuxt?: boolean) {
    if (keepNuxt && info.nuxtPid && isProcessAlive(info.nuxtPid)) {
        markKeepNuxtOnStop(name);
        try {
            process.kill(info.pid, 'SIGTERM');
        } catch {}
        const didExit = await waitForProcessExit(info.pid, 2500);
        if (!didExit && isProcessAlive(info.pid)) {
            await killProcessTree(info.pid, 1500);
        }
        return;
    }

    if (isProcessAlive(info.pid)) {
        await killProcessTree(info.pid, 1500);
    }
}

async function stopSessionElectron(info: ISessionInfo) {
    if (info.electronPid && isProcessAlive(info.electronPid)) {
        await killProcessTree(info.electronPid, 800);
    }
    await killElectronProcessesByCdpPort(info.cdpPort);
}

async function stopNuxtForSessionInfo(info: ISessionInfo, name: string, keepNuxt?: boolean) {
    if (!info.nuxtPid || !isProcessAlive(info.nuxtPid)) {
        return;
    }
    if (keepNuxt) {
        console.log('[Nuxt] Left running for fast restart');
        return;
    }
    if (hasOtherAliveSessionUsingNuxt(
        readNuxtSessionShareMetadata(),
        name,
        info.nuxtPid,
        info.nuxtPort,
    )) {
        console.log('[Nuxt] Left running (shared with other session)');
        return;
    }
    await killProcessTree(info.nuxtPid, 1200);
}

function removeSessionStopFiles(name: string) {
    try {
        unlinkSync(sessionFilePath(name));
    } catch {}
    try {
        unlinkSync(join(sessionDir(name), KEEP_NUXT_ON_STOP_MARKER));
    } catch {}
}

async function stopSessionInfo(name: string, info: ISessionInfo, keepNuxt?: boolean) {
    await stopSessionController(info, name, keepNuxt);
    await stopSessionElectron(info);
    await stopNuxtForSessionInfo(info, name, keepNuxt);
    removeSessionStopFiles(name);
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
        await stopSessionInfo(name, info, options.keepNuxt);
    }

    if (starting?.pid && isProcessAlive(starting.pid)) {
        await killProcessTree(starting.pid, 1000);
    }
    clearSessionStarting(name);

    await delay(options.keepNuxt ? 1000 : 250);
    console.log(`Session '${name}' stopped.`);
}

export async function stopAllSessions() {
    await cleanupOrphanedProjectNuxtRoots('stop all sessions');

    const names = listAllSessionNames();
    if (names.length === 0) {
        await killExistingNuxt();
        await cleanupOrphanedProjectNuxtRoots('stop all sessions');
        console.log('No sessions found.');
        return;
    }

    for (const name of names) {
        await stopSingleSession(name);
    }

    await killExistingNuxt();
    await cleanupOrphanedProjectNuxtRoots('stop all sessions');
    console.log('All sessions stopped.');
}

export async function stopSession(options: {
    stopAll?: boolean;
    keepNuxt?: boolean;
} = {}) {
    if (options.stopAll) {
        await stopAllSessions();
    } else {
        await stopSingleSession(getCurrentSessionName(), {...(options.keepNuxt === undefined ? {} : { keepNuxt: options.keepNuxt })});
    }
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

export async function startSessionDetached(options: { env?: NodeJS.ProcessEnv } = {}) {
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
        env: {
            ...process.env,
            ...options.env,
        },
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
