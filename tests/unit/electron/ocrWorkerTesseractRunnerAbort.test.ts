import { EventEmitter } from 'events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runOcrFileBased } from '@electron/ocr/worker/tesseractRunner';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    terminateDetachedChildProcess: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mocks.spawn }));

vi.mock('fs/promises', () => ({
    open: vi.fn(),
    readFile: mocks.readFile,
    stat: mocks.stat,
    unlink: mocks.unlink,
}));

vi.mock('@electron/ocr/resolveTesseractLanguageConfig', () => ({ resolveTesseractLanguageConfig: (languages: string[]) => ({
    orderedLanguages: languages,
    extraConfigArgs: [],
}) }));

vi.mock('@electron/ocr/buildTesseractEnv', () => ({ buildTesseractEnv: () => ({}) }));

vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));

vi.mock('@electron/utils/parseIntegerEnv', () => ({ parseIntegerEnv: (name: string, fallback: number) => (
    name === 'EVB_OCR_FILE_BASED_KILL_GRACE_MS'
        ? 5
        : fallback
) }));

function createMockChildProcess() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: { resume: () => void };
        stderr: EventEmitter;
        kill: () => void;
    };
    child.stdout = { resume: vi.fn() };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
}

describe('runOcrFileBased abort handling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.unlink.mockResolvedValue(undefined);
        mocks.terminateDetachedChildProcess.mockReturnValue(new Promise(() => undefined));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles aborted file-based OCR even when the child never emits close', async () => {
        mocks.spawn.mockReturnValue(createMockChildProcess());
        const abortController = new AbortController();

        const resultPromise = runOcrFileBased(
            '/tmp/page.png',
            ['eng'],
            100,
            100,
            300,
            '/bin/tesseract',
            '/share/tessdata',
            1,
            abortController.signal,
        );

        abortController.abort();
        await vi.advanceTimersByTimeAsync(1_006);

        await expect(resultPromise).resolves.toMatchObject({
            success: false,
            pageData: null,
            pdfPath: null,
            error: 'Tesseract aborted',
        });
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/page-ocr.tsv');
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/page-ocr.pdf');
    });
});
