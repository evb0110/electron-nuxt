import {
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

type TRegisteredHandler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    estimateSizes: vi.fn(),
    getDjvuPageCount: vi.fn(),
    getDjvuResolution: vi.fn(),
    getDjvuOutline: vi.fn(),
    getDjvuHasText: vi.fn(),
    getDjvuMetadata: vi.fn(),
    parseDjvuOutline: vi.fn(),
    handleDjvuConvertToPdf: vi.fn(),
    handleDjvuCancel: vi.fn(),
    handleDjvuOpenForViewing: vi.fn(),
    releaseDjvuViewingPath: vi.fn(),
    cleanupDjvuTempPdfPath: vi.fn(),
    sweepStaleDjvuTempPdfs: vi.fn(),
}));

vi.mock('electron', () => ({ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
    mocks.ipcHandle(channel, handler);
    mocks.handlers.set(channel, handler);
}}}));

vi.mock('@electron/djvu/estimate', () => ({estimateSizes: mocks.estimateSizes}));
vi.mock('@electron/djvu/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuHasText: mocks.getDjvuHasText,
    getDjvuMetadata: mocks.getDjvuMetadata,
}));
vi.mock('@electron/djvu/bookmarks', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/features/djvu/main/pdfExport', () => ({
    handleDjvuConvertToPdf: mocks.handleDjvuConvertToPdf,
    handleDjvuCancel: mocks.handleDjvuCancel,
}));
vi.mock('@electron/features/djvu/main/viewing', () => ({
    handleDjvuOpenForViewing: mocks.handleDjvuOpenForViewing,
    releaseDjvuViewingPath: mocks.releaseDjvuViewingPath,
    cleanupDjvuTempPdfPath: mocks.cleanupDjvuTempPdfPath,
    sweepStaleDjvuTempPdfs: mocks.sweepStaleDjvuTempPdfs,
}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { registerDjvuHandlers } = await import('@electron/features/djvu/main/ipc');

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

describe('registerDjvuHandlers', () => {
    beforeEach(() => {
        mocks.handlers.clear();
        vi.clearAllMocks();
        delete process.env.EVB_DJVU_SWEEP_STALE_TEMP;

        mocks.getDjvuPageCount.mockResolvedValue(1);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuOutline.mockResolvedValue('');
        mocks.getDjvuHasText.mockResolvedValue(true);
        mocks.getDjvuMetadata.mockResolvedValue({});
        mocks.parseDjvuOutline.mockReturnValue([]);
        mocks.estimateSizes.mockReturnValue([]);
        mocks.handleDjvuConvertToPdf.mockResolvedValue({success: true});
        mocks.handleDjvuCancel.mockResolvedValue({canceled: true});
        mocks.handleDjvuOpenForViewing.mockResolvedValue({success: true});
        mocks.releaseDjvuViewingPath.mockReturnValue(undefined);
        mocks.cleanupDjvuTempPdfPath.mockResolvedValue(undefined);
        mocks.sweepStaleDjvuTempPdfs.mockResolvedValue(0);
    });

    it('triggers stale DjVu temp sweep during handler registration by default', () => {
        registerDjvuHandlers();

        expect(mocks.sweepStaleDjvuTempPdfs).toHaveBeenCalledTimes(1);
    });

    it('skips stale sweep when explicitly disabled', () => {
        process.env.EVB_DJVU_SWEEP_STALE_TEMP = '0';

        registerDjvuHandlers();

        expect(mocks.sweepStaleDjvuTempPdfs).not.toHaveBeenCalled();
    });

    it('delegates cleanupTemp to tracked temp cleanup helper', async () => {
        registerDjvuHandlers();
        const handler = getHandler('djvu:cleanupTemp');

        await handler({sender: {id: 1}}, '/tmp/djvu-123.pdf');

        expect(mocks.cleanupDjvuTempPdfPath).toHaveBeenCalledWith('/tmp/djvu-123.pdf');
    });

    it('releases viewing paths without requiring the source file to still exist', () => {
        registerDjvuHandlers();
        const handler = getHandler('djvu:releaseViewingPath');
        const event = {sender: {id: 1}};

        handler(event, '/tmp/missing.djvu');

        expect(mocks.releaseDjvuViewingPath).toHaveBeenCalledWith(event, '/tmp/missing.djvu');
    });

    it('releases symlinked viewing paths using the granted realpath while the source still exists', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-release-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            const symlinkPath = join(tempRoot, 'link.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            symlinkSync(realPath, symlinkPath);
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/ipc/openPathCapabilities');
            const event = {sender: {id: 1}};
            allowOpenPath(symlinkPath, event.sender as never);
            registerDjvuHandlers();
            const handler = getHandler('djvu:releaseViewingPath');

            handler(event, symlinkPath);

            expect(mocks.releaseDjvuViewingPath).toHaveBeenCalledWith(event, canonicalRealPath);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
