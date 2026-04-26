import type { IpcRendererEvent } from 'electron';
import {
    contextBridge,
    ipcRenderer,
    webUtils,
} from 'electron';
import { installViteOutdatedOptimizeDepRecovery } from '@electron/preload/dev-recovery';
import { createElectronApi } from '@electron/preload/create-electron-api';
import { pushDebugLogMessage } from '@electron/preload/debug-log-buffer';

const PRELOAD_INSTALL_FLAG = '__preloadInstalled';
const preloadScriptStartedAt = Date.now();
const STARTUP_OVERLAY_ID = 'evb-startup-overlay';
const STARTUP_OVERLAY_STYLE_ID = 'evb-startup-overlay-style';
const APP_READY_EVENT_NAME = 'evb:app-ready';
const DEV_STARTUP_OVERLAY_SHOWN_KEY = 'evb-viewer:dev:startup-overlay-shown';
const STARTUP_OVERLAY_SPINNER_SIZE_PX = 24;
const STARTUP_OVERLAY_GAP_PX = 12;
const STARTUP_OVERLAY_TEXT_FONT_SIZE_PX = 14;
const STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX = 14;
const DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS = 2200;
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const STARTUP_TRACE_ENABLED_KEY = '__EVB_STARTUP_TRACE__';

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return '';
    }

    try {
        return ` details=${JSON.stringify(details)}`;
    } catch {
        return ' details=<unserializable>';
    }
}

function tracePreload(stage: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const iso = new Date(now).toISOString();
    console.info(
        `[${iso}] [startup][preload] ${stage} (+${now - preloadScriptStartedAt}ms from preload-script-start)`
        + stringifyDetails(details),
    );
}

function forwardPreloadLogToMain(
    level: 'debug' | 'info' | 'warn' | 'error',
    section: string,
    message: string,
    data?: Record<string, unknown>,
) {
    try {
        ipcRenderer.send('renderer:log', {
            level,
            section,
            message,
            timestamp: new Date().toISOString(),
            data,
        });
    } catch {
        // Avoid crashing preload if IPC is not available yet
    }
}

function ensureStartupOverlayStyles() {
    if (document.getElementById(STARTUP_OVERLAY_STYLE_ID)) {
        return;
    }

    const style = document.createElement('style');
    style.id = STARTUP_OVERLAY_STYLE_ID;
    style.textContent = `
#${STARTUP_OVERLAY_ID} {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    color: #475569;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1;
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${STARTUP_OVERLAY_GAP_PX}px;
    min-height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX + STARTUP_OVERLAY_GAP_PX + STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__spinner {
    width: ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    border-radius: 999px;
    background: conic-gradient(
        from 0deg,
        rgba(0, 0, 0, 0.12) 0deg,
        rgba(0, 0, 0, 0.12) 260deg,
        rgba(0, 0, 0, 0.5) 360deg
    );
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
    animation: evb-startup-overlay-spin 0.9s linear infinite;
    will-change: transform;
    transform: translateZ(0);
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__text {
    font-size: ${STARTUP_OVERLAY_TEXT_FONT_SIZE_PX}px;
    line-height: ${STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
    letter-spacing: 0.2px;
    margin: 0;
}
@keyframes evb-startup-overlay-spin {
    from { transform: translateZ(0) rotate(0deg); }
    to { transform: translateZ(0) rotate(360deg); }
}
`;
    document.head.appendChild(style);
}

function mountStartupOverlay() {
    if (document.getElementById(STARTUP_OVERLAY_ID)) {
        return;
    }

    ensureStartupOverlayStyles();
    const overlay = document.createElement('div');
    overlay.id = STARTUP_OVERLAY_ID;
    overlay.innerHTML = `
<div class="evb-startup-overlay__inner">
  <div class="evb-startup-overlay__spinner"></div>
  <div class="evb-startup-overlay__text">Loading...</div>
</div>
`;
    document.body.appendChild(overlay);
    tracePreload('startup overlay mounted');
    forwardPreloadLogToMain('info', 'loader', 'Startup overlay mounted', {
        variant: 'startup-overlay',
        spinnerSizePx: STARTUP_OVERLAY_SPINNER_SIZE_PX,
        hasLabel: true,
    });
}

function unmountStartupOverlay(reason: string) {
    const overlay = document.getElementById(STARTUP_OVERLAY_ID);
    if (overlay) {
        overlay.remove();
        tracePreload('startup overlay removed', { reason });
        forwardPreloadLogToMain('info', 'loader', 'Startup overlay removed', {
            variant: 'startup-overlay',
            reason,
        });
    }
}

function installStartupOverlayLifecycle() {
    const overlayLifecycleStartedAt = Date.now();

    function requestOverlayUnmount(reason: string) {
        if (!process.defaultApp) {
            unmountStartupOverlay(reason);
            return;
        }

        const removeWithDelay = () => {
            const elapsedMs = Date.now() - overlayLifecycleStartedAt;
            if (elapsedMs >= DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS) {
                unmountStartupOverlay(reason);
                return;
            }

            const delayMs = DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS - elapsedMs;
            forwardPreloadLogToMain('info', 'loader', 'Startup overlay removal delayed for dev stabilization', {
                variant: 'startup-overlay',
                reason,
                delayMs,
                elapsedMs,
            });
            window.setTimeout(() => {
                unmountStartupOverlay(reason);
            }, delayMs);
        };

        removeWithDelay();
    }

    if (process.defaultApp) {
        try {
            const overlayAlreadyShown = window.sessionStorage.getItem(DEV_STARTUP_OVERLAY_SHOWN_KEY) === '1';
            if (overlayAlreadyShown) {
                tracePreload('startup overlay continuing across dev reload', {reason: DEV_STARTUP_OVERLAY_SHOWN_KEY});
                forwardPreloadLogToMain('info', 'loader', 'Startup overlay continuing across dev reload', {variant: 'startup-overlay'});
            }

            window.sessionStorage.setItem(DEV_STARTUP_OVERLAY_SHOWN_KEY, '1');
        } catch {
            // sessionStorage may be unavailable
        }
    }

    mountStartupOverlay();

    const start = Date.now();
    const MAX_WAIT_MS = 30_000;
    const checkInterval = window.setInterval(() => {
        const windowWithReady = window as Window & { __appReady?: boolean };
        if (windowWithReady.__appReady) {
            window.clearInterval(checkInterval);
            requestOverlayUnmount('__appReady-interval');
            return;
        }

        if (Date.now() - start > MAX_WAIT_MS) {
            window.clearInterval(checkInterval);
            unmountStartupOverlay('timeout');
        }
    }, 50);

    window.addEventListener(APP_READY_EVENT_NAME, () => {
        window.clearInterval(checkInterval);
        requestOverlayUnmount('app-ready-event');
    }, { once: true });
}

const preloadState = globalThis as Record<string, unknown>;

const preloadAlreadyInstalled = preloadState[PRELOAD_INSTALL_FLAG] === true;
if (preloadAlreadyInstalled) {
    console.debug('[Preload] Skipping duplicate installation (fast reload detected)');
}

if (!preloadAlreadyInstalled) {
    tracePreload('preload installation started');
    preloadState[PRELOAD_INSTALL_FLAG] = true;
    (window as Window & {[STARTUP_TRACE_ENABLED_KEY]?: boolean;})[STARTUP_TRACE_ENABLED_KEY] = STARTUP_TRACE_ENABLED;

    ipcRenderer.on('debug:log', (_event: IpcRendererEvent, data: {
        source: string;
        message: string;
        timestamp: string;
    }) => {
        pushDebugLogMessage(data);
        console.log(`[${data.timestamp}] [${data.source}] ${data.message}`);
    });

    const logDevRecovery = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => {
        if (level === 'debug') {
            if (data) {
                console.debug(message, data);
            } else {
                console.debug(message);
            }
        } else if (level === 'info') {
            if (data) {
                console.info(message, data);
            } else {
                console.info(message);
            }
        } else if (level === 'warn') {
            if (data) {
                console.warn(message, data);
            } else {
                console.warn(message);
            }
        } else if (data) {
            console.error(message, data);
        } else {
            console.error(message);
        }

        forwardPreloadLogToMain(level, 'dev-recovery', message, data);
    };

    installViteOutdatedOptimizeDepRecovery({ log: logDevRecovery });
    tracePreload('dev recovery hooks installed');

    contextBridge.exposeInMainWorld('electronAPI', createElectronApi(ipcRenderer, webUtils));
    tracePreload('electronAPI exposed to renderer');

    window.addEventListener('DOMContentLoaded', () => {
        tracePreload('DOMContentLoaded observed');
        installStartupOverlayLifecycle();
    }, { once: true });
}
