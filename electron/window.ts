import {
    BrowserWindow,
    app,
    dialog,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { config } from '@electron/config';
import { WINDOW_RENDERER_READY_TIMEOUT_MS } from '@electron/config/constants';
import { te } from '@electron/i18n';
import { stopServer } from '@electron/server';
import { createLogger } from '@electron/utils/logger';
import { createWindowRuntime } from '@electron/window/runtime';
import { createWindowSecurity } from '@electron/window/security';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const windowIconPath = !app.isPackaged && !config.isMac
    ? join(__dirname, '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
    : undefined;

const logger = createLogger('window');
const windowStartupStartedAt = Date.now();
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const UNRESPONSIVE_RECOVERY_DELAY_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_WINDOW_UNRESPONSIVE_RECOVERY_MS ?? '15000', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 15_000;
    }
    return parsed;
})();

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
const windowStartupWaiters = new Map<number, IWindowStartupWaiter>();
const windowRendererReadyCallbacks = new Map<number, () => void>();

interface ICreateAppWindowOptions {
    setAsMain?: boolean;
    waitForInitialRendererReady?: boolean;
}
interface IWindowStartupWaiter {
    resolve: () => void;
    reject: (error: Error) => void;
    retryableConnectionRefusalSeen: boolean;
    timeoutHandle: NodeJS.Timeout | null;
}
interface IAttachShowLifecycleOptions {blockShowUntilRendererReady?: boolean;}

function formatErrorMessage(error: unknown) {
    return error instanceof Error
        ? error.message
        : String(error);
}
const windowSecurity = createWindowSecurity({
    logger,
    serverUrl: config.server.url,
});
const windowRuntime = createWindowRuntime({
    isDev: config.isDev,
    logger,
    logWindowStartup,
});

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

function waitForInitialRendererReady(
    window: BrowserWindow,
    initialLoadPromise: Promise<void>,
) {
    return new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            window.webContents.removeListener('did-fail-load', handleFailLoad);
            window.webContents.removeListener('render-process-gone', handleRenderProcessGone);
            window.removeListener('closed', handleClosed);

            const waiter = windowStartupWaiters.get(window.id);
            if (waiter?.timeoutHandle) {
                clearTimeout(waiter.timeoutHandle);
            }
            windowStartupWaiters.delete(window.id);
        };

        const resolveReady = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };

        const rejectReady = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const handleFailLoad = (
            _event: unknown,
            errorCode: number,
            errorDescription: string,
            validatedURL: string,
            isMainFrame?: boolean,
        ) => {
            if (isMainFrame === false) {
                return;
            }

            const waiter = windowStartupWaiters.get(window.id);
            if (
                waiter
                && !config.isDev
                && !waiter.retryableConnectionRefusalSeen
                && errorCode === -102
                && windowSecurity.isRuntimeServerUrl(validatedURL)
            ) {
                waiter.retryableConnectionRefusalSeen = true;
                return;
            }

            rejectReady(new Error(
                `Initial renderer load failed (${errorCode}: ${errorDescription}) for ${validatedURL}`,
            ));
        };

        const handleRenderProcessGone = (
            _event: unknown,
            details: {
                reason: string;
                exitCode: number;
            },
        ) => {
            rejectReady(new Error(
                `Renderer process exited before startup completed (${details.reason}, exitCode=${details.exitCode})`,
            ));
        };

        const handleClosed = () => {
            rejectReady(new Error('Window closed before renderer startup completed'));
        };

        const timeoutHandle = setTimeout(() => {
            rejectReady(new Error(`Renderer startup timed out after ${WINDOW_RENDERER_READY_TIMEOUT_MS}ms`));
        }, WINDOW_RENDERER_READY_TIMEOUT_MS);
        timeoutHandle.unref?.();

        windowStartupWaiters.set(window.id, {
            resolve: resolveReady,
            reject: rejectReady,
            retryableConnectionRefusalSeen: false,
            timeoutHandle,
        });

        window.webContents.on('did-fail-load', handleFailLoad);
        window.webContents.on('render-process-gone', handleRenderProcessGone);
        window.on('closed', handleClosed);

        void initialLoadPromise.catch((error) => {
            queueMicrotask(() => {
                const waiter = windowStartupWaiters.get(window.id);
                if (!waiter || waiter.retryableConnectionRefusalSeen) {
                    return;
                }
                rejectReady(new Error(`Initial loadURL failed: ${formatErrorMessage(error)}`));
            });
        });
    });
}

async function promptUnresponsiveRendererRecovery(
    window: BrowserWindow,
    windowId: number,
    recoverRenderer: (reason: string) => void,
) {
    if (window.isDestroyed()) {
        return;
    }

    if (config.automation.hideWindow || config.automation.noFocus) {
        recoverRenderer('unresponsive-automation-reload');
        return;
    }

    const BUTTON_WAIT = 0;
    const BUTTON_RELOAD = 1;

    try {
        const { response } = await dialog.showMessageBox(window, {
            type: 'warning',
            title: te('dialogs.unresponsiveRenderer.title'),
            message: te('dialogs.unresponsiveRenderer.message'),
            detail: te('dialogs.unresponsiveRenderer.detail'),
            buttons: [
                te('dialogs.unresponsiveRenderer.wait'),
                te('dialogs.unresponsiveRenderer.reload'),
            ],
            defaultId: BUTTON_WAIT,
            cancelId: BUTTON_WAIT,
            noLink: true,
        });

        if (response === BUTTON_RELOAD && !window.isDestroyed()) {
            recoverRenderer('unresponsive-dialog-reload');
        }
    } catch (error) {
        logger.error(
            `Failed to prompt for unresponsive renderer recovery (windowId=${windowId}): ${formatErrorMessage(error)}`,
        );
        recoverRenderer('unresponsive-dialog-fallback');
    }
}

function attachRendererDiagnostics(window: BrowserWindow) {
    const webContents = window.webContents;
    const windowId = window.id;
    let recoveryAttempted = false;
    let unresponsiveRecoveryTimer: NodeJS.Timeout | null = null;
    let unresponsivePromptInFlight = false;

    const clearUnresponsiveRecoveryTimer = () => {
        if (!unresponsiveRecoveryTimer) {
            return;
        }
        clearTimeout(unresponsiveRecoveryTimer);
        unresponsiveRecoveryTimer = null;
    };

    const recoverRenderer = (reason: string) => {
        if (config.isDev || recoveryAttempted || window.isDestroyed()) {
            return;
        }

        recoveryAttempted = true;
        clearUnresponsiveRecoveryTimer();
        logger.warn(`[renderer] attempting one-time recovery load (${reason}, windowId=${windowId})`);
        void (async () => {
            try {
                await windowRuntime.ensureReady();
                if (window.isDestroyed()) {
                    return;
                }
                await window.loadURL(config.server.url);
            } catch (error) {
                logger.error(
                    `Renderer recovery load failed (${reason}, windowId=${windowId}): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        })();
    };

    webContents.on('render-process-gone', (_event, details) => {
        logger.error(`[renderer] render-process-gone (windowId=${windowId}, reason=${details.reason}, exitCode=${details.exitCode})`);
        recoverRenderer(`render-process-gone:${details.reason}`);
    });

    window.on('unresponsive', () => {
        logger.error(`[renderer] window unresponsive (windowId=${windowId})`);
        if (config.isDev || recoveryAttempted || window.isDestroyed() || UNRESPONSIVE_RECOVERY_DELAY_MS <= 0) {
            return;
        }
        clearUnresponsiveRecoveryTimer();
        unresponsiveRecoveryTimer = setTimeout(() => {
            unresponsiveRecoveryTimer = null;
            if (window.isDestroyed() || recoveryAttempted || unresponsivePromptInFlight) {
                return;
            }

            unresponsivePromptInFlight = true;
            logger.warn(`[renderer] prompting recovery for unresponsive renderer (windowId=${windowId})`);
            void promptUnresponsiveRendererRecovery(window, windowId, recoverRenderer)
                .finally(() => {
                    unresponsivePromptInFlight = false;
                });
        }, UNRESPONSIVE_RECOVERY_DELAY_MS);
        unresponsiveRecoveryTimer.unref?.();
    });

    window.on('responsive', () => {
        logger.info(`[renderer] window responsive (windowId=${windowId})`);
        clearUnresponsiveRecoveryTimer();
    });

    window.on('closed', () => {
        clearUnresponsiveRecoveryTimer();
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

function attachShowLifecycle(
    window: BrowserWindow,
    options: IAttachShowLifecycleOptions = {},
) {
    // In development, Vite/Nuxt may trigger an immediate full reload (e.g. "Outdated Optimize Dep"),
    // which can cause a white flash and DevTools console to appear to "load twice".
    // Debounce showing the window until navigation settles.
    let hasShownWindow = false;
    let pendingShowTimeout: NodeJS.Timeout | null = null;
    let forceShowTimeout: NodeJS.Timeout | null = null;
    let runtimeServerLoadRetried = false;
    let mainFrameLoadFinished = false;
    const blockShowUntilRendererReady = options.blockShowUntilRendererReady ?? false;
    let rendererReadyForShow = !blockShowUntilRendererReady;

    const SHOW_DEBOUNCE_MS = 0;
    const FORCE_SHOW_MS = config.isDev ? 5_000 : 15_000;
    const STABILITY_WINDOW_MS = config.isDev ? 200 : 500;
    let lastNavigationTime = 0;
    let stabilityCheckTimeout: NodeJS.Timeout | null = null;

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
        windowRendererReadyCallbacks.delete(window.id);
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
        if (!rendererReadyForShow) {
            logNavEvent('stability-check-waiting-for-renderer-ready');
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
        if (!rendererReadyForShow) {
            logNavEvent('show-suppressed-pending-renderer-ready');
            return;
        }
        if (pendingShowTimeout) {
            clearTimeout(pendingShowTimeout);
        }
        pendingShowTimeout = setTimeout(() => {
            void showWindowNow();
        }, SHOW_DEBOUNCE_MS);
    };

    const scheduleForceShowTimeout = () => {
        if (forceShowTimeout || hasShownWindow || window.isDestroyed()) {
            return;
        }
        if (!rendererReadyForShow) {
            logNavEvent('force-show-suppressed-pending-renderer-ready');
            return;
        }

        forceShowTimeout = setTimeout(() => {
            void showWindowNow();
        }, FORCE_SHOW_MS);
    };

    const onRendererReadyForShow = () => {
        rendererReadyForShow = true;
        logNavEvent('renderer-ready-for-show', { mainFrameLoadFinished });
        scheduleForceShowTimeout();

        if (!mainFrameLoadFinished || hasShownWindow) {
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

    const onStartNavigation = (
        _event: unknown,
        url: string,
        _isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (!isMainFrame) {
            return;
        }

        mainFrameLoadFinished = false;
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
        mainFrameLoadFinished = true;
        lastNavigationTime = Date.now();
        logNavEvent('navigation-finish-load');

        if (hasShownWindow) {
            return;
        }
        if (!rendererReadyForShow) {
            logNavEvent('finish-load-waiting-for-renderer-ready');
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
        mainFrameLoadFinished = false;

        const shouldRetryRuntimeServerLoad = (
            !config.isDev
            && !runtimeServerLoadRetried
            && errorCode === -102
            && windowSecurity.isRuntimeServerUrl(validatedURL)
        );
        if (shouldRetryRuntimeServerLoad) {
            runtimeServerLoadRetried = true;
            logger.warn('Runtime server connection refused during window load; restarting runtime server and retrying once');

            void (async () => {
                try {
                    await stopServer();
                    windowRuntime.resetServerPromise();
                    await windowRuntime.ensureReady();
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

        if (blockShowUntilRendererReady && !rendererReadyForShow) {
            logNavEvent('load-failure-hidden-during-strict-startup', {
                errorCode,
                validatedURL,
            });
            return;
        }

        void showWindowNow();
    };

    windowRendererReadyCallbacks.set(window.id, onRendererReadyForShow);
    window.webContents.on('did-start-navigation', onStartNavigation);
    window.webContents.on('did-finish-load', onFinishLoad);
    window.webContents.on('did-fail-load', onFailLoad);

    scheduleForceShowTimeout();

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
        windowRendererReadyCallbacks.delete(window.id);
        if (mainWindowId === window.id) {
            mainWindowId = null;
            syncWindowRegistry();
        }
    });
}

export async function createAppWindow(options: ICreateAppWindowOptions = {}) {
    const createStart = Date.now();
    await windowRuntime.ensureReady();

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

    const shouldWaitForInitialRendererReady = options.waitForInitialRendererReady ?? false;
    windowSecurity.hardenWindowWebContents(window);
    attachRendererDiagnostics(window);
    attachShowLifecycle(window, { blockShowUntilRendererReady: shouldWaitForInitialRendererReady });
    const initialLoadPromise = window.loadURL(config.server.url);
    void initialLoadPromise.catch((error) => {
        logger.error(`Initial loadURL failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const initialRendererReadyPromise = shouldWaitForInitialRendererReady
        ? waitForInitialRendererReady(window, initialLoadPromise)
        : null;
    window.webContents.once('did-finish-load', () => {
        void lockRendererZoom(window);
    });
    logWindowStartup(`BrowserWindow created and loadURL dispatched (step +${Date.now() - createStart}ms)`, {
        windowId: window.id,
        url: config.server.url,
    });

    if (initialRendererReadyPromise) {
        try {
            await initialRendererReadyPromise;
        } catch (error) {
            if (!window.isDestroyed()) {
                window.destroy();
            }
            throw error;
        }
    }

    return window;
}

export function markWindowRendererReady(windowId: number) {
    windowRendererReadyCallbacks.get(windowId)?.();

    const waiter = windowStartupWaiters.get(windowId);
    if (!waiter) {
        return;
    }

    if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
    }
    windowStartupWaiters.delete(windowId);
    waiter.resolve();
}

export async function createWindow(options: { waitForInitialRendererReady?: boolean; } = {}) {
    const existingMainWindow = getMainWindow();
    if (existingMainWindow) {
        return existingMainWindow;
    }

    if (createMainWindowPromise) {
        return createMainWindowPromise;
    }

    createMainWindowPromise = createAppWindow({
        setAsMain: true,
        waitForInitialRendererReady: options.waitForInitialRendererReady,
    });
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
