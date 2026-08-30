import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type * as NodeCrypto from 'crypto';
import type * as FsPromises from 'fs/promises';
import {cancelMainOperationsForOwner} from '@electron/operation-lifecycle/mainOperationLifecycle';

const mocks = vi.hoisted(() => {
    const browserWindowInstances: MockBrowserWindow[] = [];
    const paintedBitmap = Buffer.alloc(4 * 4 * 4, 255);
    const printHandler = vi.fn((
        _options: unknown,
        callback: (success: boolean, failureReason?: string) => void,
    ) => callback(true));

    class MockBrowserWindow {
        public static emitReadyToShowByDefault = true;

        private readonly eventHandlers = new Map<string, Set<(...args: unknown[]) => void>>();

        public autoEmitReadyToShow = MockBrowserWindow.emitReadyToShowByDefault;

        public readonly close = vi.fn();
        public readonly hide = vi.fn();
        public readonly isDestroyed = vi.fn(() => false);
        public readonly loadURL = vi.fn(async () => {
            if (this.autoEmitReadyToShow) {
                this.emit('ready-to-show');
            }
        });
        public readonly once = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            const handlers = this.eventHandlers.get(event) ?? new Set();
            handlers.add(handler);
            this.eventHandlers.set(event, handlers);
        });
        public readonly removeListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            this.eventHandlers.get(event)?.delete(handler);
        });
        public readonly setTitle = vi.fn();
        public readonly setOpacity = vi.fn();
        public readonly showInactive = vi.fn();
        public readonly webContents = {
            capturePage: vi.fn(async () => ({
                getSize: () => ({
                    width: 4,
                    height: 4,
                }),
                toBitmap: () => mocks.printSurfaceBitmap,
            })),
            executeJavaScript: vi.fn(async () => true),
            on: vi.fn(),
            print: vi.fn(printHandler),
            printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')),
            once: vi.fn(),
            removeListener: vi.fn(),
        };

        public constructor(public readonly options: Record<string, unknown>) {
            browserWindowInstances.push(this);
        }

        public emit(event: string, ...args: unknown[]) {
            const handlers = [...(this.eventHandlers.get(event) ?? [])];
            this.eventHandlers.delete(event);
            for (const handler of handlers) {
                handler(...args);
            }
        }

        public static fromWebContents = vi.fn(() => null);
    }

    return {
        MockBrowserWindow,
        appGetPath: vi.fn(() => '/tmp'),
        browserWindowInstances,
        openPath: vi.fn(async () => ''),
        printSurfaceBitmap: paintedBitmap,
        printHandler,
        pdfPageCount: 1,
        pdfPageSize: {
            width: 612,
            height: 792,
        },
        pdfDocumentLoad: vi.fn(),
        open: vi.fn(),
        readdir: vi.fn<() => Promise<string[]>>(async () => []),
        mkdtemp: vi.fn(async () => '/tmp/evb-viewer-test-profile/raster-work'),
        readFile: vi.fn(async () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')),
        rm: vi.fn(async () => {}),
        runNativeToolCommand: vi.fn<(command: string, args: string[]) => Promise<{stdout?: string}>>(
            async (_command: string, _args: string[]) => ({}),
        ),
        cancelNativeCommandGroup: vi.fn(),
        randomUUID: vi.fn(() => 'print-job-id'),
        ensuredReadablePaths: new Set<string>(),
        ownedReadablePathsBySender: new Map<number, Set<string>>(),
        findWorkingCopyPathByOriginalPath: vi.fn<(path: string, senderId?: number) => string | null>(() => null),
        ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
        ensureWorkingCopyMaterialized: vi.fn(),
        resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(async (path: string) => path),
        extractPages: vi.fn(async (..._args: unknown[]) => {}),
        stat: vi.fn<(path: string) => Promise<{
            ctimeMs: number;
            isFile: () => boolean;
            mtimeMs: number;
            size?: number;
        }>>(async () => ({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: 1,
        })),
        unlink: vi.fn(async () => {}),
        writeFile: vi.fn(async () => {}),
    };
});

vi.mock('electron', () => ({
    app: { getPath: mocks.appGetPath },
    BrowserWindow: mocks.MockBrowserWindow,
    shell: { openPath: mocks.openPath },
}));

vi.mock('fs/promises', async (importOriginal) => ({
    ...await importOriginal<typeof FsPromises>(),
    // Resolve existence on a microtask: settleNativePrint pumps promises under
    // fake timers, so a real event-loop-bound access() would never settle.
    access: async (path: string) => {
        if (!existsSync(path)) {
            throw new Error(`ENOENT: ${path}`);
        }
    },
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readdir: mocks.readdir,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    return {
        ...actual,
        randomUUID: mocks.randomUUID,
    };
});
vi.mock('pdf-lib', () => ({ PDFDocument: { load: (...args: unknown[]) => mocks.pdfDocumentLoad(...args) } }));

vi.mock('@electron/utils/pathValidator', () => ({
    getManagedTempPathAccessDecision: vi.fn(() => undefined),
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    setManagedTempPathAccessValidator: vi.fn(),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    getWorkingCopyBackingEntry: () => null,
    getWorkingCopyOwnerWebContentsId: () => undefined,
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args)}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/features/page-ops/public', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({
    pdfinfo: '/mock/pdfinfo',
    pdftoppm: '/mock/pdftoppm',
})}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: () => undefined}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({
    cancelNativeCommandGroup: mocks.cancelNativeCommandGroup,
    runNativeToolCommand: mocks.runNativeToolCommand,
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: mocks.cancelNativeCommandGroup}));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}) }));

const {
    handleOpenPdfInDefaultAppData,
    handleOpenPdfInDefaultAppPath,
    handlePrintPdfData,
    handlePrintPdfPath,
    sweepStaleDefaultAppTempPdfs,
} = await import('@electron/features/documents/main/print');
const {
    isCapturedPrintSurfaceBitmap,
    printManagedTempPdfPath,
} = await import('@electron/utils/printHandoff');

const tempRoot = '/tmp/evb-viewer-test-profile';
const validPdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const senderId = 72;
const windowContext = {
    senderId,
    window: null,
};
const sourcePdfWorkDir = join(tempRoot, 'pdf-work-print-test');
const sourcePdfPath = join(sourcePdfWorkDir, 'source.pdf');

describe('documents print', () => {
    beforeEach(() => {
        process.env.EVB_APP_TEMP_NAMESPACE = 'test-profile';
        vi.clearAllMocks();
        mocks.browserWindowInstances.length = 0;
        mocks.MockBrowserWindow.emitReadyToShowByDefault = true;
        mocks.printSurfaceBitmap = Buffer.alloc(4 * 4 * 4, 255);
        mocks.appGetPath.mockReturnValue('/tmp');
        mocks.randomUUID.mockReturnValue('print-job-id');
        mocks.pdfPageCount = 1;
        mocks.pdfPageSize = {
            width: 612,
            height: 792,
        };
        mocks.pdfDocumentLoad.mockImplementation(async () => ({
            getPageCount: () => mocks.pdfPageCount,
            getPage: () => ({getSize: () => mocks.pdfPageSize}),
        }));
        mocks.ensuredReadablePaths.clear();
        mocks.ownedReadablePathsBySender.clear();
        mocks.ownedReadablePathsBySender.set(senderId, new Set([sourcePdfPath]));
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.ensureWorkingCopyMaterialized.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        mocks.ensureWorkingCopyDirectory.mockImplementation(async (path: string, requestedSenderId?: number) => {
            if (typeof requestedSenderId !== 'number' || !mocks.ownedReadablePathsBySender.get(requestedSenderId)?.has(path)) {
                return false;
            }
            mocks.ensuredReadablePaths.add(path);
            return true;
        });
        mocks.readdir.mockResolvedValue([]);
        mocks.mkdtemp.mockResolvedValue('/tmp/evb-viewer-test-profile/raster-work');
        mocks.readFile.mockResolvedValue(validPdfBytes);
        mocks.open.mockImplementation(async () => ({
            close: vi.fn(async () => {}),
            read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
                const range = position === 0
                    ? validPdfBytes
                    : Buffer.from('%%EOF\n');
                const bytesRead = length;
                range.copy(buffer, offset, 0, Math.min(length, range.byteLength));
                return {
                    bytesRead,
                    buffer,
                };
            }),
        }));
        mocks.rm.mockResolvedValue(undefined);
        mocks.runNativeToolCommand.mockImplementation(async (_command: string, args: string[]) => (
            args[0] === '-jpeg'
                ? {}
                : {stdout: `Pages: ${mocks.pdfPageCount}\nPage size: ${mocks.pdfPageSize.width} x ${mocks.pdfPageSize.height} pts\n`}
        ));
        mocks.printHandler.mockImplementation((
            _options: unknown,
            callback: (success: boolean, failureReason?: string) => void,
        ) => callback(true));
        rmSync(sourcePdfWorkDir, {
            force: true,
            recursive: true,
        });
        mkdirSync(sourcePdfWorkDir, {recursive: true});
        writeFileSync(sourcePdfPath, validPdfBytes);
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => (
            mocks.ensuredReadablePaths.has(path) ? path : null
        ));
        mocks.stat.mockResolvedValue({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: validPdfBytes.byteLength,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.EVB_PRINT_DIALOG_TEST_MODE;
        delete process.env.EVB_PRINT_DIALOG_TEST_OUTPUT_PATH;
        delete process.env.EVB_APP_TEMP_NAMESPACE;
        rmSync(sourcePdfWorkDir, {
            force: true,
            recursive: true,
        });
    });

    async function settleNativePrint<T>(promise: Promise<T>) {
        for (let index = 0; index < 40; index += 1) {
            await Promise.resolve();
        }
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        return promise;
    }

    it('creates the native print window with PDF plugins enabled', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith(sourcePdfPath, {
            ownerWebContentsId: senderId,
            reason: 'print-external',
        });
        expect(mocks.browserWindowInstances).toHaveLength(1);
        expect(mocks.browserWindowInstances[0]?.options).toEqual(expect.objectContaining({
            show: false,
            title: 'source',
            webPreferences: expect.objectContaining({
                backgroundThrottling: false,
                plugins: true,
            }),
        }));
        expect(mocks.browserWindowInstances[0]?.setTitle).toHaveBeenCalledWith('source');
        expect(mocks.browserWindowInstances[0]?.webContents.on).toHaveBeenCalledWith(
            'page-title-updated',
            expect.any(Function),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledTimes(1);
        expect(mocks.browserWindowInstances[0]?.close).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it.runIf(process.platform === 'darwin')('keeps the macOS PDF plugin window hidden until its surface paints and settles', async () => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitReadyToShowByDefault = false;
        mocks.printSurfaceBitmap = Buffer.alloc(0);
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );

        for (let index = 0; index < 40; index += 1) {
            await Promise.resolve();
        }

        const printWindow = mocks.browserWindowInstances[0];
        expect(printWindow?.loadURL).toHaveBeenCalled();
        expect(printWindow?.showInactive).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2_000);
        expect(printWindow?.showInactive).not.toHaveBeenCalled();

        printWindow?.emit('ready-to-show');
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(printWindow?.showInactive).not.toHaveBeenCalled();

        mocks.printSurfaceBitmap = Buffer.alloc(4 * 4 * 4, 255);
        await vi.advanceTimersByTimeAsync(250);
        expect(printWindow?.showInactive).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2_000);
        await expect(resultPromise).resolves.toEqual({success: true});
        expect(printWindow?.showInactive).toHaveBeenCalledTimes(1);
        expect(printWindow?.setOpacity).not.toHaveBeenCalledWith(0);
        expect(printWindow?.hide).toHaveBeenCalledTimes(1);
    });

    it('accepts captured print pixels regardless of page color', () => {
        const dark = Buffer.alloc(4 * 4 * 4, 20);
        const light = Buffer.alloc(4 * 4 * 4, 255);
        for (let offset = 3; offset < light.byteLength; offset += 4) {
            light[offset] = 0;
        }

        expect(isCapturedPrintSurfaceBitmap(Buffer.alloc(0), 4, 4)).toBe(false);
        expect(isCapturedPrintSurfaceBitmap(dark, 4, 4)).toBe(true);
        expect(isCapturedPrintSurfaceBitmap(light, 4, 4)).toBe(true);
    });

    it('dispatches a path larger than 2 GiB without applying the byte handoff cap', async () => {
        vi.useFakeTimers();
        mocks.stat.mockResolvedValue({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: 3 * 1024 * 1024 * 1024,
        });

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'large-source.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.pdfDocumentLoad).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );

        await vi.runOnlyPendingTimersAsync();
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('uses the env-gated print-to-PDF smoke mode without opening the native dialog', async () => {
        process.env.EVB_PRINT_DIALOG_TEST_MODE = 'print-to-pdf';
        process.env.EVB_PRINT_DIALOG_TEST_OUTPUT_PATH = '/tmp/print-smoke-output.pdf';
        vi.useFakeTimers();

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.browserWindowInstances[0]?.webContents.print).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.printToPDF).toHaveBeenCalledWith({printBackground: true});
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/print-smoke-output.pdf',
            Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
        );
        expect(mocks.browserWindowInstances[0]?.close).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.showInactive).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.capturePage).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('prints managed DjVu PDFs through a rasterized HTML surface', async () => {
        vi.useFakeTimers();
        mocks.pdfPageCount = 2;
        mocks.pdfPageSize = {
            width: 420,
            height: 594,
        };
        mocks.readdir.mockResolvedValue([
            'page-00001-2.jpg',
            'page-00001-1.jpg',
            'unrelated.jpg',
        ]);

        const resultPromise = printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'book.djvu',
            { surface: 'rasterized-html' },
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.pdfDocumentLoad).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [sourcePdfPath],
            expect.objectContaining({
                commandLabel: 'pdfinfo(print-raster)',
                maxStdoutBytes: 64 * 1024,
                rejectOnStdoutTruncation: true,
            }),
        );
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdftoppm',
            [
                '-jpeg',
                '-r',
                '180',
                '-f',
                '1',
                '-l',
                '2',
                sourcePdfPath,
                '/tmp/evb-viewer-test-profile/raster-work/page-00001',
            ],
            expect.objectContaining({
                commandLabel: 'pdftoppm(print-raster)',
                timeoutMs: 180_000,
            }),
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/evb-viewer-test-profile/raster-work/print.html',
            expect.stringContaining('data-page-number="2"'),
            'utf8',
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL('/tmp/evb-viewer-test-profile/raster-work/print.html').toString(),
        );
        expect(mocks.browserWindowInstances[0]?.showInactive).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.capturePage).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
            expect.objectContaining({ printBackground: true }),
            expect.any(Function),
        );
        expect(mocks.unlink).not.toHaveBeenCalledWith(sourcePdfPath);

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/evb-viewer-test-profile/raster-work', {
            force: true,
            recursive: true,
        });
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('falls back to the PDF plugin when raster decoded pixels exceed the aggregate budget', async () => {
        vi.useFakeTimers();
        mocks.pdfPageCount = 100;
        mocks.pdfPageSize = {
            width: 612,
            height: 792,
        };

        const resultPromise = printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'large-book.djvu',
            {surface: 'rasterized-html'},
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [sourcePdfPath],
            expect.any(Object),
        );
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('falls back to the PDF plugin when raster metadata exceeds the raster page window', async () => {
        vi.useFakeTimers();
        mocks.pdfPageCount = 101;

        const resultPromise = printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'large-book.djvu',
            {surface: 'rasterized-html'},
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        expect(mocks.pdfDocumentLoad).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [sourcePdfPath],
            expect.any(Object),
        );
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('cleans up managed temp PDFs when bounded path validation fails before handoff', async () => {
        mocks.open.mockImplementationOnce(async () => ({
            close: vi.fn(async () => {}),
            read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
                const invalidPdfBytes = Buffer.from('not a PDF');
                const bytesRead = Math.min(length, invalidPdfBytes.byteLength);
                invalidPdfBytes.copy(buffer, offset, 0, bytesRead);
                return {
                    bytesRead,
                    buffer,
                };
            }),
        }));

        await expect(printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'oversized.pdf',
        )).rejects.toThrow('Invalid PDF path');

        expect(mocks.browserWindowInstances).toHaveLength(0);
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('writes temporary PDF bytes before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfData(
            windowContext,
            validPdfBytes,
            'document.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            `${tempRoot}/print-data-print-job-id-document.pdf`,
            Buffer.from(validPdfBytes),
        );
        expect(mocks.browserWindowInstances[0]?.options).toEqual(expect.objectContaining({title: 'document'}));
        expect(mocks.unlink).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('extracts requested pages to a temporary PDF before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            [4],
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.extractPages).toHaveBeenCalledWith(
            sourcePdfPath,
            `${tempRoot}/print-pages-print-job-id-source.pdf`,
            [4],
            expect.objectContaining({
                cancelGroup: expect.any(String),
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(`${tempRoot}/print-pages-print-job-id-source.pdf`).toString(),
        );
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
            expect.objectContaining({pageRanges: [{
                from: 0,
                to: 0,
            }]}),
            expect.any(Function),
        );
        expect(mocks.unlink).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-pages-print-job-id-source.pdf`);
    });

    it('cancels selected-page print when the renderer ends during materialization', async () => {
        const materialization = Promise.withResolvers<undefined>();
        mocks.ensureWorkingCopyMaterialized.mockImplementationOnce(async (path: string, options: {signal?: AbortSignal}) => {
            await materialization.promise;
            if (options.signal?.aborted) {
                throw options.signal.reason;
            }
            return {
                logicalRef: path,
                physicalWorkingCopyPath: path,
                sourceFingerprint: '',
            };
        });

        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            [4],
        );
        await vi.waitFor(() => expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledOnce());

        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');
        materialization.resolve(undefined);

        await expect(printPromise).rejects.toMatchObject({message: 'Renderer lifecycle ended'});
        expect(mocks.extractPages).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances).toHaveLength(0);
    });

    it('cancels selected-page extraction when the renderer ends during qpdf work', async () => {
        const extraction = Promise.withResolvers<undefined>();
        let extractionCancelGroup: string | null = null;
        mocks.extractPages.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[3] as {
                cancelGroup: string;
                signal: AbortSignal;
            };
            extractionCancelGroup = options.cancelGroup;
            options.signal.addEventListener('abort', () => extraction.reject(options.signal.reason), {once: true});
            await extraction.promise;
        });

        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            [4],
        );
        await vi.waitFor(() => expect(mocks.extractPages).toHaveBeenCalledOnce());

        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');

        await expect(printPromise).rejects.toMatchObject({message: 'Renderer lifecycle ended'});
        await vi.waitFor(() => expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledOnce());
        expect(extractionCancelGroup).toEqual(expect.any(String));
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(extractionCancelGroup);
        expect(mocks.browserWindowInstances).toHaveLength(0);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-pages-print-job-id-source.pdf`);
    });

    it('cancels the selected-page native handoff while the plugin surface is still dark', async () => {
        vi.useFakeTimers();
        mocks.printSurfaceBitmap = Buffer.alloc(0);
        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            [4],
        );
        for (let index = 0; index < 40; index += 1) {
            await Promise.resolve();
        }
        // The paint probe only runs where the plugin window is compositor-visible (macOS).
        expect(mocks.browserWindowInstances[0]?.webContents.capturePage)
            .toHaveBeenCalledTimes(process.platform === 'darwin' ? 1 : 0);

        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');
        await vi.advanceTimersByTimeAsync(250);

        await expect(printPromise).resolves.toMatchObject({
            success: false,
            canceled: true,
        });
        expect(mocks.browserWindowInstances[0]?.webContents.print).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('opens the native dialog after the bounded paint probe times out', async () => {
        vi.useFakeTimers();
        mocks.printSurfaceBitmap = Buffer.alloc(0);
        const resultPromise = handlePrintPdfPath(windowContext, sourcePdfPath, 'source.pdf');
        for (let index = 0; index < 40; index += 1) {
            await Promise.resolve();
        }

        await vi.advanceTimersByTimeAsync(17_000);

        await expect(resultPromise).resolves.toEqual({success: true});
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledTimes(1);
    });

    it('cleans up print resources immediately when native printing fails', async () => {
        vi.useFakeTimers();
        mocks.printHandler.mockImplementationOnce((
            _options: unknown,
            callback: (success: boolean, failureReason?: string) => void,
        ) => callback(false, 'printer unavailable'));

        const resultPromise = handlePrintPdfData(
            windowContext,
            validPdfBytes,
            'document.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({
            success: false,
            error: 'printer unavailable',
        });
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('fails and cleans up when the native print callback never arrives', async () => {
        vi.useFakeTimers();
        mocks.printHandler.mockImplementationOnce(() => undefined);

        const resultPromise = handlePrintPdfData(
            windowContext,
            validPdfBytes,
            'document.pdf',
        );
        for (let index = 0; index < 12; index += 1) {
            await Promise.resolve();
        }
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync((5 * 60 * 1000) + 1);
        const result = await resultPromise;

        expect(result).toEqual({
            success: false,
            error: 'Print dialog timed out after 300000ms',
        });
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('opens an existing PDF path in the default desktop app', async () => {
        const result = await handleOpenPdfInDefaultAppPath(
            {senderId},
            sourcePdfPath,
            'source.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.openPath).toHaveBeenCalledWith(sourcePdfPath);
        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith(sourcePdfPath, {
            ownerWebContentsId: senderId,
            reason: 'print-external',
        });
    });

    it('materializes lazy-original paths before print and default-app handoff', async () => {
        const materializedPath = `${sourcePdfWorkDir}/materialized.pdf`;
        mocks.ensureWorkingCopyMaterialized.mockResolvedValue({
            logicalRef: sourcePdfPath,
            physicalWorkingCopyPath: materializedPath,
            sourceFingerprint: 'source-fingerprint',
        });

        vi.useFakeTimers();
        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        await expect(settleNativePrint(printPromise)).resolves.toEqual({success: true});
        await expect(handleOpenPdfInDefaultAppPath(
            {senderId},
            sourcePdfPath,
            'source.pdf',
        )).resolves.toEqual({success: true});

        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(materializedPath).toString(),
        );
        expect(mocks.openPath).toHaveBeenCalledWith(materializedPath);
    });

    it('writes PDF bytes to a temp file before opening the default desktop app', async () => {
        const result = await handleOpenPdfInDefaultAppData(
            validPdfBytes,
            'document.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            `${tempRoot}/open-in-default-app-print-job-id-document.pdf`,
            Buffer.from(validPdfBytes),
        );
        expect(mocks.openPath).toHaveBeenCalledWith(`${tempRoot}/open-in-default-app-print-job-id-document.pdf`);
        expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('sweeps only stale PDF handoff temp files', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        mocks.readdir.mockResolvedValue([
            'open-in-default-app-stale.pdf',
            'open-in-default-app-fresh.pdf',
            'open-in-default-app-note.txt',
            'print-data-stale.pdf',
            'print-pages-stale.pdf',
            'other.pdf',
        ]);
        mocks.stat.mockImplementation(async (path: string) => ({
            ctimeMs: path.includes('fresh') ? 9_900 : 0,
            isFile: () => true,
            mtimeMs: path.includes('fresh') ? 9_900 : 0,
        }));

        await sweepStaleDefaultAppTempPdfs(5_000);

        expect(mocks.stat).toHaveBeenCalledTimes(4);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/open-in-default-app-stale.pdf`);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-stale.pdf`);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-pages-stale.pdf`);
        expect(mocks.unlink).not.toHaveBeenCalledWith(`${tempRoot}/open-in-default-app-fresh.pdf`);
        expect(mocks.unlink).not.toHaveBeenCalledWith(`${tempRoot}/other.pdf`);
    });
});
