import {
    BrowserWindow,
    app,
    session,
    shell,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import {
    startServer,
    stopServer,
    waitForServer,
} from '@electron/server';
import { setupContentSecurityPolicy } from '@electron/security/csp';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const windowIconPath = !app.isPackaged && !config.isMac
    ? join(__dirname, '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
    : undefined;

const logger = createLogger('window');
const windowStartupStartedAt = Date.now();
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
    'http:',
    'https:',
    'mailto:',
]);

function logWindowStartup(phase: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const elapsedMs = now - windowStartupStartedAt;
    const message = `[startup] ${phase} (+${elapsedMs}ms)`;
    logger.info(message);
    console.info(`[${new Date(now).toISOString()}] [window] ${message}`, {
        elapsedMs,
        ...details,
    });
}

const appWindows = new Map<number, BrowserWindow>();
let mainWindowId: number | null = null;
let createMainWindowPromise: Promise<BrowserWindow> | null = null;
let serverReadyPromise: Promise<void> | null = null;
let isDevCacheCleared = false;
let isCspConfigured = false;

interface ICreateAppWindowOptions {setAsMain?: boolean;}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function getTrustedServerOrigin() {
    try {
        return new URL(config.server.url).origin;
    } catch {
        return '';
    }
}

function isTrustedRendererUrl(value: string) {
    const trustedOrigin = getTrustedServerOrigin();
    if (!trustedOrigin) {
        return false;
    }
    const parsed = parseUrl(value);
    if (!parsed) {
        return false;
    }
    return parsed.origin === trustedOrigin;
}

function isAllowedExternalUrl(value: string) {
    const parsed = parseUrl(value);
    if (!parsed) {
        return false;
    }
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
}

function openExternalSafely(url: string, source: 'window-open' | 'navigation') {
    if (!isAllowedExternalUrl(url)) {
        logger.warn(`Blocked ${source} URL with unsupported protocol: ${url}`);
        return;
    }
    void shell.openExternal(url).catch((error) => {
        logger.warn(`Failed to open external URL (${source}): ${error instanceof Error ? error.message : String(error)}`);
    });
}

function hardenWindowWebContents(window: BrowserWindow) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternalSafely(url, 'window-open');
        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
        if (isTrustedRendererUrl(url) || url === 'about:blank') {
            return;
        }

        event.preventDefault();
        openExternalSafely(url, 'navigation');
    });
}

async function lockRendererZoom(window: BrowserWindow) {
    try {
        await window.webContents.setVisualZoomLevelLimits(1, 1);
        window.webContents.setZoomFactor(1);
        window.webContents.setZoomLevel(0);
    } catch (error) {
        logger.warn(
            `Failed to lock renderer zoom: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function syncWindowRegistry() {
    const allWindows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    const activeIds = new Set(allWindows.map(window => window.id));

    for (const window of allWindows) {
        appWindows.set(window.id, window);
    }

    for (const windowId of appWindows.keys()) {
        if (!activeIds.has(windowId)) {
            appWindows.delete(windowId);
        }
    }

    if (mainWindowId !== null && !activeIds.has(mainWindowId)) {
        mainWindowId = allWindows[0]?.id ?? null;
    }
}

async function ensureWindowRuntimeReady() {
    const runtimeStart = Date.now();
    if (!isCspConfigured) {
        isCspConfigured = true;
        setupContentSecurityPolicy();
    }

    if (config.isDev && !isDevCacheCleared) {
        isDevCacheCleared = true;
        try {
            // Prevent stale HTML/asset caching from causing Vite 504 "Outdated Optimize Dep" errors.
            await session.defaultSession.clearCache();
        } catch (err) {
            logger.warn(`Failed to clear HTTP cache: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (!serverReadyPromise) {
        const pendingServerReady = (async () => {
            const serverBootStart = Date.now();
            logWindowStartup('Ensuring Nuxt runtime server is ready');
            await startServer();
            logWindowStartup(`Nuxt runtime process ensured (step +${Date.now() - serverBootStart}ms)`);
            await waitForServer();
            logWindowStartup(`Nuxt runtime server is healthy (step +${Date.now() - serverBootStart}ms)`);
        })();
        serverReadyPromise = pendingServerReady.catch((error) => {
            // Allow the next window creation attempt to retry runtime boot.
            serverReadyPromise = null;
            throw error;
        });
    }

    await serverReadyPromise;
    logWindowStartup(`Window runtime ready (step +${Date.now() - runtimeStart}ms)`);
}

function attachRendererDiagnostics(window: BrowserWindow) {
    const webContents = window.webContents;
    const windowId = window.id;
    let recoveryAttempted = false;

    webContents.on('render-process-gone', (_event, details) => {
        logger.error(`[renderer] render-process-gone (windowId=${windowId}, reason=${details.reason}, exitCode=${details.exitCode})`);

        if (config.isDev || recoveryAttempted || window.isDestroyed()) {
            return;
        }

        recoveryAttempted = true;
        logger.warn(`[renderer] attempting one-time recovery load after renderer exit (windowId=${windowId})`);
        void window.loadURL(config.server.url).catch((error) => {
            logger.error(`Renderer recovery load failed (windowId=${windowId}): ${error instanceof Error ? error.message : String(error)}`);
        });
    });

    window.on('unresponsive', () => {
        logger.error(`[renderer] window unresponsive (windowId=${windowId})`);
    });

    window.on('responsive', () => {
        logger.info(`[renderer] window responsive (windowId=${windowId})`);
    });

    if (!config.isDev) {
        return;
    }

    webContents.on('did-start-loading', () => {
        logger.info(`[renderer] did-start-loading (windowId=${windowId})`);
    });

    webContents.on('did-stop-loading', () => {
        logger.info(`[renderer] did-stop-loading (windowId=${windowId})`);
    });

    webContents.on('did-start-navigation', (
        _event,
        url,
        isInPlace,
        isMainFrame,
    ) => {
        if (!isMainFrame) {
            return;
        }

        logger.info(`[renderer] did-start-navigation (windowId=${windowId}, inPlace=${String(isInPlace)}, url=${url})`);
    });

    webContents.on('did-navigate', (_event, url) => {
        logger.info(`[renderer] did-navigate (windowId=${windowId}, url=${url})`);
    });

    webContents.on('did-finish-load', () => {
        logger.info(`[renderer] did-finish-load (windowId=${windowId}, url=${webContents.getURL()})`);
    });

    webContents.on('did-fail-load', (
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
    ) => {
        logger.error(
            `[renderer] did-fail-load (windowId=${windowId}, mainFrame=${String(isMainFrame)}, `
            + `code=${errorCode}, desc=${errorDescription}, url=${validatedURL})`,
        );
    });
}

function attachShowLifecycle(window: BrowserWindow) {
    // In development, Vite/Nuxt may trigger an immediate full reload (e.g. "Outdated Optimize Dep"),
    // which can cause a white flash and DevTools console to appear to "load twice".
    // Debounce showing the window until navigation settles.
    let hasShownWindow = false;
    let pendingShowTimeout: NodeJS.Timeout | null = null;
    let forceShowTimeout: NodeJS.Timeout | null = null;
    let runtimeServerLoadRetried = false;

    const SHOW_DEBOUNCE_MS = 0;
    const FORCE_SHOW_MS = config.isDev ? 5_000 : 15_000;
    const STABILITY_WINDOW_MS = config.isDev ? 200 : 500;
    let lastNavigationTime = 0;
    let stabilityCheckTimeout: NodeJS.Timeout | null = null;
    const isRuntimeServerUrl = (value: string) => (
        value === config.server.url
        || value === `${config.server.url}/`
        || value.startsWith(`${config.server.url}/`)
    );

    const logNavEvent = (event: string, details?: Record<string, unknown>) => {
        if (config.isDev) {
            const info = {
                timestamp: Date.now(),
                windowId: window.id,
                hasShownWindow,
                pendingShowTimeout: !!pendingShowTimeout,
                stabilityCheckTimeout: !!stabilityCheckTimeout,
                ...details,
            };
            logger.debug(`${event} ${JSON.stringify(info)}`);
        }
    };

    const cleanupShowHandlers = () => {
        if (window.isDestroyed()) {
            return;
        }
        window.webContents.removeListener('did-start-navigation', onStartNavigation);
        window.webContents.removeListener('did-finish-load', onFinishLoad);
        window.webContents.removeListener('did-fail-load', onFailLoad);
    };

    function showAndFocusMaximizedWindow() {
        if (window.isDestroyed()) {
            return;
        }

        if (config.automation.hideWindow) {
            // Automation windows stay hidden so local desktop focus is never disrupted.
            return;
        }

        if (!window.isMaximized()) {
            window.maximize();
        }
        if (!window.isVisible()) {
            if (config.automation.noFocus) {
                // Keep E2E windows out of focus so local work is not interrupted.
                const showInactive = (window as BrowserWindow & { showInactive?: () => void; }).showInactive;
                if (typeof showInactive === 'function') {
                    showInactive.call(window);
                } else {
                    window.show();
                }
            } else {
                window.show();
            }
        }

        if (config.automation.noFocus) {
            return;
        }

        window.focus();

        if (process.platform === 'darwin') {
            app.focus({ steal: true });
        }
    }

    const showWindowNow = async () => {
        if (window.isDestroyed() || hasShownWindow) {
            return;
        }
        hasShownWindow = true;

        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
        if (forceShowTimeout) {
            clearTimeout(forceShowTimeout);
            forceShowTimeout = null;
        }
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
            stabilityCheckTimeout = null;
        }

        if (config.isDev) {
            showAndFocusMaximizedWindow();
            logNavEvent('window-shown-early-for-dev');

            try {
                await window.webContents.executeJavaScript(`
                    window.__navigationTimeline = window.__navigationTimeline || [];
                    window.__navigationTimeline.push({
                        event: 'window-shown',
                        timestamp: ${Date.now()},
                    });
                `);
            } catch {
                // Page might be navigating
            }
        } else {
            showAndFocusMaximizedWindow();
        }

        logWindowStartup(`Window shown (windowId=${window.id})`, {hasShownWindow});

        cleanupShowHandlers();
    };

    const checkStabilityAndShow = () => {
        if (hasShownWindow || window.isDestroyed()) {
            return;
        }

        const timeSinceLastNav = Date.now() - lastNavigationTime;

        if (timeSinceLastNav >= STABILITY_WINDOW_MS) {
            logNavEvent('stability-check-passed', { timeSinceLastNav });
            void showWindowNow();
            return;
        }

        const remaining = STABILITY_WINDOW_MS - timeSinceLastNav;
        logNavEvent('stability-check-pending', {
            timeSinceLastNav,
            remaining,
        });
        stabilityCheckTimeout = setTimeout(checkStabilityAndShow, remaining + 50);
    };

    const scheduleShow = () => {
        if (hasShownWindow || window.isDestroyed()) {
            return;
        }
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
        }
        pendingShowTimeout = setTimeout(() => {
            void showWindowNow();
        }, SHOW_DEBOUNCE_MS);
    };

    const onStartNavigation = (
        _event: unknown,
        url: string,
        _isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (!isMainFrame) {
            return;
        }

        lastNavigationTime = Date.now();
        logNavEvent('navigation-start', { url });

        if (hasShownWindow) {
            return;
        }

        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
            stabilityCheckTimeout = null;
        }
    };

    const onFinishLoad = () => {
        lastNavigationTime = Date.now();
        logNavEvent('navigation-finish-load');

        if (hasShownWindow) {
            return;
        }

        if (config.isDev) {
            if (stabilityCheckTimeout) {
                clearTimeout(stabilityCheckTimeout);
            }
            stabilityCheckTimeout = setTimeout(checkStabilityAndShow, STABILITY_WINDOW_MS);
            return;
        }

        scheduleShow();
    };

    const onFailLoad = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame?: boolean,
    ) => {
        if (isMainFrame === false) {
            return;
        }
        logger.error(`Failed to load URL: ${validatedURL} (code=${errorCode}, desc=${errorDescription})`);

        const shouldRetryRuntimeServerLoad = (
            !config.isDev
            && !runtimeServerLoadRetried
            && errorCode === -102
            && isRuntimeServerUrl(validatedURL)
        );
        if (shouldRetryRuntimeServerLoad) {
            runtimeServerLoadRetried = true;
            logger.warn('Runtime server connection refused during window load; restarting runtime server and retrying once');

            void (async () => {
                try {
                    await stopServer();
                    serverReadyPromise = null;
                    await ensureWindowRuntimeReady();
                    await window.loadURL(config.server.url);
                    logger.info('Recovered window load after runtime server restart');
                } catch (error) {
                    logger.error(
                        `Failed runtime server restart/retry after load refusal: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                    await showWindowNow();
                }
            })();
            return;
        }

        void showWindowNow();
    };

    window.webContents.on('did-start-navigation', onStartNavigation);
    window.webContents.on('did-finish-load', onFinishLoad);
    window.webContents.on('did-fail-load', onFailLoad);

    forceShowTimeout = setTimeout(() => {
        void showWindowNow();
    }, FORCE_SHOW_MS);

    window.on('closed', () => {
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
            pendingShowTimeout = null;
        }
        if (forceShowTimeout) {
            clearTimeout(forceShowTimeout);
            forceShowTimeout = null;
        }
        if (stabilityCheckTimeout) {
            clearTimeout(stabilityCheckTimeout);
            stabilityCheckTimeout = null;
        }

        appWindows.delete(window.id);
        if (mainWindowId === window.id) {
            mainWindowId = null;
            syncWindowRegistry();
        }
    });
}

export async function createAppWindow(options: ICreateAppWindowOptions = {}) {
    const createStart = Date.now();
    await ensureWindowRuntimeReady();

    const preloadPath = join(__dirname, 'preload.js');
    logger.debug(`__dirname: ${__dirname}`);
    logger.debug(`preload path: ${preloadPath}`);

    const window = new BrowserWindow({
        width: config.window.width,
        height: config.window.height,
        title: config.window.title,
        ...(windowIconPath ? { icon: windowIconPath } : {}),
        show: false,
        backgroundColor: config.window.backgroundColor,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,
        },
    });

    appWindows.set(window.id, window);

    const shouldSetMain = options.setAsMain ?? mainWindowId === null;
    if (shouldSetMain) {
        mainWindowId = window.id;
    }

    if (!config.automation.hideWindow && !window.isMaximized()) {
        window.maximize();
    }

    hardenWindowWebContents(window);
    attachRendererDiagnostics(window);
    attachShowLifecycle(window);
    void window.loadURL(config.server.url).catch((error) => {
        logger.error(`Initial loadURL failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    window.webContents.once('did-finish-load', () => {
        void lockRendererZoom(window);
    });
    logWindowStartup(`BrowserWindow created and loadURL dispatched (step +${Date.now() - createStart}ms)`, {
        windowId: window.id,
        url: config.server.url,
    });

    return window;
}

export async function createWindow() {
    const existingMainWindow = getMainWindow();
    if (existingMainWindow) {
        return existingMainWindow;
    }

    if (createMainWindowPromise) {
        return createMainWindowPromise;
    }

    createMainWindowPromise = createAppWindow({setAsMain: true});
    try {
        return await createMainWindowPromise;
    } finally {
        createMainWindowPromise = null;
    }
}

export function getWindowById(windowId: number) {
    const fromRegistry = appWindows.get(windowId);
    if (fromRegistry && !fromRegistry.isDestroyed()) {
        return fromRegistry;
    }

    const fromElectron = BrowserWindow.fromId(windowId);
    if (!fromElectron || fromElectron.isDestroyed()) {
        appWindows.delete(windowId);
        return null;
    }

    appWindows.set(windowId, fromElectron);
    return fromElectron;
}

export function getAllAppWindows() {
    syncWindowRegistry();
    return Array.from(appWindows.values()).filter(window => !window.isDestroyed());
}

export function hasWindows() {
    return getAllAppWindows().length > 0;
}

export function getMainWindow() {
    if (mainWindowId !== null) {
        const mainWindow = getWindowById(mainWindowId);
        if (mainWindow) {
            return mainWindow;
        }
    }

    const fallback = getAllAppWindows()[0] ?? null;
    if (fallback) {
        mainWindowId = fallback.id;
    }

    return fallback;
}
