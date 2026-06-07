import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    effectScope,
    ref,
} from 'vue';
import type { IRecentFile } from '@contracts/shared';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const cookieStore = new Map<string, ReturnType<typeof ref>>();
const stateStore = new Map<string, ReturnType<typeof ref>>();
const desktopRuntime = ref(true);
const electronBridgeReady = ref(true);
const routePath = ref('/electron');
const electronRecentFilesGet = vi.fn<() => Promise<IRecentFile[]>>();
const electronRecentFilesRemove = vi.fn<(path: string) => Promise<void>>();
const electronRecentFilesClear = vi.fn<() => Promise<void>>();
const electronOpenPdfDirect = vi.fn<(path: string) => Promise<void>>();
const browserRecentFilesGet = vi.fn<() => Promise<IRecentFile[]>>();

vi.mock('@app/utils/platform', () => ({
    isDesktopPlatformActive: (electronApiAvailable = electronBridgeReady.value) => electronApiAvailable,
    getPlatformAPI: () => electronBridgeReady.value
        ? {documents: {
            recentFiles: {
                get: electronRecentFilesGet,
                remove: electronRecentFilesRemove,
                clear: electronRecentFilesClear,
            },
            openPdfDirect: electronOpenPdfDirect,
        }}
        : {documents: {
            recentFiles: {
                get: browserRecentFilesGet,
                remove: vi.fn(),
                clear: vi.fn(),
            },
            openPdfDirect: vi.fn(),
        }},
    hasElectronAPI: () => electronBridgeReady.value,
    isElectronRoutePath: (path: string | null | undefined) => path === '/electron' || path?.startsWith('/electron/') === true,
    shouldPreferDesktopPlatform: (
        currentRoutePath: string | null | undefined,
        desktopRuntime = false,
        electronApiAvailable = electronBridgeReady.value,
    ) => electronApiAvailable || desktopRuntime || currentRoutePath === '/electron' || currentRoutePath?.startsWith('/electron/') === true,
    resolveInitialDesktopRuntime: (routePath: string | null | undefined, electronApiAvailable = electronBridgeReady.value) =>
        electronApiAvailable || routePath === '/electron' || routePath?.startsWith('/electron/') === true,
    waitForDesktopPlatformBridge: async ({
        shouldWait = true,
        retryDelayMs = 25,
        attempts = 20,
    }: {
        shouldWait?: boolean;
        retryDelayMs?: number;
        attempts?: number;
    } = {}) => {
        if (!shouldWait || electronBridgeReady.value) {
            return electronBridgeReady.value;
        }

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            await delay(retryDelayMs);

            if (electronBridgeReady.value) {
                return true;
            }
        }

        return electronBridgeReady.value;
    },
}));

function installRecentFilesStubs() {
    installNuxtStateTestStubs(cookieStore, stateStore);
    vi.stubGlobal('useRoute', () => ({path: routePath.value}));
    vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    vi.stubGlobal('onMounted', (_callback: () => void) => undefined);
}

describe('useRecentFiles', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        cookieStore.clear();
        stateStore.clear();
        desktopRuntime.value = true;
        electronBridgeReady.value = true;
        routePath.value = '/electron';
        electronRecentFilesGet.mockResolvedValue([]);
        electronRecentFilesRemove.mockResolvedValue();
        electronRecentFilesClear.mockResolvedValue();
        electronOpenPdfDirect.mockResolvedValue();
        browserRecentFilesGet.mockResolvedValue([]);
        installRecentFilesStubs();
    });

    it('keeps desktop recent files unresolved until Electron results load', async () => {
        cookieStore.set('evb_viewer_recent_files', ref(encodeURIComponent('[]')));
        electronRecentFilesGet.mockResolvedValue([{
            originalPath: '/tmp/example.pdf',
            fileName: 'example.pdf',
            timestamp: 1,
            fileSize: 42,
        }]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            recentFiles,
            isResolved,
            loadRecentFiles,
        } = useRecentFiles();

        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([]);

        await loadRecentFiles();

        expect(isResolved.value).toBe(true);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/example.pdf'})]);
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
    });

    it('waits for the Electron bridge instead of falling back to browser recent files', async () => {
        electronBridgeReady.value = false;
        electronRecentFilesGet.mockResolvedValue([{
            originalPath: '/tmp/delayed.pdf',
            fileName: 'delayed.pdf',
            timestamp: 2,
            fileSize: 84,
        }]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            loadRecentFiles,
            recentFiles,
        } = useRecentFiles();

        setTimeout(() => {
            electronBridgeReady.value = true;
        }, 10);

        await loadRecentFiles();

        expect(browserRecentFilesGet).not.toHaveBeenCalled();
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/delayed.pdf'})]);
    });

    it('still prefers Electron recent files on the electron route before desktop state settles', async () => {
        desktopRuntime.value = false;
        electronBridgeReady.value = false;
        routePath.value = '/electron';
        electronRecentFilesGet.mockResolvedValue([{
            originalPath: '/tmp/route-electron.pdf',
            fileName: 'route-electron.pdf',
            timestamp: 3,
            fileSize: 126,
        }]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            loadRecentFiles,
            recentFiles,
        } = useRecentFiles();

        setTimeout(() => {
            electronBridgeReady.value = true;
        }, 10);

        await loadRecentFiles();

        expect(browserRecentFilesGet).not.toHaveBeenCalled();
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/route-electron.pdf'})]);
    });

    it('keeps Electron recent files unresolved and retries after a startup failure', async () => {
        vi.useFakeTimers();
        electronRecentFilesGet
            .mockRejectedValueOnce(new Error('temporary startup failure'))
            .mockResolvedValueOnce([{
                originalPath: '/tmp/retried.pdf',
                fileName: 'retried.pdf',
                timestamp: 4,
                fileSize: 168,
            }]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            isResolved,
            recentFiles,
            loadRecentFiles,
        } = useRecentFiles();

        await loadRecentFiles();

        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([]);
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(750);

        expect(isResolved.value).toBe(true);
        expect(electronRecentFilesGet).toHaveBeenCalledTimes(2);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/retried.pdf'})]);
    });

    it('cancels scheduled Electron recent file retries when the composable scope is disposed', async () => {
        vi.useFakeTimers();
        electronRecentFilesGet
            .mockRejectedValueOnce(new Error('temporary startup failure'))
            .mockResolvedValueOnce([{
                originalPath: '/tmp/should-not-load.pdf',
                fileName: 'should-not-load.pdf',
                timestamp: 5,
                fileSize: 210,
            }]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const scope = effectScope();
        const recentFilesState = scope.run(() => useRecentFiles());
        if (!recentFilesState) {
            throw new Error('Failed to create recent files composable');
        }

        await recentFilesState.loadRecentFiles();
        scope.stop();

        await vi.advanceTimersByTimeAsync(750);

        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
        expect(recentFilesState.isResolved.value).toBe(false);
        expect(recentFilesState.recentFiles.value).toEqual([]);
    });

    it('keeps browser recent files unresolved when the cookie snapshot is truncated', async () => {
        desktopRuntime.value = false;
        electronBridgeReady.value = false;
        routePath.value = '/';
        cookieStore.set('evb_viewer_recent_files', ref(JSON.stringify({
            v: 1,
            t: true,
            f: [[
                '/tmp/preview.pdf',
                'preview.pdf',
                1,
                10,
            ]],
        })));
        browserRecentFilesGet.mockResolvedValue([{
            originalPath: '/tmp/full.pdf',
            fileName: 'full.pdf',
            timestamp: 10,
            fileSize: 10,
        }]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            isResolved,
            loadRecentFiles,
            recentFiles,
        } = useRecentFiles();

        expect(isResolved.value).toBe(false);
        expect(recentFiles.value.length).toBeGreaterThan(0);

        await loadRecentFiles();

        expect(browserRecentFilesGet).toHaveBeenCalledOnce();
        expect(isResolved.value).toBe(true);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/full.pdf'})]);
    });

    it('marks a complete browser cookie snapshot as usable for startup paint', async () => {
        desktopRuntime.value = false;
        electronBridgeReady.value = false;
        routePath.value = '/';
        cookieStore.set('evb_viewer_recent_files', ref(JSON.stringify({
            v: 1,
            t: false,
            f: [[
                '/tmp/cookie.pdf',
                'cookie.pdf',
                11,
                12,
            ]],
        })));

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            hasUsableInitialSnapshot,
            isResolved,
            recentFiles,
        } = useRecentFiles();

        expect(hasUsableInitialSnapshot.value).toBe(true);
        expect(isResolved.value).toBe(true);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/cookie.pdf'})]);
    });

    it('does not treat cookie snapshots as startup-usable for Electron runtime', async () => {
        cookieStore.set('evb_viewer_recent_files', ref(JSON.stringify({
            v: 1,
            t: false,
            f: [[
                '/tmp/electron-cookie.pdf',
                'electron-cookie.pdf',
                13,
                14,
            ]],
        })));

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            hasUsableInitialSnapshot,
            isResolved,
            recentFiles,
        } = useRecentFiles();

        expect(hasUsableInitialSnapshot.value).toBe(false);
        expect(isResolved.value).toBe(false);
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/electron-cookie.pdf'})]);
    });
});
