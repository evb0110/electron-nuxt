import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { ref } from 'vue';
import type { IElectronAPI } from '@contracts/electronApi';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/composables/tabsMenuBindings';
import { cast } from '@tests/helpers/cast';

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await delay(0);
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });

    return {
        promise,
        resolve,
    };
}

function createDeps(overrides: Partial<Parameters<typeof registerTabsMenuBindings>[1]> = {}) {
    return cast<Parameters<typeof registerTabsMenuBindings>[1]>({
        activeWorkspace: ref(null),
        activeTabId: ref(null),
        createTab: vi.fn(() => ({ id: 'tab-1' })),
        handleCloseTab: vi.fn(async (_tabId: string) => {}),
        handleFallbackToolbarOpenFile: vi.fn(async () => {}),
        openPathInAppropriateTab: vi.fn(async (_path: string) => {}),
        openPathsInAppropriateTab: vi.fn(async (_paths: string[]) => {}),
        clearRecentFiles: vi.fn(async () => {}),
        loadRecentFiles: vi.fn(async () => {}),
        openSettings: vi.fn(),
        checkForUpdates: vi.fn(async () => {}),
        splitEditor: vi.fn(async (_direction) => {}),
        focusGroup: vi.fn(),
        moveActiveTab: vi.fn(async (_direction) => {}),
        copyActiveTab: vi.fn(async (_direction) => {}),
        handleWindowTabsAction: vi.fn(async (_action) => {}),
        ...overrides,
    });
}

function createElectronApi() {
    let onMenuOpenPdf: (() => void) | null = null;
    let onMenuPrint: (() => void) | null = null;
    let onMenuPrintCurrentPage: (() => void) | null = null;
    let onMenuOpenExternalPaths: ((paths: string[]) => void) | null = null;
    let onMenuOpenRecentFile: ((path: string) => void) | null = null;

    const api = cast<IElectronAPI>({documents: {
        onMenuOpenPdf: vi.fn((callback: () => void) => {
            onMenuOpenPdf = callback;
            return () => {
                onMenuOpenPdf = null;
            };
        }),
        onMenuPrint: vi.fn((callback: () => void) => {
            onMenuPrint = callback;
            return () => {
                onMenuPrint = null;
            };
        }),
        onMenuPrintCurrentPage: vi.fn((callback: () => void) => {
            onMenuPrintCurrentPage = callback;
            return () => {
                onMenuPrintCurrentPage = null;
            };
        }),
        onMenuOpenExternalPaths: vi.fn((callback: (paths: string[]) => void) => {
            onMenuOpenExternalPaths = callback;
            return () => {
                onMenuOpenExternalPaths = null;
            };
        }),
        onMenuOpenRecentFile: vi.fn((callback: (path: string) => void) => {
            onMenuOpenRecentFile = callback;
            return () => {
                onMenuOpenRecentFile = null;
            };
        }),
    }});

    return {
        api,
        emitOpenPdf() {
            onMenuOpenPdf?.();
        },
        emitPrint() {
            onMenuPrint?.();
        },
        emitPrintCurrentPage() {
            onMenuPrintCurrentPage?.();
        },
        emitExternalPaths(paths: string[]) {
            onMenuOpenExternalPaths?.(paths);
        },
        emitRecentFile(path: string) {
            onMenuOpenRecentFile?.(path);
        },
    };
}

describe('registerTabsMenuBindings', () => {
    it('routes menu open-file through the placeholder-aware fallback handler', async () => {
        const handleFallbackToolbarOpenFile = vi.fn(async () => {});
        const deps = createDeps({ handleFallbackToolbarOpenFile });
        const electronApi = createElectronApi();

        registerTabsMenuBindings(electronApi.api, deps);
        electronApi.emitOpenPdf();
        await flushMicrotasks();

        expect(handleFallbackToolbarOpenFile).toHaveBeenCalledTimes(1);
    });

    it('routes the menu print command to the active workspace', async () => {
        const handlePrint = vi.fn(async () => {});
        const deps = createDeps({activeWorkspace: ref<IWorkspaceExpose | null>(cast<IWorkspaceExpose>({handlePrint}))});
        const electronApi = createElectronApi();

        registerTabsMenuBindings(electronApi.api, deps);
        electronApi.emitPrint();
        await flushMicrotasks();

        expect(handlePrint).toHaveBeenCalledTimes(1);
    });

    it('routes the menu print current page command to the active workspace', async () => {
        const handlePrintCurrentPage = vi.fn(async () => {});
        const deps = createDeps({activeWorkspace: ref<IWorkspaceExpose | null>(cast<IWorkspaceExpose>({handlePrintCurrentPage}))});
        const electronApi = createElectronApi();

        registerTabsMenuBindings(electronApi.api, deps);
        electronApi.emitPrintCurrentPage();
        await flushMicrotasks();

        expect(handlePrintCurrentPage).toHaveBeenCalledTimes(1);
    });

    it('serializes external open requests so later launches wait for the first one', async () => {
        const firstOpen = createDeferred();
        const secondOpen = createDeferred();
        const openPathsInAppropriateTab = vi
            .fn(async (_paths: string[]) => {})
            .mockImplementationOnce(async () => firstOpen.promise)
            .mockImplementationOnce(async () => secondOpen.promise);
        const deps = createDeps({ openPathsInAppropriateTab });
        const electronApi = createElectronApi();

        registerTabsMenuBindings(electronApi.api, deps);

        electronApi.emitExternalPaths(['/docs/first.pdf']);
        electronApi.emitExternalPaths(['/docs/second.pdf']);
        await flushMicrotasks();

        expect(openPathsInAppropriateTab).toHaveBeenCalledTimes(1);
        expect(openPathsInAppropriateTab).toHaveBeenNthCalledWith(1, ['/docs/first.pdf']);

        firstOpen.resolve();
        await flushMicrotasks();

        expect(openPathsInAppropriateTab).toHaveBeenCalledTimes(2);
        expect(openPathsInAppropriateTab).toHaveBeenNthCalledWith(2, ['/docs/second.pdf']);

        secondOpen.resolve();
        await flushMicrotasks();
    });

    it('keeps the queue flowing after a failed document-open request', async () => {
        const openPathInAppropriateTab = vi
            .fn(async (_path: string) => true)
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(true);
        const deps = createDeps({ openPathInAppropriateTab });
        const electronApi = createElectronApi();

        registerTabsMenuBindings(electronApi.api, deps);

        electronApi.emitRecentFile('/docs/first.pdf');
        await flushMicrotasks();
        electronApi.emitRecentFile('/docs/second.pdf');
        await flushMicrotasks();

        expect(openPathInAppropriateTab).toHaveBeenCalledTimes(2);
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(1, '/docs/first.pdf');
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(2, '/docs/second.pdf');
    });
});
