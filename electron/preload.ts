import {
    contextBridge,
    ipcRenderer,
    webUtils,
} from 'electron';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import { installViteOutdatedOptimizeDepRecovery } from '@electron/preload/installViteOutdatedOptimizeDepRecovery';
import { createElectronApi } from '@electron/preload/createElectronApi';
import { pushDebugLogMessage } from '@electron/preload/debugLogBuffer';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
} from '@electron/platform-ipc/coreContract';

const PRELOAD_INSTALL_FLAG = '__preloadInstalled';
const PRELOAD_DEBUG_LOG_LISTENER_FLAG = '__preloadDebugLogListenerInstalled';
const preloadScriptStartedAt = Date.now();
const STARTUP_OVERLAY_ID = 'evb-startup-overlay';
const STARTUP_OVERLAY_STYLE_ID = 'evb-startup-overlay-style';
const APP_READY_EVENT_NAME = 'evb:app-ready';
const STARTUP_OPEN_CLAIMED_EVENT_NAME = 'evb:startup-open-claimed';
const STARTUP_OPEN_VISUAL_READY_EVENT_NAME = 'evb:startup-open-visual-ready';
const DEV_STARTUP_OVERLAY_SHOWN_KEY = 'evb-viewer:dev:startup-overlay-shown';
const STARTUP_OVERLAY_SPINNER_SIZE_PX = 20;
const STARTUP_OVERLAY_GAP_PX = 10;
const STARTUP_OVERLAY_TEXT_FONT_SIZE_PX = 13;
const STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX = 13;
const DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS = 2200;
const STARTUP_OPEN_CLAIM_GRACE_MS = 300;
const STARTUP_OPEN_CLAIM_FALLBACK_MS = 5_000;
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
        ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, {
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
    width: 128px;
    height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX + STARTUP_OVERLAY_GAP_PX + STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
    min-height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX + STARTUP_OVERLAY_GAP_PX + STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
}
#${STARTUP_OVERLAY_ID} .evb-startup-overlay__spinner {
    width: ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    height: ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
    flex: 0 0 ${STARTUP_OVERLAY_SPINNER_SIZE_PX}px;
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
    font-weight: 400;
    height: ${STARTUP_OVERLAY_TEXT_LINE_HEIGHT_PX}px;
}
@keyframes evb-startup-overlay-spin {
    from { transform: translateZ(0) rotate(0deg); }
    to { transform: translateZ(0) rotate(360deg); }
}
`;
    const styleRoot = document.head ?? document.documentElement;
    styleRoot?.appendChild(style);
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
    const overlayRoot = document.body ?? document.documentElement;
    if (!overlayRoot) {
        return;
    }

    overlayRoot.appendChild(overlay);
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
    const MAX_WAIT_MS = 30_000;
    let waitingForStartupOpenVisual = false;
    let appReadySeen = false;
    let startupOpenClaimSeen = false;
    let overlayRemoved = false;
    let checkInterval: number | null = null;
    let appReadyRemovalTimer: number | null = null;
    let devRemovalTimer: number | null = null;
    let startupOpenClaimFallbackTimer: number | null = null;

    function clearAppReadyRemovalTimer() {
        if (appReadyRemovalTimer === null) {
            return;
        }

        window.clearTimeout(appReadyRemovalTimer);
        appReadyRemovalTimer = null;
    }

    function clearDevRemovalTimer() {
        if (devRemovalTimer === null) {
            return;
        }

        window.clearTimeout(devRemovalTimer);
        devRemovalTimer = null;
    }

    function clearStartupOpenClaimFallbackTimer() {
        if (startupOpenClaimFallbackTimer === null) {
            return;
        }

        window.clearTimeout(startupOpenClaimFallbackTimer);
        startupOpenClaimFallbackTimer = null;
    }

    function clearCheckInterval() {
        if (checkInterval === null) {
            return;
        }

        window.clearInterval(checkInterval);
        checkInterval = null;
    }

    function cleanupOverlayLifecycleListeners() {
        clearCheckInterval();
        clearAppReadyRemovalTimer();
        clearDevRemovalTimer();
        clearStartupOpenClaimFallbackTimer();
        window.removeEventListener(APP_READY_EVENT_NAME, handleAppReady);
        window.removeEventListener(STARTUP_OPEN_CLAIMED_EVENT_NAME, handleStartupOpenClaimed);
        window.removeEventListener(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, handleStartupOpenVisualReady);
    }

    function removeOverlay(reason: string) {
        if (overlayRemoved) {
            return;
        }

        overlayRemoved = true;
        cleanupOverlayLifecycleListeners();
        unmountStartupOverlay(reason);
    }

    function mountOverlayIfActive() {
        if (overlayRemoved) {
            return;
        }

        mountStartupOverlay();
    }

    function requestOverlayUnmount(reason: string) {
        if (!process.defaultApp) {
            removeOverlay(reason);
            return;
        }

        const removeWithDelay = () => {
            const elapsedMs = Date.now() - overlayLifecycleStartedAt;
            if (elapsedMs >= DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS) {
                removeOverlay(reason);
                return;
            }

            const delayMs = DEV_STARTUP_OVERLAY_APP_READY_DELAY_MS - elapsedMs;
            forwardPreloadLogToMain('info', 'loader', 'Startup overlay removal delayed for dev stabilization', {
                variant: 'startup-overlay',
                reason,
                delayMs,
                elapsedMs,
            });
            clearDevRemovalTimer();
            devRemovalTimer = window.setTimeout(() => {
                devRemovalTimer = null;
                removeOverlay(reason);
            }, delayMs);
        };

        removeWithDelay();
    }

    function scheduleStartupOpenClaimFallbackRemoval(reason: string) {
        if (startupOpenClaimFallbackTimer !== null || overlayRemoved) {
            return;
        }

        startupOpenClaimFallbackTimer = window.setTimeout(() => {
            startupOpenClaimFallbackTimer = null;
            if (startupOpenClaimSeen || waitingForStartupOpenVisual) {
                return;
            }

            forwardPreloadLogToMain('warn', 'loader', 'Startup overlay timed out waiting for startup open claim', {
                variant: 'startup-overlay',
                reason,
                timeoutMs: STARTUP_OPEN_CLAIM_FALLBACK_MS,
            });
            requestOverlayUnmount('startup-open-claim-timeout');
        }, STARTUP_OPEN_CLAIM_FALLBACK_MS);
    }

    function scheduleAppReadyRemoval(reason: string) {
        appReadySeen = true;
        clearCheckInterval();
        clearAppReadyRemovalTimer();

        appReadyRemovalTimer = window.setTimeout(() => {
            appReadyRemovalTimer = null;
            if (waitingForStartupOpenVisual) {
                forwardPreloadLogToMain('info', 'loader', 'Startup overlay retained for startup document visual readiness', {
                    variant: 'startup-overlay',
                    reason,
                });
                return;
            }

            if (!startupOpenClaimSeen) {
                forwardPreloadLogToMain('info', 'loader', 'Startup overlay retained until startup open claim is observed', {
                    variant: 'startup-overlay',
                    reason,
                });
                scheduleStartupOpenClaimFallbackRemoval(reason);
                return;
            }

            requestOverlayUnmount(reason);
        }, STARTUP_OPEN_CLAIM_GRACE_MS);
    }

    function getStartupOpenPathCount(event: Event) {
        if (!(event instanceof CustomEvent)) {
            return 0;
        }

        const detail = event.detail as { pathCount?: unknown } | null;
        const pathCount = typeof detail?.pathCount === 'number' ? detail.pathCount : 0;
        if (!Number.isFinite(pathCount) || pathCount <= 0) {
            return 0;
        }

        return Math.floor(pathCount);
    }

    function handleStartupOpenClaimed(event: Event) {
        startupOpenClaimSeen = true;
        clearStartupOpenClaimFallbackTimer();
        const pathCount = getStartupOpenPathCount(event);
        if (pathCount > 0) {
            waitingForStartupOpenVisual = true;
            clearAppReadyRemovalTimer();
            forwardPreloadLogToMain('info', 'loader', 'Startup external open claimed; retaining overlay until first document paint', {
                variant: 'startup-overlay',
                pathCount,
            });
            return;
        }

        waitingForStartupOpenVisual = false;
        if (appReadySeen || (window as Window & { __appReady?: boolean }).__appReady) {
            scheduleAppReadyRemoval('startup-open-claimed-empty');
        }
    }

    function handleStartupOpenVisualReady(event: Event) {
        waitingForStartupOpenVisual = false;
        const detail = event instanceof CustomEvent ? event.detail as Record<string, unknown> | null : null;
        forwardPreloadLogToMain('info', 'loader', 'Startup document visual readiness reached', {
            variant: 'startup-overlay',
            reason: typeof detail?.reason === 'string' ? detail.reason : 'startup-open-visual-ready',
            timedOut: detail?.timedOut === true,
        });
        requestOverlayUnmount('startup-open-visual-ready');
    }

    function handleAppReady() {
        scheduleAppReadyRemoval('app-ready-event');
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

    mountOverlayIfActive();

    const start = Date.now();
    checkInterval = window.setInterval(() => {
        const windowWithReady = window as Window & { __appReady?: boolean };
        if (windowWithReady.__appReady) {
            scheduleAppReadyRemoval('__appReady-interval');
            return;
        }

        if (Date.now() - start > MAX_WAIT_MS) {
            removeOverlay('timeout');
        }
    }, 50);

    window.addEventListener(APP_READY_EVENT_NAME, handleAppReady, { once: true });
    window.addEventListener(STARTUP_OPEN_CLAIMED_EVENT_NAME, handleStartupOpenClaimed, { once: true });
    window.addEventListener(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, handleStartupOpenVisualReady, { once: true });

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', () => {
            tracePreload('DOMContentLoaded observed');
            mountOverlayIfActive();
        }, { once: true });
    }
}

const preloadState = globalThis as Record<string, unknown>;

const preloadAlreadyInstalled = preloadState[PRELOAD_INSTALL_FLAG] === true;
if (preloadAlreadyInstalled) {
    console.debug('[Preload] Re-exposing bridge for duplicate installation (fast reload detected)');
} else {
    preloadState[PRELOAD_INSTALL_FLAG] = true;
}

tracePreload('preload installation started');
(window as Window & {[STARTUP_TRACE_ENABLED_KEY]?: boolean;})[STARTUP_TRACE_ENABLED_KEY] = STARTUP_TRACE_ENABLED;

if (preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] !== true) {
    preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] = true;
    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.debugLog, (_event, data: IDebugLogEntry) => {
        pushDebugLogMessage(data);
        console.log(`[${data.timestamp}] [${data.source}] ${data.message}`);
    });
}

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

    forwardPreloadLogToMain(level, 'devRecovery', message, data);
};

installViteOutdatedOptimizeDepRecovery({ log: logDevRecovery });
tracePreload('dev recovery hooks installed');

function isRendererAutomationFileOpenHelperEnabled() {
    return process.env.EVB_AUTOMATION_USER_DATA_DIR
        && process.env.EVB_AUTOMATION_SESSION_NAME
        && process.env.EVB_ENABLE_RENDERER_FILE_OPEN_HELPER === '1';
}

const electronApi = createElectronApi(ipcRenderer, webUtils);
contextBridge.exposeInMainWorld('electronAPI', electronApi);
tracePreload('electronAPI exposed to renderer');

if (isRendererAutomationFileOpenHelperEnabled()) {
    const invokeDocuments = createTypedIpcInvoker<IDocumentsInvokeMap>(ipcRenderer);
    contextBridge.exposeInMainWorld('__allowRendererFileOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        const automationFileOpenToken = globalThis.crypto.randomUUID();
        return invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            automationFileOpenToken,
        ).then(() => invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
            filePath: path,
            token: automationFileOpenToken,
        }));
    });
    tracePreload('automation file-open capability helper exposed');
}

installStartupOverlayLifecycle();
