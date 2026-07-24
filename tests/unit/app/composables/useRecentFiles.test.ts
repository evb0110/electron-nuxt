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
import { BROWSER_PLATFORM_MANIFEST } from '@contracts/platformApi';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createPlatformApiFixture } from '@tests/helpers/createPlatformApiFixture';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const cookieStore = new Map<string, ReturnType<typeof ref>>();
const stateStore = new Map<string, ReturnType<typeof ref>>();
const desktopRuntime = ref(true);
const electronBridgeReady = ref(true);
const routePath = ref('/electron');
const electronRecentFilesGet = vi.fn<() => Promise<IRecentFile[]>>();
const electronRecentFilesRemove = vi.fn<(path: string) => Promise<void>>();
const electronRecentFilesClear = vi.fn<() => Promise<void>>();
const electronOpenDocumentDirect = vi.fn<(path: string) => Promise<TOpenFileResult | null>>();
const browserRecentFilesGet = vi.fn<() => Promise<IRecentFile[]>>();
const electronRecentFiles = {
    get: electronRecentFilesGet,
    remove: electronRecentFilesRemove,
    clear: electronRecentFilesClear,
};
const electronPlatformApi = createElectronPlatformApiFixture({
    documentOpen: {openDocumentDirect: electronOpenDocumentDirect},
    documentRecentFiles: {recentFiles: electronRecentFiles},
});
const browserPlatformApi = createPlatformApiFixture({
    backend: 'browser',
    manifest: BROWSER_PLATFORM_MANIFEST,
    overrides: {documentRecentFiles: {recentFiles: {get: browserRecentFilesGet}}},
});

vi.mock('@app/utils/platform', () => ({
    isDesktopPlatformActive: (electronApiAvailable = electronBridgeReady.value) => electronApiAvailable,
    getPlatformAPI: () => electronBridgeReady.value
        ? electronPlatformApi
        : browserPlatformApi,
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

function recentFile(path: string, timestamp = 1): IRecentFile {
    const fileName = path.split('/').at(-1) ?? path;

    return {
        originalPath: path,
        fileName,
        timestamp,
        fileSize: timestamp * 42,
    };
}

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
        electronOpenDocumentDirect.mockResolvedValue(null);
        browserRecentFilesGet.mockResolvedValue([]);
        installRecentFilesStubs();
    });

    it('keeps desktop recent files unresolved until Electron results load', async () => {
        cookieStore.set('evb_viewer_recent_files', ref(encodeURIComponent('[]')));
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/example.pdf')]);

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
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/delayed.pdf', 2)]);

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
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/route-electron.pdf', 3)]);

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

    it('removes recent files through the split recent-files capability', async () => {
        const file = recentFile('/tmp/remove-me.pdf');
        electronRecentFilesGet.mockResolvedValue([recentFile('/tmp/remaining.pdf', 2)]);

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            recentFiles,
            removeRecentFile,
        } = useRecentFiles();

        await removeRecentFile(file);

        expect(electronRecentFilesRemove).toHaveBeenCalledWith('/tmp/remove-me.pdf');
        expect(electronRecentFilesGet).toHaveBeenCalledOnce();
        expect(recentFiles.value).toEqual([expect.objectContaining({originalPath: '/tmp/remaining.pdf'})]);
    });

    it('clears recent files through the split recent-files capability', async () => {
        cookieStore.set('evb_viewer_recent_files', ref(JSON.stringify({
            v: 1,
            t: false,
            f: [[
                '/tmp/clear-me.pdf',
                'clear-me.pdf',
                1,
                10,
            ]],
        })));

        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const {
            clearRecentFiles,
            isResolved,
            recentFiles,
        } = useRecentFiles();

        await clearRecentFiles();

        expect(electronRecentFilesClear).toHaveBeenCalledOnce();
        expect(recentFiles.value).toEqual([]);
        expect(isResolved.value).toBe(true);
    });

    it('opens recent files through the split open capability', async () => {
        const { useRecentFiles } = await import('@app/composables/useRecentFiles');
        const { openRecentFile } = useRecentFiles();

        await openRecentFile(recentFile('/tmp/open-me.pdf'));

        expect(electronOpenDocumentDirect).toHaveBeenCalledWith('/tmp/open-me.pdf');
        expect(electronRecentFilesGet).not.toHaveBeenCalled();
    });

    it('keeps Electron recent files unresolved and retries after a startup failure', async () => {
        vi.useFakeTimers();
        electronRecentFilesGet
            .mockRejectedValueOnce(new Error('temporary startup failure'))
            .mockResolvedValueOnce([recentFile('/tmp/retried.pdf', 4)]);

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
            .mockResolvedValueOnce([recentFile('/tmp/should-not-load.pdf', 5)]);

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
        browserRecentFilesGet.mockResolvedValue([recentFile('/tmp/full.pdf', 10)]);

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
