import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    browserLoggerError: vi.fn(),
    browserPlatformImportCount: 0,
    onMenuSave: vi.fn(() => () => {}),
    onStatus: vi.fn(),
    openDocumentDirect: vi.fn(async (path: string) => ({
        kind: 'pdf',
        originalPath: path,
        workingPath: `${path}#working`,
    })),
    readTextFile: vi.fn(async (path: string) => `read ${path}`),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: mocks.browserLoggerError,
}}));

vi.mock('@app/platform/browserPlatformApi', () => {
    mocks.browserPlatformImportCount += 1;
    return {browserPlatformApi: {
        documentFiles: {readTextFile: mocks.readTextFile},
        documentMenu: {onMenuSave: mocks.onMenuSave},
        documentOpen: {openDocumentDirect: mocks.openDocumentDirect},
        updates: {onStatus: mocks.onStatus},
    }};
});

describe('lazyBrowserPlatformApi', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.browserPlatformImportCount = 0;
    });

    it('does not load the browser platform module until a forwarded lazy method is used', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        expect(mocks.browserPlatformImportCount).toBe(0);

        const unsubscribe = lazyBrowserPlatformApi.updates.onStatus(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserPlatformImportCount).toBe(1);
        });
        unsubscribe();
    });

    it('keeps direct browser-only members synchronous without loading the browser platform module', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const firstFile = new File([new Uint8Array([1])], 'first.pdf', { type: 'application/pdf' });
        const secondFile = new File([new Uint8Array([2])], 'second.pdf', { type: 'application/pdf' });
        const firstRef = lazyBrowserPlatformApi.documentPicker?.getPathForFile(firstFile);
        const refs = lazyBrowserPlatformApi.documentPicker?.getPathsForFiles([
            firstFile,
            secondFile,
        ]);

        expect(firstRef).toMatch(/^browser:\/\/documents\//u);
        expect(refs?.[0]).toBe(firstRef);
        expect(refs?.[1]).toMatch(/^browser:\/\/documents\//u);
        expect(lazyBrowserPlatformApi.documentPicker?.getPathForFile).toBe(lazyBrowserPlatformApi.documents.getPathForFile);
        expect(lazyBrowserPlatformApi.documentPicker?.getPathsForFiles).toBe(lazyBrowserPlatformApi.documents.getPathsForFiles);
        expect(lazyBrowserPlatformApi.system.getMemoryInfo()).toBeNull();
        expect(mocks.browserPlatformImportCount).toBe(0);
    });

    it('forwards split document methods through the split browser platform fields lazily', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        expect(mocks.openDocumentDirect).not.toHaveBeenCalled();
        expect(mocks.readTextFile).not.toHaveBeenCalled();
        expect(lazyBrowserPlatformApi.documents.openDocumentDirect).toBe(
            lazyBrowserPlatformApi.documentOpen?.openDocumentDirect,
        );
        expect(lazyBrowserPlatformApi.documents.readTextFile).toBe(
            lazyBrowserPlatformApi.documentFiles?.readTextFile,
        );
        expect(lazyBrowserPlatformApi.documents.onMenuSave).toBe(
            lazyBrowserPlatformApi.documentMenu?.onMenuSave,
        );

        await expect(lazyBrowserPlatformApi.documentOpen?.openDocumentDirect('browser://documents/source.pdf'))
            .resolves.toEqual({
                kind: 'pdf',
                originalPath: 'browser://documents/source.pdf',
                workingPath: 'browser://documents/source.pdf#working',
            });
        await expect(lazyBrowserPlatformApi.documentFiles?.readTextFile('browser://documents/source.txt'))
            .resolves.toBe('read browser://documents/source.txt');
        await expect(lazyBrowserPlatformApi.documents.openDocumentDirect('browser://documents/legacy.pdf'))
            .resolves.toEqual({
                kind: 'pdf',
                originalPath: 'browser://documents/legacy.pdf',
                workingPath: 'browser://documents/legacy.pdf#working',
            });
        await expect(lazyBrowserPlatformApi.documents.readTextFile('browser://documents/legacy.txt'))
            .resolves.toBe('read browser://documents/legacy.txt');
        const unsubscribe = lazyBrowserPlatformApi.documents.onMenuSave(vi.fn());

        expect(mocks.openDocumentDirect).toHaveBeenCalledWith('browser://documents/source.pdf');
        expect(mocks.openDocumentDirect).toHaveBeenCalledWith('browser://documents/legacy.pdf');
        expect(mocks.readTextFile).toHaveBeenCalledWith('browser://documents/source.txt');
        expect(mocks.readTextFile).toHaveBeenCalledWith('browser://documents/legacy.txt');
        await vi.waitFor(() => {
            expect(mocks.onMenuSave).toHaveBeenCalled();
        });
        unsubscribe();
    });

    it('reports lazy event subscription failures with the capability path', async () => {
        const subscriptionError = new Error('subscription failed');
        mocks.onStatus.mockImplementation(() => {
            throw subscriptionError;
        });
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const unsubscribe = lazyBrowserPlatformApi.updates.onStatus(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserLoggerError).toHaveBeenCalledWith(
                'platform',
                'Failed to subscribe to browser event updates.onStatus',
                subscriptionError,
            );
        });
        unsubscribe();
    });

    it('reports split lazy event subscription failures with the split capability path', async () => {
        const subscriptionError = new Error('split subscription failed');
        mocks.onMenuSave.mockImplementation(() => {
            throw subscriptionError;
        });
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const unsubscribe = lazyBrowserPlatformApi.documentMenu?.onMenuSave(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserLoggerError).toHaveBeenCalledWith(
                'platform',
                'Failed to subscribe to browser event documentMenu.onMenuSave',
                subscriptionError,
            );
        });
        unsubscribe?.();
    });
});
