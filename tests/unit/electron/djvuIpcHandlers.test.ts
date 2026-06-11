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
    isAllowedDjvuViewingPath: vi.fn(),
    getDjvuPageSizesForViewing: vi.fn(),
    renderDjvuPagePreview: vi.fn(),
    releaseDjvuViewingPath: vi.fn(),
    cleanupDjvuTempPdfPath: vi.fn(),
    sweepStaleDjvuTempPdfs: vi.fn(),
}));

vi.mock('electron', () => ({ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
    mocks.ipcHandle(channel, handler);
    mocks.handlers.set(channel, handler);
}}}));

vi.mock('@electron/djvu/estimateSizes', () => ({estimateSizes: mocks.estimateSizes}));
vi.mock('@electron/djvu/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuHasText: mocks.getDjvuHasText,
    getDjvuMetadata: mocks.getDjvuMetadata,
}));
vi.mock('@electron/djvu/parseDjvuOutline', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/features/djvu/main/pdfExport', () => ({
    handleDjvuConvertToPdf: mocks.handleDjvuConvertToPdf,
    handleDjvuCancel: mocks.handleDjvuCancel,
}));
vi.mock('@electron/features/djvu/main/viewing', () => ({
    handleDjvuOpenForViewing: mocks.handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath,
    releaseDjvuViewingPath: mocks.releaseDjvuViewingPath,
    cleanupDjvuTempPdfPath: mocks.cleanupDjvuTempPdfPath,
    sweepStaleDjvuTempPdfs: mocks.sweepStaleDjvuTempPdfs,
}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({
    getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing,
    renderDjvuPagePreview: mocks.renderDjvuPagePreview,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { registerDjvuHandlers } = await import('@electron/features/djvu/main/registerDjvuHandlers');

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
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([{
            width: 100,
            height: 200,
            dpi: 300,
        }]);
        mocks.renderDjvuPagePreview.mockResolvedValue({
            bytes: new Uint8Array([1]),
            width: 100,
            height: 200,
        });
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

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
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

    it('requires an active viewing grant before probing page sizes', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-size-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = {sender: {id: 1}};
            allowOpenPath(realPath, event.sender as never);
            mocks.isAllowedDjvuViewingPath.mockReturnValue(false);
            registerDjvuHandlers();
            const handler = getHandler('djvu:getPageSizes');

            await expect(handler(event, realPath)).rejects.toThrow('DjVu viewing path is not active');

            expect(mocks.getDjvuPageSizesForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('renders a page preview only for an active viewing path', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = {sender: {id: 1}};
            allowOpenPath(realPath, event.sender as never);
            registerDjvuHandlers();
            const handler = getHandler('djvu:renderPagePreview');

            await expect(handler(event, realPath, 1)).resolves.toEqual({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });

            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledWith(canonicalRealPath, 1);
            expect(mocks.getDjvuPageCount).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
