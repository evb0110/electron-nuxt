import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

type TRegisteredHandler = (...args: unknown[]) => unknown;

interface IDeferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

function createDeferred<T = undefined>(): IDeferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

function flushQueuedMutationStart() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    existsSync: vi.fn<(path: string) => boolean>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    deletePages: vi.fn(),
    extractPages: vi.fn(),
    reorderPages: vi.fn(),
    rotatePages: vi.fn(),
    cropPages: vi.fn(),
    removeCropFromPages: vi.fn(),
    getPageGeometry: vi.fn(),
    createPdfFromInputPaths: vi.fn(),
    isPdfOrImagePath: vi.fn(),
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    getFocusedWindow: vi.fn(),
    runCommand: vi.fn(),
    getNativeToolPaths: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    allowOpenPath: vi.fn(),
    allowOpenPaths: vi.fn(),
    requireOpenPath: vi.fn((path: string) => path),
    writeFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn(),
}));

vi.mock('electron', () => ({
    BrowserWindow: {
        fromWebContents: () => null,
        getFocusedWindow: () => mocks.getFocusedWindow(),
    },
    dialog: {
        showSaveDialog: (...args: unknown[]) => mocks.showSaveDialog(...args),
        showOpenDialog: (...args: unknown[]) => mocks.showOpenDialog(...args),
    },
    ipcMain: { handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.ipcHandle(channel, handler);
        mocks.handlers.set(channel, handler);
    } },
}));

vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));
vi.mock('fs/promises', () => ({
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedWritePath: (path: string) => mocks.resolveAllowedWritePath(path)}));
vi.mock('@electron/ipc/workingCopy', () => ({
    ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args),
    findWorkingCopyPathByOriginalPath: (...args: unknown[]) => mocks.findWorkingCopyPathByOriginalPath(...args),
}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({
    deletePages: (...args: unknown[]) => mocks.deletePages(...args),
    extractPages: (...args: unknown[]) => mocks.extractPages(...args),
    reorderPages: (...args: unknown[]) => mocks.reorderPages(...args),
    rotatePages: (...args: unknown[]) => mocks.rotatePages(...args),
}));
vi.mock('@electron/features/page-ops/main/crop', () => ({
    cropPages: (...args: unknown[]) => mocks.cropPages(...args),
    removeCropFromPages: (...args: unknown[]) => mocks.removeCropFromPages(...args),
    getPageGeometry: (...args: unknown[]) => mocks.getPageGeometry(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({
    createPdfFromInputPaths: (...args: unknown[]) => mocks.createPdfFromInputPaths(...args),
    isPdfOrImagePath: (...args: unknown[]) => mocks.isPdfOrImagePath(...args),
    SUPPORTED_IMAGE_EXTENSIONS: [
        '.png',
        '.jpg',
    ],
}));
vi.mock('@electron/i18n', () => ({te: (key: string) => key}));
vi.mock('@electron/native-tools/exec', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runCommand(...args)}));
vi.mock('@electron/native-tools/paths', () => ({getNativeToolPaths: () => mocks.getNativeToolPaths()}));
vi.mock('@electron/ipc/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    allowOpenPaths: (...args: unknown[]) => mocks.allowOpenPaths(...args),
    requireOpenPath: (path: string) => mocks.requireOpenPath(path),
}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { registerPageOpsHandlers } = await import('@electron/features/page-ops/main/ipc');

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

describe('registerPageOpsHandlers', () => {
    beforeEach(() => {
        mocks.handlers.clear();
        vi.clearAllMocks();

        mocks.existsSync.mockReturnValue(true);
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.getFocusedWindow.mockReturnValue(null);
        mocks.showSaveDialog.mockResolvedValue({
            canceled: true,
            filePath: undefined,
        });
        mocks.showOpenDialog.mockResolvedValue({
            canceled: true,
            filePaths: [],
        });
        mocks.createPdfFromInputPaths.mockResolvedValue(new Uint8Array([1]));
        mocks.isPdfOrImagePath.mockReturnValue(true);
        mocks.getNativeToolPaths.mockReturnValue({qpdf: '/mock/qpdf'});
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.rename.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.unlink.mockResolvedValue(undefined);

        mocks.deletePages.mockResolvedValue({pageCount: 1});
        mocks.extractPages.mockResolvedValue(undefined);
        mocks.reorderPages.mockResolvedValue({pageCount: 1});
        mocks.rotatePages.mockResolvedValue(undefined);
        mocks.cropPages.mockResolvedValue(undefined);
        mocks.removeCropFromPages.mockResolvedValue(undefined);
        mocks.getPageGeometry.mockResolvedValue(null);
        mocks.runCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });

        registerPageOpsHandlers();
    });

    it('serializes mutating operations for the same workingCopyPath', async () => {
        const firstGate = createDeferred();
        const callOrder: string[] = [];
        let invocation = 0;

        mocks.reorderPages.mockImplementation(async (_workingCopyPath: string, newOrder: number[]) => {
            invocation += 1;
            callOrder.push(`start-${invocation}`);
            if (invocation === 1) {
                await firstGate.promise;
            }
            callOrder.push(`end-${invocation}`);
            return {pageCount: newOrder.length};
        });

        const handler = getHandler('page-ops:reorder');
        const first = handler({sender: {id: 1}}, '/tmp/same.pdf', [
            1,
            2,
            3,
        ]) as Promise<{
            success: boolean;
            pageCount: number 
        }>;
        const second = handler({sender: {id: 1}}, '/tmp/same.pdf', [
            3,
            2,
            1,
        ]) as Promise<{
            success: boolean;
            pageCount: number 
        }>;

        await flushQueuedMutationStart();

        expect(mocks.reorderPages).toHaveBeenCalledTimes(1);

        firstGate.resolve(undefined);

        await expect(first).resolves.toEqual({
            success: true,
            pageCount: 3,
        });
        await expect(second).resolves.toEqual({
            success: true,
            pageCount: 3,
        });

        expect(callOrder).toEqual([
            'start-1',
            'end-1',
            'start-2',
            'end-2',
        ]);
    });

    it('allows different workingCopyPath mutations to run concurrently', async () => {
        const pathOneGate = createDeferred();
        const pathTwoGate = createDeferred();

        mocks.rotatePages.mockImplementation(async (workingCopyPath: string) => {
            if (workingCopyPath === '/tmp/a.pdf') {
                await pathOneGate.promise;
                return;
            }
            if (workingCopyPath === '/tmp/b.pdf') {
                await pathTwoGate.promise;
                return;
            }
        });

        const handler = getHandler('page-ops:rotate');
        const first = handler({sender: {id: 1}}, '/tmp/a.pdf', [1], 90) as Promise<{ success: boolean }>;
        const second = handler({sender: {id: 1}}, '/tmp/b.pdf', [1], 90) as Promise<{ success: boolean }>;

        await flushQueuedMutationStart();

        expect(mocks.rotatePages).toHaveBeenCalledTimes(2);

        pathOneGate.resolve(undefined);
        pathTwoGate.resolve(undefined);

        await expect(first).resolves.toEqual({success: true});
        await expect(second).resolves.toEqual({success: true});
    });

    it('continues processing same-path queue after a mutation failure', async () => {
        const firstGate = createDeferred();
        let invocation = 0;

        mocks.deletePages.mockImplementation(async () => {
            invocation += 1;
            if (invocation === 1) {
                await firstGate.promise;
                throw new Error('delete failed');
            }
            return {pageCount: 2};
        });

        const handler = getHandler('page-ops:delete');
        const first = handler({sender: {id: 1}}, '/tmp/fail.pdf', [1], 3);
        const second = handler({sender: {id: 1}}, '/tmp/fail.pdf', [2], 3);

        await flushQueuedMutationStart();

        expect(mocks.deletePages).toHaveBeenCalledTimes(1);

        firstGate.resolve(undefined);

        await expect(first).rejects.toThrow('delete failed');
        await expect(second).resolves.toEqual({
            success: true,
            pageCount: 2,
        });
        expect(mocks.deletePages).toHaveBeenCalledTimes(2);
    });

    it('allows the extracted PDF path before returning it for a new-tab open', async () => {
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/extracted-pages',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, '/tmp/work.pdf', [
            1,
            2,
        ])).resolves.toEqual({
            success: true,
            destPath: '/tmp/extracted-pages.pdf',
        });

        expect(mocks.extractPages).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/extracted-pages.pdf',
            [
                1,
                2,
            ],
        );
        expect(mocks.allowOpenPath).toHaveBeenCalledWith('/tmp/extracted-pages.pdf', {id: 1});
        expect(mocks.extractPages.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.allowOpenPath.mock.invocationCallOrder[0]!,
        );
    });

    it('recovers the working copy before validating an extract request', async () => {
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, '/tmp/pdf-work-1/work.pdf', [1]))
            .resolves.toEqual({
                success: true,
                destPath: '/tmp/extracted-pages.pdf',
            });

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf');
        expect(mocks.ensureWorkingCopyDirectory.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.resolveAllowedWritePath.mock.invocationCallOrder[0]!,
        );
    });

    it('maps a known original document path back to the managed working copy for extraction', async () => {
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/pdf-work-1/work.pdf');
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: '/tmp/extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, 'C:\\Users\\Rustaveli15\\Documents\\book.pdf', [1]))
            .resolves.toEqual({
                success: true,
                destPath: '/tmp/extracted-pages.pdf',
            });

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf');
        expect(mocks.extractPages).toHaveBeenCalledWith(
            '/tmp/pdf-work-1/work.pdf',
            '/tmp/extracted-pages.pdf',
            [1],
        );
    });

    it('accepts a Windows temp working copy path for extraction', async () => {
        const workingCopyPath = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf';
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, workingCopyPath, [1]))
            .resolves.toEqual({
                success: true,
                destPath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            });

        expect(mocks.resolveAllowedWritePath).toHaveBeenCalledWith(workingCopyPath);
        expect(mocks.extractPages).toHaveBeenCalledWith(
            workingCopyPath,
            'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            [1],
        );
    });

    it('accepts a Windows native namespaced temp working copy path for extraction', async () => {
        const workingCopyPath = '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf';
        mocks.showSaveDialog.mockResolvedValueOnce({
            canceled: false,
            filePath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
        });

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, workingCopyPath, [1]))
            .resolves.toEqual({
                success: true,
                destPath: 'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            });

        expect(mocks.resolveAllowedWritePath).toHaveBeenCalledWith(workingCopyPath);
        expect(mocks.extractPages).toHaveBeenCalledWith(
            workingCopyPath,
            'C:\\Users\\Alice\\Desktop\\extracted-pages.pdf',
            [1],
        );
    });

    it('rejects an unmapped original Windows path before showing the extract destination dialog', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValueOnce(null);

        const handler = getHandler('page-ops:extract');

        await expect(handler({sender: {id: 1}}, 'C:\\Users\\Alice\\Documents\\book.pdf', [1]))
            .rejects.toThrow('Path is outside the allowed working directory');

        expect(mocks.showSaveDialog).not.toHaveBeenCalled();
        expect(mocks.extractPages).not.toHaveBeenCalled();
    });

    it('rejects invalid crop margins before reaching page crop mutations', async () => {
        const handler = getHandler('page-ops:crop');

        await expect(handler({sender: {id: 1}}, '/tmp/crop.pdf', [1], {
            top: Number.NaN,
            bottom: 0,
            left: 0,
            right: 0,
        })).rejects.toThrow('Invalid crop margins');

        expect(mocks.cropPages).not.toHaveBeenCalled();
    });

    it('recovers the working-copy directory before inserting converted source files', async () => {
        mocks.isPdfOrImagePath.mockReturnValue(true);
        mocks.createPdfFromInputPaths.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const handler = getHandler('page-ops:insert-file');

        await expect(handler({sender: {id: 1}}, '/tmp/pdf-work-1/work.pdf', 3, 1, ['/tmp/source.png']))
            .resolves.toEqual({success: true});

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/pdf-work-1/work.pdf');
        expect(mocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/^\/tmp\/pdf-work-1\/insert-source-.+\.pdf$/),
            new Uint8Array([
                1,
                2,
                3,
            ]),
        );
        expect(mocks.runCommand).toHaveBeenCalled();
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/^\/tmp\/pdf-work-1\/tmp-.+\.pdf$/),
            '/tmp/pdf-work-1/work.pdf',
        );
    });

    it('removes stale OCR artifacts after mutating the working copy', async () => {
        const handler = getHandler('page-ops:rotate');

        await expect(handler({sender: {id: 1}}, '/tmp/a.pdf', [1], 90)).resolves.toEqual({success: true});

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/a.pdf.ocr', {
            recursive: true,
            force: true,
        });
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/a.pdf.index.json');
    });
});
