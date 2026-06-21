import { EventEmitter } from 'events';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runInitSequence } from '@electron/bootstrap/runInitSequence';

vi.mock('@electron/config', () => ({config: {
    automation: { noFocus: false },
    isMac: false,
}}));

interface IRegisteredExternalOpenIpcHandlers {
    claimPendingExternalOpenPaths?: (event: { sender: object; }) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (event: { sender: object; }, failedPaths: string[]) => void;
}

describe('runInitSequence external open IPC', () => {
    async function createHarness() {
        const app = new EventEmitter() as EventEmitter & {
            dock?: { hide: () => void; };
            hide: () => void;
            isPackaged: boolean;
            getVersion: () => string;
            quit: () => void;
            requestSingleInstanceLock: () => boolean;
            setAboutPanelOptions: (options: unknown) => void;
            whenReady: () => Promise<void>;
        };
        app.isPackaged = true;
        app.getVersion = vi.fn(() => '1.0.0');
        app.hide = vi.fn();
        app.quit = vi.fn();
        app.requestSingleInstanceLock = vi.fn(() => true);
        app.setAboutPanelOptions = vi.fn();
        app.whenReady = vi.fn(async () => {});

        const mainWebContents = {};
        const otherWebContents = {};
        const mainWindow = Object.assign(new EventEmitter(), {
            id: 1,
            webContents: Object.assign(new EventEmitter(), mainWebContents),
        });
        const otherWindow = Object.assign(new EventEmitter(), {
            id: 2,
            webContents: Object.assign(new EventEmitter(), otherWebContents),
        });
        const capturedHandlers: IRegisteredExternalOpenIpcHandlers = {};
        const externalOpenManager = {
            queueOpenRequestFromArgs: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
            scheduleFlushPendingFiles: vi.fn(),
            claimPendingOpenPaths: vi.fn(async () => ['/docs/startup.pdf']),
            acknowledgeClaimedOpenPaths: vi.fn(),
            markBootstrapReady: vi.fn(),
        };
        const allowOpenPaths = vi.fn();

        await runInitSequence({
            app: app as never,
            aboutIconPath: '/app/icon.png',
            allowMultipleAutomationSessions: false,
            allowOpenPaths,
            attachHostEnvironmentToWindow: vi.fn(),
            broadcastUpdateStatus: vi.fn(),
            cleanupStaleWorkingCopyDirectories: vi.fn(async () => ({
                removedDirectories: 0,
                removedOcrDirectories: 0,
            })),
            createWindow: vi.fn(async () => mainWindow as never),
            devDockBadgeText: '',
            devDockIconPath: '',
            externalOpenManager,
            focusMainWindow: vi.fn(),
            getMainWindow: vi.fn(() => mainWindow as never),
            getWindowFromWebContents: vi.fn((webContents: object) => {
                if (webContents === mainWindow.webContents) {
                    return mainWindow as never;
                }
                if (webContents === otherWindow.webContents) {
                    return otherWindow as never;
                }
                return null;
            }),
            hasWindows: vi.fn(() => true),
            initRecentFilesCache: vi.fn(async () => {}),
            initializeUpdates: vi.fn(),
            installHostEnvironmentDisplayWatcher: vi.fn(),
            logger: {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
            },
            logStartupPhase: vi.fn(),
            markWindowRendererReady: vi.fn(),
            markWindowTabTransferReady: vi.fn(),
            markWindowTabTransferWindowClosed: vi.fn(),
            maybePromptForDefaultViewer: vi.fn(),
            readyWindowIds: new Set<number>(),
            registerIpcHandlers: vi.fn((handlers: IRegisteredExternalOpenIpcHandlers) => {
                Object.assign(capturedHandlers, handlers);
            }),
            setupAppProtocolHandler: vi.fn(),
            setupMenu: vi.fn(),
            shouldResetRendererReadyOnNavigation: vi.fn(() => true),
            shutdownCoordinator: null,
            sweepStaleDefaultAppTempPdfs: vi.fn(async () => {}),
        });

        return {
            allowOpenPaths,
            capturedHandlers,
            externalOpenManager,
            mainWindow,
            otherWindow,
        };
    }

    it('acknowledges failed startup opens only from the claiming WebContents and claimed paths', async () => {
        const harness = await createHarness();

        await expect(harness.capturedHandlers.claimPendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
        )).resolves.toEqual(['/docs/startup.pdf']);

        expect(harness.allowOpenPaths).toHaveBeenCalledWith(
            ['/docs/startup.pdf'],
            harness.mainWindow.webContents,
        );

        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            {sender: harness.otherWindow.webContents},
            ['/docs/startup.pdf'],
        );
        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
            ['/docs/other.pdf'],
        );

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).not.toHaveBeenCalled();

        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
            ['/docs/startup.pdf'],
        );

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });
});
