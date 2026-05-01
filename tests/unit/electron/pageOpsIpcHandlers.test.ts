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

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    existsSync: vi.fn<(path: string) => boolean>(),
    isAllowedWritePath: vi.fn<(path: string) => boolean>(),
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
    getOcrToolPaths: vi.fn(),
}));

vi.mock('electron', () => ({
    BrowserWindow: { getFocusedWindow: () => mocks.getFocusedWindow() },
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
vi.mock('@electron/utils/path-validator', () => ({isAllowedWritePath: (path: string) => mocks.isAllowedWritePath(path)}));
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
vi.mock('@electron/image/pdf-conversion', () => ({
    createPdfFromInputPaths: (...args: unknown[]) => mocks.createPdfFromInputPaths(...args),
    isPdfOrImagePath: (...args: unknown[]) => mocks.isPdfOrImagePath(...args),
    SUPPORTED_IMAGE_EXTENSIONS: [
        '.png',
        '.jpg',
    ],
}));
vi.mock('@electron/i18n', () => ({te: (key: string) => key}));
vi.mock('@electron/ocr/worker/run-command', () => ({runCommand: (...args: unknown[]) => mocks.runCommand(...args)}));
vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: () => mocks.getOcrToolPaths()}));
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
        mocks.isAllowedWritePath.mockReturnValue(true);
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
        mocks.getOcrToolPaths.mockReturnValue({qpdf: '/mock/qpdf'});

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

        await Promise.resolve();
        await Promise.resolve();

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

        await Promise.resolve();
        await Promise.resolve();

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

        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.deletePages).toHaveBeenCalledTimes(1);

        firstGate.resolve(undefined);

        await expect(first).rejects.toThrow('delete failed');
        await expect(second).resolves.toEqual({
            success: true,
            pageCount: 2,
        });
        expect(mocks.deletePages).toHaveBeenCalledTimes(2);
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
});
