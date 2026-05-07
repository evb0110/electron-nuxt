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

    class MockBrowserWindow {
        public readonly close = vi.fn();
        public readonly isDestroyed = vi.fn(() => false);
        public readonly loadURL = vi.fn(async () => {});
        public readonly webContents = { print: vi.fn((
            _options: unknown,
            callback: (success: boolean, failureReason?: string) => void,
        ) => callback(true)) };

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
        readdir: vi.fn<() => Promise<string[]>>(async () => []),
        randomUUID: vi.fn(() => 'print-job-id'),
        resolveAllowedReadPath: vi.fn(async (path: string) => path),
        extractPages: vi.fn(async () => {}),
        stat: vi.fn<(path: string) => Promise<{
            ctimeMs: number;
            mtimeMs: number;
            size?: number;
        }>>(async () => ({
            ctimeMs: 0,
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

vi.mock('@electron/utils/path-validator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({extractPages: mocks.extractPages}));

vi.mock('@electron/utils/logger', () => ({ createLogger: () => ({
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

describe('documents print', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.browserWindowInstances.length = 0;
        mocks.appGetPath.mockReturnValue('/tmp');
        mocks.randomUUID.mockReturnValue('print-job-id');
        mocks.readdir.mockResolvedValue([]);
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => path);
        mocks.stat.mockResolvedValue({
            ctimeMs: 0,
            mtimeMs: 0,
            size: 1,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function settleNativePrint<T>(promise: Promise<T>) {
        for (let index = 0; index < 4; index += 1) {
            await Promise.resolve();
        }
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(300);
        return promise;
    }

    it('creates the native print window with PDF plugins enabled', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            { sender: {} } as never,
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
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('writes temporary PDF bytes before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfData(
            { sender: {} } as never,
            Uint8Array.of(1, 2, 3),
            'document.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/print-job-id-document.pdf',
            Buffer.from(Uint8Array.of(1, 2, 3)),
        );
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/print-job-id-document.pdf');
    });

    it('extracts requested pages to a temporary PDF before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            { sender: {} } as never,
            '/tmp/source.pdf',
            'source.pdf',
            [4],
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.extractPages).toHaveBeenCalledWith(
            '/tmp/source.pdf',
            '/tmp/print-pages-print-job-id-source.pdf',
            [4],
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL('/tmp/print-pages-print-job-id-source.pdf').toString(),
        );
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/print-pages-print-job-id-source.pdf');
    });

    it('opens an existing PDF path in the default desktop app', async () => {
        const result = await handleOpenPdfInDefaultAppPath(
            { sender: {} } as never,
            '/tmp/source.pdf',
            'source.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.openPath).toHaveBeenCalledWith('/tmp/source.pdf');
    });

    it('writes PDF bytes to a temp file before opening the default desktop app', async () => {
        const result = await handleOpenPdfInDefaultAppData(
            { sender: {} } as never,
            Uint8Array.of(1, 2, 3),
            'document.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/open-in-default-app-print-job-id-document.pdf',
            Buffer.from(Uint8Array.of(1, 2, 3)),
        );
        expect(mocks.openPath).toHaveBeenCalledWith('/tmp/open-in-default-app-print-job-id-document.pdf');
        expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('sweeps only stale PDF handoff temp files', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        mocks.readdir.mockResolvedValue([
            'open-in-default-app-stale.pdf',
            'open-in-default-app-fresh.pdf',
            'open-in-default-app-note.txt',
            'other.pdf',
        ]);
        mocks.stat.mockImplementation(async (path: string) => ({
            ctimeMs: path.includes('fresh') ? 9_900 : 0,
            mtimeMs: path.includes('fresh') ? 9_900 : 0,
        }));

        await sweepStaleDefaultAppTempPdfs(5_000);

        expect(mocks.stat).toHaveBeenCalledTimes(2);
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/open-in-default-app-stale.pdf');
        expect(mocks.unlink).not.toHaveBeenCalledWith('/tmp/open-in-default-app-fresh.pdf');
        expect(mocks.unlink).not.toHaveBeenCalledWith('/tmp/other.pdf');
    });
});
