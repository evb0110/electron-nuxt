import puppeteer, {
    type Browser,
    type HTTPResponse,
    type Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import {
    ELECTRON_SERVER_PATH,
    getElectronAppUrl,
    waitForReusableNuxtServer,
} from '@scripts/electron-run/electronRunNuxtServer';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';

const RENDERER_READY_TIMEOUT_MS = 30_000;
const ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS = 20_000;
const VITE_OPTIMIZE_DEP_ERROR_MARKER = 'VITE_OPTIMIZE_DEP_504';
const RENDERER_READINESS_ERROR_NAME = 'RendererReadinessError';
const RENDERER_DEAD_PAGE_RELOAD_INTERVAL_MS = 5_000;
const RENDERER_DEAD_PAGE_MAX_RELOADS = 5;

function formatElapsedMs(startedAt: number) {
    return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

function createStartupLogger(startedAt = Date.now()) {
    return (message: string) => {
        console.log(`[Startup +${formatElapsedMs(startedAt)}] ${message}`);
    };
}

function createViteOptimizeDepError(details = '') {
    const message = details
        ? `${VITE_OPTIMIZE_DEP_ERROR_MARKER}: ${details}`
        : VITE_OPTIMIZE_DEP_ERROR_MARKER;
    const error = new Error(message);
    error.name = 'ViteOptimizeDepError';
    return error;
}

export function isViteOptimizeDepError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === 'ViteOptimizeDepError'
        || error.message.includes(VITE_OPTIMIZE_DEP_ERROR_MARKER)
        || error.message.includes('Outdated Optimize Dep')
        || error.message.includes('optimize-dep');
}

function createRendererReadinessError(message: string) {
    const error = new Error(message);
    error.name = RENDERER_READINESS_ERROR_NAME;
    return error;
}

export function isRendererReadinessError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === RENDERER_READINESS_ERROR_NAME
        || error.message.includes('Renderer readiness timeout')
        || error.message.includes('Renderer startup timed out');
}

export function isTransientPageContextError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.message.includes('Execution context was destroyed')
        || error.message.includes('Attempted to use detached Frame')
        || error.message.includes('Cannot find context with specified id')
        || error.message.includes('Most likely the page has been closed');
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

function hasRendererDeadDevServerBody(state: IRendererState) {
    return state.bodyTextSnippet.includes('Failed to fetch dynamically imported module')
        || state.bodyTextSnippet.includes('500 Internal Server Error');
}

async function waitForRendererBindings(page: Page, timeoutMs = RENDERER_READY_TIMEOUT_MS): Promise<IRendererState> {
    const start = Date.now();
    let reloadCount = 0;
    let lastReloadAt = 0;
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
        } catch {
            await delay(250);
            continue;
        }
        if (isRendererReady(lastState)) {
            return lastState;
        }
        const now = Date.now();
        if (
            hasRendererDeadDevServerBody(lastState)
            && reloadCount < RENDERER_DEAD_PAGE_MAX_RELOADS
            && now - lastReloadAt >= RENDERER_DEAD_PAGE_RELOAD_INTERVAL_MS
        ) {
            reloadCount += 1;
            lastReloadAt = now;
            console.log(`[Puppeteer] Renderer loaded transient dev-server error, reloading (${reloadCount}/${RENDERER_DEAD_PAGE_MAX_RELOADS})...`);
            try {
                await page.reload({
                    waitUntil: 'domcontentloaded',
                    timeout: 10_000,
                });
            } catch (error) {
                if (!isTransientPageContextError(error) && !isNavigationAbortedError(error)) {
                    console.log(`[Puppeteer] Renderer reload failed while recovering from transient dev-server error: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
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

function isElectronRendererPath(pathname: string) {
    return pathname === ELECTRON_SERVER_PATH
        || pathname.startsWith(`${ELECTRON_SERVER_PATH}/`);
}

function isLocalNuxtHost(hostname: string) {
    return hostname === '127.0.0.1'
        || hostname === 'localhost'
        || hostname === '::1'
        || hostname === '[::1]';
}

export function isElectronAppPageUrl(url: string) {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol === 'evb-viewer:' && parsedUrl.hostname === 'app') {
            return isElectronRendererPath(parsedUrl.pathname);
        }

        return (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
            && isLocalNuxtHost(parsedUrl.hostname)
            && parsedUrl.port === String(getNuxtPort())
            && isElectronRendererPath(parsedUrl.pathname);
    } catch {
        return false;
    }
}

export function isNuxtDevServerUrl(url: string) {
    try {
        const parsedUrl = new URL(url);
        return (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
            && isLocalNuxtHost(parsedUrl.hostname)
            && parsedUrl.port === String(getNuxtPort());
    } catch {
        return false;
    }
}

async function findAppPage(browser: Browser): Promise<Page | null> {
    const pages = await browser.pages();
    return pages.find(page => isElectronAppPageUrl(page.url())) ?? null;
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
    if (isElectronAppPageUrl(page.url())) {
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
                if (response.status() === 504 && isNuxtDevServerUrl(response.url())) {
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
        throw createRendererReadinessError(`Renderer readiness timeout (openFileDirect=${rendererState.openFileDirect}, electronAPI=${rendererState.electronAPI}, nuxtChildren=${rendererState.nuxtRootChildren}, text=${rendererState.bodyTextLength}, url=${rendererState.url}, body="${rendererState.bodyTextSnippet}")`);
    }
    return currentPage;
}

export async function connectToBrowser(cdpPort: number): Promise<{
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
