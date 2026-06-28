import { EventEmitter } from 'node:events';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    preprocessPageForOcr: vi.fn(),
    readFile: vi.fn(),
    spawn: vi.fn(),
    unlink: vi.fn(),
    validatePreprocessingSetup: vi.fn(),
    writeFile: vi.fn(),
    getOcrToolPaths: vi.fn(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('electron', () => ({app: {isPackaged: false}}));
vi.mock('child_process', () => ({spawn: (...args: unknown[]) => mocks.spawn(...args)}));
vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: () => mocks.getOcrToolPaths()}));

function createPngBytes(width: number, height: number) {
    const bytes = new Uint8Array(33);
    bytes.set([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([
        0x49,
        0x48,
        0x44,
        0x52,
    ], 12);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

function createMockSender() {
    const sender = new EventEmitter() as EventEmitter & {isDestroyed: () => boolean;};
    sender.isDestroyed = vi.fn(() => false);
    return sender;
}

describe('validatePreprocessingSetup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.getOcrToolPaths.mockReturnValue({
            tesseract: '/repo/resources/tesseract/darwin-arm64/bin/tesseract',
            tessdata: '/repo/resources/tesseract/tessdata',
            pdftoppm: '/repo/resources/poppler/darwin-arm64/bin/pdftoppm',
            pdftotext: '/repo/resources/poppler/darwin-arm64/bin/pdftotext',
            qpdf: '/repo/resources/qpdf/darwin-arm64/bin/qpdf',
            unpaper: '/repo/resources/tesseract/darwin-arm64/bin/unpaper',
        });
        mocks.existsSync.mockImplementation((path: string) => path.includes('unpaper') || path.includes('leptonica'));
        mocks.spawn.mockImplementation(() => {
            const proc = new EventEmitter() as EventEmitter & {kill: (...args: string[]) => boolean;};
            proc.kill = vi.fn(() => true);
            queueMicrotask(() => {
                proc.emit('close', 0);
            });
            return proc;
        });
    });

    it('caches the async probe result across repeated validations', async () => {
        const { validatePreprocessingSetup } = await import('@electron/ocr/preprocessing');

        const first = validatePreprocessingSetup();
        const second = validatePreprocessingSetup();

        await expect(first).resolves.toMatchObject({
            valid: true,
            available: [
                'unpaper',
                'leptonica',
            ],
            missing: [],
        });
        await expect(second).resolves.toMatchObject({
            valid: true,
            available: [
                'unpaper',
                'leptonica',
            ],
            missing: [],
        });

        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.spawn).toHaveBeenCalledWith(
            expect.stringContaining('unpaper'),
            ['--version'],
            expect.objectContaining({
                detached: process.platform !== 'win32',
                shell: false,
                windowsHide: true,
                stdio: 'ignore',
            }),
        );
    });

    it('validates packaged macOS unpaper through shared OCR native-tool paths', async () => {
        mocks.getOcrToolPaths.mockReturnValue({
            tesseract: '/App/Electron.app/Contents/MacOS/native-tools/tesseract/darwin-arm64/bin/tesseract',
            tessdata: '/Users/example/Library/Application Support/evb-viewer/tessdata',
            pdftoppm: '/App/Electron.app/Contents/MacOS/native-tools/poppler/darwin-arm64/bin/pdftoppm',
            pdftotext: '/App/Electron.app/Contents/MacOS/native-tools/poppler/darwin-arm64/bin/pdftotext',
            qpdf: '/App/Electron.app/Contents/MacOS/native-tools/qpdf/darwin-arm64/bin/qpdf',
            unpaper: '/App/Electron.app/Contents/MacOS/native-tools/tesseract/darwin-arm64/bin/unpaper',
        });
        mocks.existsSync.mockImplementation((path: string) => path.startsWith('/App/Electron.app/Contents/MacOS/native-tools'));
        const { validatePreprocessingSetup } = await import('@electron/ocr/preprocessing');

        await expect(validatePreprocessingSetup()).resolves.toMatchObject({
            valid: true,
            available: [
                'unpaper',
                'leptonica',
            ],
            missing: [],
        });

        const expectedEnv = expect.objectContaining({
            TESSDATA_PREFIX: '/Users/example/Library/Application Support/evb-viewer/tessdata',
            PATH: expect.stringContaining('/App/Electron.app/Contents/MacOS/native-tools/tesseract/darwin-arm64/bin'),
        });
        expect(mocks.spawn).toHaveBeenCalledWith(
            '/App/Electron.app/Contents/MacOS/native-tools/tesseract/darwin-arm64/bin/unpaper',
            ['--version'],
            expect.objectContaining({env: expectedEnv}),
        );
    });
});

describe('handlePreprocessPage', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.doMock('fs/promises', () => ({
            readFile: (...args: unknown[]) => mocks.readFile(...args),
            unlink: (...args: unknown[]) => mocks.unlink(...args),
            writeFile: (...args: unknown[]) => mocks.writeFile(...args),
        }));
        vi.doMock('@electron/ocr/preprocessing', () => ({
            preprocessPageForOcr: (...args: unknown[]) => mocks.preprocessPageForOcr(...args),
            validatePreprocessingSetup: (...args: unknown[]) => mocks.validatePreprocessingSetup(...args),
        }));
        vi.doMock('@electron/utils/appTempDir', () => ({getAppTempDir: () => '/tmp/evb'}));
        mocks.unlink.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.readFile.mockResolvedValue(Buffer.from(createPngBytes(100, 100)));
        mocks.validatePreprocessingSetup.mockResolvedValue({
            valid: true,
            available: ['unpaper'],
            missing: [],
        });
        mocks.preprocessPageForOcr.mockResolvedValue({success: true});
    });

    it('rejects encoded images whose decoded dimensions exceed preprocessing limits', async () => {
        const { handlePreprocessPage } = await import('@electron/ocr/preprocessingHandlers');
        const sender = createMockSender();

        const result = await handlePreprocessPage(
            {sender},
            createPngBytes(100_000, 100_000),
            true,
        );

        expect(result).toMatchObject({
            success: false,
            error: expect.stringContaining('decoded dimensions 100000x100000 exceed preprocessing limits'),
        });
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('reports preprocessing aborts as failed instead of successful raw-image fallback', async () => {
        const { handlePreprocessPage } = await import('@electron/ocr/preprocessingHandlers');
        const sender = createMockSender();
        mocks.preprocessPageForOcr.mockImplementation(async () => {
            sender.emit('destroyed');
            return {
                success: false,
                error: 'Preprocessing aborted',
            };
        });

        const image = createPngBytes(100, 100);
        const result = await handlePreprocessPage(
            {sender},
            image,
            true,
        );

        expect(result).toMatchObject({
            success: false,
            imageData: image,
            error: 'Renderer disconnected during preprocessing',
        });
    });
});
