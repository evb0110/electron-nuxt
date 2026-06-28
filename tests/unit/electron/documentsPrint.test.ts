import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { pathToFileURL } from 'url';

const mocks = vi.hoisted(() => {
    const browserWindowInstances: MockBrowserWindow[] = [];
    const printHandler = vi.fn((
        _options: unknown,
        callback: (success: boolean, failureReason?: string) => void,
    ) => callback(true));

    class MockBrowserWindow {
        public readonly close = vi.fn();
        public readonly isDestroyed = vi.fn(() => false);
        public readonly loadURL = vi.fn(async () => {});
        public readonly once = vi.fn();
        public readonly removeListener = vi.fn();
        public readonly webContents = {
            print: vi.fn(printHandler),
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
        readdir: vi.fn<() => Promise<string[]>>(async () => []),
        randomUUID: vi.fn(() => 'print-job-id'),
        resolveAllowedReadPath: vi.fn(async (path: string) => path),
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
    readdir: mocks.readdir,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('crypto', () => ({ randomUUID: mocks.randomUUID }));

vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/features/page-ops/public', () => ({extractPages: mocks.extractPages}));

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

const tempRoot = '/tmp/evb-viewer';
const validPdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const windowContext = {window: null};

describe('documents print', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.browserWindowInstances.length = 0;
        mocks.appGetPath.mockReturnValue('/tmp');
        mocks.randomUUID.mockReturnValue('print-job-id');
        mocks.readdir.mockResolvedValue([]);
        mocks.printHandler.mockImplementation((
            _options: unknown,
            callback: (success: boolean, failureReason?: string) => void,
        ) => callback(true));
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => path);
        mocks.stat.mockResolvedValue({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: 1,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
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
            '/tmp/source.pdf',
            'source.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.browserWindowInstances).toHaveLength(1);
        expect(mocks.browserWindowInstances[0]?.options).toEqual(expect.objectContaining({
            show: false,
            webPreferences: expect.objectContaining({
                backgroundThrottling: false,
                plugins: true,
            }),
        }));
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL('/tmp/source.pdf').toString(),
        );
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledTimes(1);
        expect(mocks.browserWindowInstances[0]?.close).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
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
        expect(mocks.unlink).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('extracts requested pages to a temporary PDF before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            windowContext,
            '/tmp/source.pdf',
            'source.pdf',
            [4],
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.extractPages).toHaveBeenCalledWith(
            '/tmp/source.pdf',
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
            '/tmp/source.pdf',
            'source.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.openPath).toHaveBeenCalledWith('/tmp/source.pdf');
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
