import {
    BrowserWindow,
    app,
    dialog,
    ipcMain,
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
import {
    notifyWindowRendererLoadFailure,
    waitForInitialRendererReady,
} from '@electron/window/rendererReady';
import { loadStartupPlaceholder } from '@electron/window/loadStartupPlaceholder';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
    registerAppWindow,
} from '@electron/window/registry';
import { attachShowLifecycle } from '@electron/window/attachShowLifecycle';
import { attachNativeWindowCloseHandshake } from '@electron/window/windowCloseHandshake';
import {
    encodeHostResourceProfileArgument,
    getHostResourceProfileSnapshot,
} from '@electron/resources/hostResourceProfile';
import { getMainFailureReporter } from '@electron/features/diagnostics/public';
import { encodeDiagnosticsPolicyArgument } from '@electron/platform-ipc/coreContract';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

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
const RENDERER_RECOVERY_WINDOW_MS = 5 * 60_000;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;

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
let shouldBypassNativeWindowClose = () => false;

export function configureNativeWindowCloseHandshake(options: {shouldBypass: () => boolean}) {
    shouldBypassNativeWindowClose = options.shouldBypass;
}

interface ICreateAppWindowOptions {
    setAsMain?: boolean;
    showStartupPlaceholder?: boolean;
    waitForInitialRendererReady?: boolean;
}

interface IWindowLoadAttempt {
    reported: boolean;
    receipt?: FailureReceipt;
}

interface IWindowLoadFailureOwner {
    initialAttempt: IWindowLoadAttempt;
    getCurrentAttempt: () => IWindowLoadAttempt;
    observeTopLevelNavigation: (url: string, isInPlace: boolean, isMainFrame: boolean) => void;
    report: (attempt: IWindowLoadAttempt, error: Error) => FailureReceipt | undefined;
}

function createWindowLoadFailureOwner(): IWindowLoadFailureOwner {
    const initialAttempt: IWindowLoadAttempt = {reported: false};
    let currentAttempt = initialAttempt;
    let observedInitialNavigation = false;

    return {
        initialAttempt,
        getCurrentAttempt: () => currentAttempt,
        observeTopLevelNavigation: (url, isInPlace, isMainFrame) => {
            if (!isMainFrame || isInPlace || url === 'about:blank') {
                return;
            }
            if (!observedInitialNavigation) {
                observedInitialNavigation = true;
                return;
            }
            currentAttempt = {reported: false};
        },
        report: (attempt, error) => {
            if (attempt.reported) {
                return attempt.receipt;
            }

            attempt.reported = true;
            const receipt = logger.error(error.message);
            if (receipt) {
                attempt.receipt = receipt;
            }
            return receipt;
        },
    };
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

    if (process.platform === 'darwin') {
        app.focus({ steal: true });
    }
    window.focus();
    window.webContents.focus();
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
    let recoveryInFlight = false;
    let recentRecoveryAttempts: number[] = [];
    let unresponsiveRecoveryTimer: NodeJS.Timeout | null = null;
    let unresponsivePromptInFlight = false;

    const isRecoveryUnavailable = (includePrompt = false) => {
        const now = Date.now();
        recentRecoveryAttempts = recentRecoveryAttempts.filter(
            attemptedAt => now - attemptedAt < RENDERER_RECOVERY_WINDOW_MS,
        );
        return recoveryInFlight
            || window.isDestroyed()
            || recentRecoveryAttempts.length >= RENDERER_RECOVERY_MAX_ATTEMPTS
            || (includePrompt && unresponsivePromptInFlight);
    };

    const clearUnresponsiveRecoveryTimer = () => {
        if (!unresponsiveRecoveryTimer) {
            return;
        }
        clearTimeout(unresponsiveRecoveryTimer);
        unresponsiveRecoveryTimer = null;
    };

    const recoverRenderer = (reason: string) => {
        if (config.isDev || isRecoveryUnavailable()) {
            return;
        }

        recoveryInFlight = true;
        recentRecoveryAttempts.push(Date.now());
        clearUnresponsiveRecoveryTimer();
        logger.warn(`[renderer] attempting recovery load (${reason}, windowId=${windowId}, attempt=${recentRecoveryAttempts.length})`);
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
            } finally {
                recoveryInFlight = false;
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
        if (config.isDev || isRecoveryUnavailable(true) || UNRESPONSIVE_RECOVERY_DELAY_MS <= 0) {
            return;
        }
        clearUnresponsiveRecoveryTimer();
        unresponsiveRecoveryTimer = setTimeout(() => {
            unresponsiveRecoveryTimer = null;
            if (isRecoveryUnavailable(true)) {
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
            additionalArguments: [
                encodeHostResourceProfileArgument(getHostResourceProfileSnapshot()),
                encodeDiagnosticsPolicyArgument(getMainFailureReporter()?.getPreference()),
            ],
            ...(keepAutomationRendererActive ? {backgroundThrottling: false} : {}),
        },
    });

    registerAppWindow(window, {...(options.setAsMain === undefined ? {} : { setAsMain: options.setAsMain })});
    attachNativeWindowCloseHandshake(window, {
        ipcMain,
        logger,
        shouldBypass: () => shouldBypassNativeWindowClose(),
    });

    const shouldWaitForInitialRendererReady = options.waitForInitialRendererReady ?? false;
    const shouldShowStartupPlaceholder = options.showStartupPlaceholder ?? !shouldWaitForInitialRendererReady;
    const windowLoadFailureOwner = createWindowLoadFailureOwner();
    const initialLoadAttempt = windowLoadFailureOwner.initialAttempt;
    windowSecurity.hardenWindowWebContents(window);
    attachRendererDiagnostics(window);
    const showLifecycle = attachShowLifecycle(window, {
        blockShowUntilRendererReady: shouldWaitForInitialRendererReady,
        isDev: config.isDev,
        logger,
        showAndFocusMaximizedWindow,
        logWindowStartup,
    });

    const handleTopLevelNavigationStart = (
        _event: unknown,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        windowLoadFailureOwner.observeTopLevelNavigation(url, isInPlace, isMainFrame);
    };
    const handleMainFrameLoadFailure = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame?: boolean,
    ) => {
        if (isMainFrame === false) {
            return;
        }

        const attempt = windowLoadFailureOwner.getCurrentAttempt();
        const error = new Error(
            attempt === initialLoadAttempt
                ? `Initial renderer load failed (${errorCode}: ${errorDescription}) for ${validatedURL}`
                : `Renderer navigation failed (${errorCode}: ${errorDescription}) for ${validatedURL}`,
        );
        windowLoadFailureOwner.report(attempt, error);
        if (attempt === initialLoadAttempt) {
            notifyWindowRendererLoadFailure(window.id, error);
        }
        showLifecycle.handleMainFrameLoadFailure();
    };
    window.webContents.on('did-start-navigation', handleTopLevelNavigationStart);
    window.webContents.on('did-fail-load', handleMainFrameLoadFailure);
    window.on('closed', () => {
        window.webContents.removeListener('did-start-navigation', handleTopLevelNavigationStart);
        window.webContents.removeListener('did-fail-load', handleMainFrameLoadFailure);
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
        windowLoadFailureOwner.report(
            initialLoadAttempt,
            new Error(`Initial loadURL failed: ${getErrorMessage(error)}`),
        );
    });
    const initialRendererReadyPromise = shouldWaitForInitialRendererReady
        ? waitForInitialRendererReady(window, initialLoadPromise, {onInitialLoadFailure: error => {
            windowLoadFailureOwner.report(initialLoadAttempt, error);
        }})
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
