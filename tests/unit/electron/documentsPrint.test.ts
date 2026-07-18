import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const mocks = vi.hoisted(() => {
    const browserWindowInstances: MockBrowserWindow[] = [];
    const printHandler = vi.fn((
        _options: unknown,
        callback: (success: boolean, failureReason?: string) => void,
    ) => callback(true));

    class MockBrowserWindow {
        public readonly close = vi.fn();
        public readonly hide = vi.fn();
        public readonly isDestroyed = vi.fn(() => false);
        public readonly loadURL = vi.fn(async () => {});
        public readonly once = vi.fn();
        public readonly removeListener = vi.fn();
        public readonly setTitle = vi.fn();
        public readonly showInactive = vi.fn();
        public readonly webContents = {
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

        public static fromWebContents = vi.fn(() => null);
    }

    return {
        MockBrowserWindow,
        appGetPath: vi.fn(() => '/tmp'),
        browserWindowInstances,
        openPath: vi.fn(async () => ''),
        printHandler,
        pdfPageCount: 1,
        pdfPageSize: {
            width: 612,
            height: 792,
        },
        pdfDocumentLoad: vi.fn(),
        readdir: vi.fn<() => Promise<string[]>>(async () => []),
        mkdtemp: vi.fn(async () => '/tmp/evb-viewer/raster-work'),
        readFile: vi.fn(async () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')),
        rm: vi.fn(async () => {}),
        runNativeToolCommand: vi.fn(async () => ({})),
        randomUUID: vi.fn(() => 'print-job-id'),
        ensuredReadablePaths: new Set<string>(),
        ownedReadablePathsBySender: new Map<number, Set<string>>(),
        findWorkingCopyPathByOriginalPath: vi.fn<(path: string, senderId?: number) => string | null>(() => null),
        ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
        resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(async (path: string) => path),
        extractPages: vi.fn(async () => {}),
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

vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    readdir: mocks.readdir,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('crypto', () => ({ randomUUID: mocks.randomUUID }));
vi.mock('pdf-lib', () => ({ PDFDocument: { load: (...args: unknown[]) => mocks.pdfDocumentLoad(...args) } }));

vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/file-access/workingCopyStore', () => ({findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/features/page-ops/public', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({pdftoppm: '/mock/pdftoppm'})}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: () => undefined}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));

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
const { printManagedTempPdfPath } = await import('@electron/utils/printHandoff');

const tempRoot = '/tmp/evb-viewer';
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
        vi.clearAllMocks();
        mocks.browserWindowInstances.length = 0;
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
        mocks.ensureWorkingCopyDirectory.mockImplementation(async (path: string, requestedSenderId?: number) => {
            if (typeof requestedSenderId !== 'number' || !mocks.ownedReadablePathsBySender.get(requestedSenderId)?.has(path)) {
                return false;
            }
            mocks.ensuredReadablePaths.add(path);
            return true;
        });
        mocks.readdir.mockResolvedValue([]);
        mocks.mkdtemp.mockResolvedValue('/tmp/evb-viewer/raster-work');
        mocks.readFile.mockResolvedValue(validPdfBytes);
        mocks.rm.mockResolvedValue(undefined);
        mocks.runNativeToolCommand.mockResolvedValue({});
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
        rmSync(sourcePdfWorkDir, {
            force: true,
            recursive: true,
        });
    });

    async function settleNativePrint<T>(promise: Promise<T>) {
        for (let index = 0; index < 12; index += 1) {
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
        expect(mocks.pdfDocumentLoad).toHaveBeenCalledWith(validPdfBytes, { updateMetadata: false });
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
                '/tmp/evb-viewer/raster-work/page-00001',
            ],
            expect.objectContaining({
                commandLabel: 'pdftoppm(print-raster)',
                timeoutMs: 180_000,
            }),
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/evb-viewer/raster-work/print.html',
            expect.stringContaining('data-page-number="2"'),
            'utf8',
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL('/tmp/evb-viewer/raster-work/print.html').toString(),
        );
        expect(mocks.browserWindowInstances[0]?.showInactive).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
            expect.objectContaining({ printBackground: true }),
            expect.any(Function),
        );
        expect(mocks.unlink).not.toHaveBeenCalledWith(sourcePdfPath);

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/evb-viewer/raster-work', {
            force: true,
            recursive: true,
        });
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('rejects a raster print whose decoded page surfaces exceed the aggregate budget', async () => {
        mocks.pdfPageCount = 100;
        mocks.pdfPageSize = {
            width: 612,
            height: 792,
        };

        await expect(printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'large-book.djvu',
            {surface: 'rasterized-html'},
        )).resolves.toEqual({
            success: false,
            error: 'Raster print is capped at 64000000 decoded pixels',
        });

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('cleans up managed temp PDFs when size validation fails before handoff', async () => {
        mocks.stat.mockResolvedValueOnce({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: 300 * 1024 * 1024,
        });

        await expect(printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'oversized.pdf',
        )).rejects.toThrow('PDF file is too large');

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
