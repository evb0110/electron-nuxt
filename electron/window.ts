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
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { createWindowRuntime } from '@electron/window/createWindowRuntime';
import { createWindowSecurity } from '@electron/window/createWindowSecurity';
import { getErrorMessage } from '@electron/utils/error';
import { waitForInitialRendererReady } from '@electron/window/rendererReady';
import { loadStartupPlaceholder } from '@electron/window/loadStartupPlaceholder';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
    registerAppWindow,
} from '@electron/window/registry';
import { attachShowLifecycle } from '@electron/window/attachShowLifecycle';
import {
    encodeHostResourceProfileArgument,
    getHostResourceProfileSnapshot,
} from '@electron/resources/hostResourceProfile';

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

let createMainWindowPromise: Promise<BrowserWindow> | null = null;

interface ICreateAppWindowOptions {
    setAsMain?: boolean;
    showStartupPlaceholder?: boolean;
    waitForInitialRendererReady?: boolean;
}
const windowSecurity = createWindowSecurity({
    getTrustedRendererUrl: () => config.renderer.trustedUrl,
    logger,
});
const windowRuntime = createWindowRuntime({
    isDev: config.isDev,
    logger,
    logWindowStartup,
});

function showAndFocusMaximizedWindow(window: BrowserWindow) {
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

async function lockRendererZoom(window: BrowserWindow) {
    try {
        await window.webContents.setVisualZoomLevelLimits(1, 1);
        window.webContents.setZoomFactor(1);
        window.webContents.setZoomLevel(0);
    } catch (error) {
        logger.warn(
            `Failed to lock renderer zoom: ${getErrorMessage(error)}`,
        );
    }
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
            `Failed to prompt for unresponsive renderer recovery (windowId=${windowId}): ${getErrorMessage(error)}`,
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
                await window.loadURL(config.renderer.url);
            } catch (error) {
                logger.error(
                    `Renderer recovery load failed (${reason}, windowId=${windowId}): ${
                        getErrorMessage(error)
                    }`,
                );
            }
        })();
    };

    webContents.on('render-process-gone', (_event, details) => {
        logger.error(`[renderer] render-process-gone (windowId=${windowId}, reason=${details.reason}, exitCode=${details.exitCode})`);
        recoverRenderer(`render-process-gone:${details.reason}`);
    });

    webContents.on('preload-error', (_event, preloadPath, error) => {
        logger.error(
            `[renderer] preload-error (windowId=${windowId}, preload=${preloadPath}): ${
                error.stack ?? getErrorMessage(error)
            }`,
        );
    });

    window.on('unresponsive', () => {
        logger.warn(`[renderer] window unresponsive (windowId=${windowId})`);
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
            logger.error(
                `[renderer] window remained unresponsive after ${UNRESPONSIVE_RECOVERY_DELAY_MS}ms `
                + `(windowId=${windowId})`,
            );
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
        logger.debug(`[renderer] did-start-loading (windowId=${windowId})`);
    });

    webContents.on('did-stop-loading', () => {
        logger.debug(`[renderer] did-stop-loading (windowId=${windowId})`);
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

        logger.debug(`[renderer] did-start-navigation (windowId=${windowId}, inPlace=${String(isInPlace)}, url=${url})`);
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


export async function createAppWindow(options: ICreateAppWindowOptions = {}) {
    const createStart = Date.now();
    const preloadPath = join(__dirname, 'preload.cjs');
    const keepAutomationRendererActive = config.automation.hideWindow || config.automation.noFocus;
    logger.debug(`__dirname: ${__dirname}`);
    logger.debug(`preload path: ${preloadPath}`);

    const window = new BrowserWindow({
        width: config.window.width,
        height: config.window.height,
        title: config.window.title,
        ...(windowIconPath ? { icon: windowIconPath } : {}),
        autoHideMenuBar: false,
        show: false,
        ...(keepAutomationRendererActive ? {paintWhenInitiallyHidden: true} : {}),
        backgroundColor: config.window.backgroundColor,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,
            additionalArguments: [encodeHostResourceProfileArgument(
                getHostResourceProfileSnapshot(),
            )],
            ...(keepAutomationRendererActive ? {backgroundThrottling: false} : {}),
        },
    });

    registerAppWindow(window, {...(options.setAsMain === undefined ? {} : { setAsMain: options.setAsMain })});

    const shouldWaitForInitialRendererReady = options.waitForInitialRendererReady ?? false;
    const shouldShowStartupPlaceholder = options.showStartupPlaceholder ?? !shouldWaitForInitialRendererReady;
    windowSecurity.hardenWindowWebContents(window);
    attachRendererDiagnostics(window);
    attachShowLifecycle(window, {
        blockShowUntilRendererReady: shouldWaitForInitialRendererReady,
        isDev: config.isDev,
        logger,
        showAndFocusMaximizedWindow,
        logWindowStartup,
    });

    const startupPlaceholderPromise = shouldShowStartupPlaceholder
        ? loadStartupPlaceholder(window, {
            title: config.window.title,
            logger,
        })
        : Promise.resolve();
    const runtimeReadyPromise = windowRuntime.ensureReady();
    void runtimeReadyPromise.catch(() => {});

    const initialLoadPromise = (async () => {
        await runtimeReadyPromise;
        await startupPlaceholderPromise.catch(() => {});
        if (window.isDestroyed()) {
            return;
        }
        await window.loadURL(config.renderer.url);
    })();
    void initialLoadPromise.catch((error) => {
        logger.error(`Initial loadURL failed: ${getErrorMessage(error)}`);
    });
    const initialRendererReadyPromise = shouldWaitForInitialRendererReady
        ? waitForInitialRendererReady(window, initialLoadPromise)
        : null;
    window.webContents.on('did-finish-load', () => {
        void lockRendererZoom(window);
    });
    await startupPlaceholderPromise.catch(() => {});
    if (shouldShowStartupPlaceholder) {
        showAndFocusMaximizedWindow(window);
    }
    logWindowStartup(`BrowserWindow created and loadURL dispatched (step +${Date.now() - createStart}ms)`, {
        windowId: window.id,
        url: config.renderer.url,
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
    } else {
        await initialLoadPromise;
    }

    return window;
}

export async function createWindow(options: {
    showStartupPlaceholder?: boolean;
    waitForInitialRendererReady?: boolean;
} = {}) {
    const existingMainWindow = getRegisteredMainWindow();
    if (existingMainWindow) {
        return existingMainWindow;
    }

    if (createMainWindowPromise) {
        return createMainWindowPromise;
    }

    createMainWindowPromise = createAppWindow({
        setAsMain: true,
        ...(options.waitForInitialRendererReady === undefined
            ? {}
            : { waitForInitialRendererReady: options.waitForInitialRendererReady }),
        ...(options.showStartupPlaceholder === undefined
            ? {}
            : { showStartupPlaceholder: options.showStartupPlaceholder }),
    });
    try {
        return await createMainWindowPromise;
    } finally {
        createMainWindowPromise = null;
    }
}

export function hasWindows() {
    return getAllRegisteredAppWindows().length > 0;
}
