import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runOcrCommand: vi.fn(),
    stat: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@electron/ocr/worker/runOcrCommand', () => ({runOcrCommand: mocks.runOcrCommand}));
vi.mock('fs/promises', () => ({stat: mocks.stat}));

describe('tryPreprocessOcrImage', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.runOcrCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
        });
        mocks.stat.mockResolvedValue({ size: 1024 });
    });

    it('returns the cleaned image path when unpaper succeeds', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/ocr/worker/tryPreprocessOcrImage');
        const controller = new AbortController();

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
        )).resolves.toBe('/tmp/clean.png');

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/unpaper',
            ['--version'],
            expect.objectContaining({
                commandLabel: 'unpaper(version-probe)',
                signal: controller.signal,
                log: mocks.log,
            }),
        );
        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/unpaper',
            [
                '--layout',
                'single',
                '--deskew',
                '--cleanup',
                '--no-mask-center',
                '--despeckle',
                '/tmp/raw.png',
                '/tmp/clean.png',
            ],
            expect.objectContaining({
                commandLabel: 'unpaper(ocr-preprocess)',
                signal: controller.signal,
                log: mocks.log,
            }),
        );
        expect(mocks.stat).toHaveBeenCalledWith('/tmp/clean.png');
    });

    it('falls back to the raw Poppler image when unpaper is unavailable', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            undefined,
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('unpaper is not bundled'),
        );
    });

    it('falls back to the raw Poppler image when unpaper fails', async () => {
        mocks.runOcrCommand
            .mockResolvedValueOnce({
                stdout: '',
                stderr: '',
            })
            .mockRejectedValueOnce(new Error('deskew failed'));
        const { tryPreprocessOcrImage } = await import('@electron/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('using raw page render'),
        );
    });

    it('disables preprocessing when the unpaper binary is not runnable', async () => {
        mocks.runOcrCommand.mockRejectedValue(new Error('unpaper exited after signal SIGKILL'));
        const { tryPreprocessOcrImage } = await import('@electron/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/unpaper',
            ['--version'],
            expect.any(Object),
        );
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('not runnable'),
        );
    });

    it('falls back to the raw Poppler image when unpaper output is empty', async () => {
        mocks.stat.mockResolvedValue({ size: 0 });
        const { tryPreprocessOcrImage } = await import('@electron/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('did not produce a usable image'),
        );
    });

    it('propagates preprocessing aborts instead of falling back', async () => {
        const abortError = new Error('aborted');
        mocks.runOcrCommand.mockRejectedValue(abortError);
        const controller = new AbortController();
        controller.abort();
        const { tryPreprocessOcrImage } = await import('@electron/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
        )).rejects.toBe(abortError);
    });
});
