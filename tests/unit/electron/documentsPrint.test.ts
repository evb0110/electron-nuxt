import {
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
        randomUUID: vi.fn(() => 'print-job-id'),
        resolveAllowedReadPath: vi.fn(async (path: string) => path),
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
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('crypto', () => ({ randomUUID: mocks.randomUUID }));

vi.mock('@electron/utils/path-validator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));

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
} = await import('@electron/features/documents/main/print');

describe('documents print', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.browserWindowInstances.length = 0;
        mocks.appGetPath.mockReturnValue('/tmp');
        mocks.randomUUID.mockReturnValue('print-job-id');
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => path);
    });

    it('creates the native print window with PDF plugins enabled', async () => {
        const result = await handlePrintPdfPath(
            { sender: {} } as never,
            '/tmp/source.pdf',
            'source.pdf',
        );

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
        const result = await handlePrintPdfData(
            { sender: {} } as never,
            Uint8Array.of(1, 2, 3),
            'document.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/print-job-id-document.pdf',
            Buffer.from(Uint8Array.of(1, 2, 3)),
        );
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/print-job-id-document.pdf');
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
});
