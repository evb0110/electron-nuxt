import {
    app,
    BrowserWindow,
} from 'electron';
import type { IAppUpdateStatus } from '@contracts/electronApiUpdates';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    createExternalOpenManager,
    createMacOpenFileRouter,
} from '@electron/bootstrap/externalOpen';
import { runInitSequence } from '@electron/bootstrap/runInitSequence';
import {
    resolveExternalOpenDispatchWindow,
    shouldResetRendererReadyOnNavigation,
} from '@electron/bootstrap/rendererReady';
import {
    createShutdownCoordinator,
    runShutdownSteps,
} from '@electron/bootstrap/shutdown';
import { requestShutdownSaveFlush } from '@electron/bootstrap/requestShutdownSaveFlush';
import { createStartupTrace } from '@electron/bootstrap/createStartupTrace';
import { config } from '@electron/config';
import { registerIpcHandlers } from '@electron/platform-ipc/registerIpcHandlers';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';
import {
    clearAllWorkingCopies,
    cleanupStaleWorkingCopyDirectories,
} from '@electron/file-access/workingCopyCleanup';
import { allowOpenPaths } from '@electron/file-access/openPathCapabilities';
import {
    attachHostEnvironmentToWindow,
    installHostEnvironmentDisplayWatcher,
} from '@electron/hostEnvironment';
import {
    sendToWindow,
    setupMenu,
} from '@electron/menu';
import { initRecentFilesCache } from '@electron/recentFiles';
import {
    performDjvuViewingShutdownCleanup,
    shutdownDjvuConversions,
    pruneStaleDjvuArtifactJobs,
} from '@electron/features/djvu/public';
import { shutdownLocalMcpServer } from '@electron/features/agent/mcpServer';
import { syncAgentMcpServerWithSettings } from '@electron/features/agent/codexMcpIntegration';
import { shutdownAgentAssistant } from '@electron/features/agent/codexAssistant';
import {
    recoverOcrJobManager,
    shutdownOcrJobManager,
} from '@electron/ocr/jobManager';
import {searchWorkerService} from '@electron/features/search/public';
import {
    createWindow,
    hasWindows,
} from '@electron/window';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
} from '@electron/window/registry';
import { markWindowRendererReady } from '@electron/window/rendererReady';
import { focusWindowForUser } from '@electron/window/focusWindowForUser';
import {
    markWindowTabTransferNotReady,
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
} from '@electron/windowTabTransfer';
import { promptSetDefaultViewer } from '@electron/promptSetDefaultViewer';
import { createLogger } from '@electron/utils/createLogger';
import {
    closeCachedRangeReadHandles,
    sweepStaleDefaultAppTempPdfs,
    sweepStaleOcrTempArtifacts,
    shutdownSerializedPdfPersistence,
} from '@electron/features/documents/public';
import {
    configureUpdateInstallShutdown,
    initializeUpdates,
    shutdownUpdates,
} from '@electron/updates';
import { getErrorMessage } from '@electron/utils/error';
import {
    registerAppProtocolScheme,
    setupAppProtocolHandler,
} from '@electron/protocol';
import { resetSettingsCacheAfterUserDataPathChange } from '@electron/settings';
import { configureMacKeychainAccess } from '@electron/security/macKeychainAccess';
import {
    beginMainOperationShutdown,
    cancelAllMainOperations,
    drainCriticalMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import { sweepStaleManagedScratchTempDirs } from '@electron/utils/managedScratchTemp';
import {
    configureProcessSafeMode,
    createProcessDeathRecovery,
} from '@electron/processDeathRecovery';
import { markPendingUpdateHealthy } from '@electron/updateHealthMarker';
import { runDetached } from '@electron/utils/runDetached';
import { resolveApplicationVersion } from '@electron/appVersion';
import { createUnhandledRejectionRecovery } from '@electron/unhandledRejectionRecovery';
import { clearWorkspaceCheckpoint } from '@electron/workspaceCheckpointStore';

app.setName(app.isPackaged ? 'EVB Viewer' : 'EVB Viewer Dev');
configureProcessSafeMode(app, process.argv);
configureMacKeychainAccess(app);
registerAppProtocolScheme();
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
const automationUserDataDir = process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim();
if (automationUserDataDir) {
    app.setPath('userData', automationUserDataDir);
} else {
    app.setPath('userData', join(app.getPath('appData'), app.name));
}
resetSettingsCacheAfterUserDataPathChange();

const logger = createLogger('main');
const processDeathRecovery = createProcessDeathRecovery({
    app,
    argv: process.argv,
    logger,
});
app.on('child-process-gone', (_event, details) => {
    processDeathRecovery.handleChildProcessGone(details);
});
const macOpenFileRouter = createMacOpenFileRouter({ logger });
// Keep fatal shutdown opt-in for unhandled rejections: many promise failures are
// feature-local and should not crash the entire public app.
const FATAL_UNHANDLED_REJECTION_ENABLED = process.env.EVB_MAIN_FATAL_UNHANDLED_REJECTION === '1';
const startupTrace = createStartupTrace(logger);
let shutdownCoordinator: ReturnType<typeof createShutdownCoordinator> | null = null;

function requestFatalShutdown(reason: string) {
    if (!shutdownCoordinator) {
        logger.error(reason);
        app.exit(1);
        return;
    }
    shutdownCoordinator.requestFatalShutdown(reason);
}

// macOS can deliver open-file during very early cold-start launch, before the
// rest of the external-open pipeline is initialized.
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    macOpenFileRouter.handleOpenFile(filePath);
});

function isIgnorableUnhandledRejection(reason: unknown) {
    if (!(reason instanceof Error)) {
        return false;
    }
    if (reason.name === 'AbortError') {
        return true;
    }

    const normalizedMessage = reason.message.toLowerCase();
    if (normalizedMessage.includes('aborted')) {
        return true;
    }
    if (normalizedMessage.includes('cancelled') || normalizedMessage.includes('canceled')) {
        return true;
    }
    return false;
}

const recoverUnhandledRejectionSubsystem = createUnhandledRejectionRecovery({async recover(subsystem) {
    logger.error(`Restarting ${subsystem} subsystem after repeated unhandled promise rejections`);
    if (subsystem === 'ocr') {
        await recoverOcrJobManager();
    } else if (subsystem === 'search') {
        searchWorkerService.cleanupAll('unhandled rejection threshold');
    } else if (subsystem === 'agent') {
        await shutdownAgentAssistant();
    } else if (subsystem === 'djvu') {
        await shutdownDjvuConversions();
        performDjvuViewingShutdownCleanup();
    } else if (subsystem === 'documents') {
        await closeCachedRangeReadHandles();
    }
}});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection in main process: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    if (isIgnorableUnhandledRejection(reason)) {
        return;
    }
    if (FATAL_UNHANDLED_REJECTION_ENABLED) {
        requestFatalShutdown('Unhandled promise rejection requires fatal shutdown');
        return;
    }
    runDetached(
        () => recoverUnhandledRejectionSubsystem(reason),
        {
            label: 'recover subsystem after unhandled rejection threshold',
            logger,
        },
    );
});
process.on('uncaughtException', (error) => {
    requestFatalShutdown(`Uncaught exception in main process: ${error.stack ?? error.message}`);
});

if (process.platform === 'darwin' && config.automation.noFocus) {
    try {
        // Keep automation sessions from becoming the active foreground app on macOS.
        app.setActivationPolicy('accessory');
    } catch (error) {
        logger.warn(
            `Failed to switch activation policy for automation mode: ${
                getErrorMessage(error)
            }`,
        );
    }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');
const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : devDockIconPath;
const DEV_DOCK_BADGE_TEXT = 'DEV';

const readyWindowIds = new Set<number>();
let defaultViewerPromptShown = false;
let defaultViewerPromptTimer: NodeJS.Timeout | null = null;

function isMainWindowRendererReady() {
    const mainWindow = getRegisteredMainWindow();
    if (!mainWindow) {
        return false;
    }

    return readyWindowIds.has(mainWindow.id);
}

function focusMainWindow() {
    const window = getRegisteredMainWindow();
    if (!window) {
        return;
    }

    focusWindowForUser(window, {
        application: app,
        noFocus: config.automation.noFocus,
    });
}
const externalOpenManager = createExternalOpenManager({
    application: app,
    logger,
    noFocus: config.automation.noFocus,
    logStartupPhase: startupTrace.log,
    isMainWindowRendererReady,
    getMainWindow: getRegisteredMainWindow,
    hasWindows,
    createWindow: async () => {
        readyWindowIds.clear();
        await createWindow();
    },
    dispatchOpenPaths: (paths) => {
        const window = resolveExternalOpenDispatchWindow({
            mainWindow: getRegisteredMainWindow(),
            focusedWindow: BrowserWindow.getFocusedWindow(),
        });
        if (!window) {
            return false;
        }

        allowOpenPaths(paths, window.webContents);
        return sendToWindow(window, 'menu:openExternalPaths', paths);
    },
});
macOpenFileRouter.attachExternalOpenManager(externalOpenManager);

const MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS = 30_000;
const RENDERER_SAVE_FLUSH_TIMEOUT_MS = 2_500;

function maybePromptForDefaultViewer() {
    if (config.automation.noFocus) {
        return;
    }

    if (defaultViewerPromptShown) {
        return;
    }
    const window = getRegisteredMainWindow();
    if (!window) {
        return;
    }
    defaultViewerPromptShown = true;
    defaultViewerPromptTimer = setTimeout(() => {
        defaultViewerPromptTimer = null;
        if (window.isDestroyed()) {
            return;
        }
        void promptSetDefaultViewer(window);
    }, 1_500);
}

async function performShutdownCleanup() {
    if (defaultViewerPromptTimer) {
        clearTimeout(defaultViewerPromptTimer);
        defaultViewerPromptTimer = null;
    }
    externalOpenManager.clearTimers();
    shutdownCoordinator?.clearGracefulQuitForceTimer();
    const workingCopyCleanupSkipPaths = new Set<string>();

    await runShutdownSteps(logger, [
        {
            label: 'renderer-save-flush',
            timeoutMs: RENDERER_SAVE_FLUSH_TIMEOUT_MS + 500,
            run: async () => {
                const result = await requestShutdownSaveFlush({
                    getWindows: getAllRegisteredAppWindows,
                    logger,
                    timeoutMs: RENDERER_SAVE_FLUSH_TIMEOUT_MS,
                });
                for (const workingCopyPath of result.dirtyWorkingCopyPaths) {
                    workingCopyCleanupSkipPaths.add(workingCopyPath);
                    logger.error(`Renderer reported dirty working copy during shutdown; skipping deletion: ${workingCopyPath}`);
                }
                if (result.flushedWorkingCopyPaths.length > 0) {
                    logger.info(`Renderer flushed ${result.flushedWorkingCopyPaths.length} working copy path(s) before shutdown`);
                }
            },
        },
        {
            label: 'main-operation-shutdown',
            run: () => {
                beginMainOperationShutdown('Main process is shutting down');
            },
        },
        {
            label: 'agent-assistant',
            run: () => shutdownAgentAssistant(),
        },
        {
            label: 'mcp-server',
            run: () => shutdownLocalMcpServer(),
        },
        {
            label: 'updates',
            run: () => shutdownUpdates(),
        },
        {
            label: 'main-operations-cancel',
            run: () => {
                cancelAllMainOperations('app shutdown');
            },
        },
        {
            label: 'serialized-pdf-persistence',
            run: () => shutdownSerializedPdfPersistence(),
        },
        {
            label: 'main-critical-writes',
            timeoutMs: MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS,
            run: async () => {
                const result = await drainCriticalMainOperations({timeoutMs: MAIN_OPERATION_CRITICAL_DRAIN_TIMEOUT_MS});
                if (!result.completed) {
                    logger.error(`Timed out waiting for ${result.pending.length} critical main operation(s) during shutdown`);
                    for (const operation of result.pending) {
                        if (operation.workingCopyPath) {
                            workingCopyCleanupSkipPaths.add(operation.workingCopyPath);
                            logger.error(
                                `Skipping working-copy deletion for pending critical write path: ${operation.workingCopyPath}`,
                            );
                        } else {
                            logger.error(`Pending critical write has no working-copy path; operation=${operation.id}`);
                        }
                    }
                }
            },
        },
        {
            label: 'djvu-conversions',
            run: () => shutdownDjvuConversions(),
        },
        {
            label: 'djvu-viewing',
            run: () => performDjvuViewingShutdownCleanup(),
        },
        {
            label: 'ocr-job-manager',
            run: () => shutdownOcrJobManager(),
        },
        {
            label: 'range-read-handles',
            run: () => closeCachedRangeReadHandles(),
        },
        {
            label: 'workspace-checkpoint',
            run: () => shutdownCoordinator?.isFatalShutdownInProgress()
                ? undefined
                : clearWorkspaceCheckpoint(),
        },
        {
            label: 'working-copies',
            run: () => shutdownCoordinator?.isFatalShutdownInProgress()
                ? undefined
                : clearAllWorkingCopies({skipPaths: workingCopyCleanupSkipPaths}),
        },
    ]);
}

shutdownCoordinator = createShutdownCoordinator({
    app,
    logger,
    runCleanupSteps: performShutdownCleanup,
});
configureUpdateInstallShutdown((install) => {
    shutdownCoordinator?.requestGracefulQuit({ afterCleanup: install });
});

function broadcastUpdateStatus(status: IAppUpdateStatus) {
    for (const window of getAllRegisteredAppWindows()) {
        sendToWindow(window, CORE_IPC_EVENT_CHANNELS.updatesStatus, status);
    }
}

const allowMultipleAutomationSessions = process.env.EVB_ALLOW_MULTI_AUTOMATION_SESSIONS === '1';

void runInitSequence({
    app,
    aboutIconPath,
    allowMultipleAutomationSessions,
    allowOpenPaths,
    attachHostEnvironmentToWindow,
    broadcastUpdateStatus,
    cleanupStaleWorkingCopyDirectories,
    createWindow,
    devDockBadgeText: DEV_DOCK_BADGE_TEXT,
    devDockIconPath,
    externalOpenManager,
    focusMainWindow,
    getMainWindow: getRegisteredMainWindow,
    getWindowFromWebContents: BrowserWindow.fromWebContents,
    hasWindows,
    initRecentFilesCache,
    initializeUpdates,
    installHostEnvironmentDisplayWatcher,
    logger,
    logStartupPhase: startupTrace.log,
    markWindowRendererReady: (windowId) => {
        markWindowRendererReady(windowId);
        if (windowId !== getRegisteredMainWindow()?.id) {
            return;
        }
        runDetached(
            () => markPendingUpdateHealthy(resolveApplicationVersion(app)),
            {
                label: 'mark current update healthy',
                logger,
            },
        );
    },
    markWindowTabTransferNotReady,
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
    maybePromptForDefaultViewer,
    readyWindowIds,
    registerIpcHandlers,
    setupAppProtocolHandler,
    setupMenu,
    shouldResetRendererReadyOnNavigation,
    shutdownCoordinator,
    sweepStaleDefaultAppTempPdfs,
    sweepStaleManagedScratchTempDirs,
    sweepStaleOcrTempArtifacts,
    pruneStaleDjvuArtifactJobs,
})
    .then(() => syncAgentMcpServerWithSettings())
    .catch((error) => {
        requestFatalShutdown(`Application bootstrap failed: ${getErrorMessage(error)}`);
    });
