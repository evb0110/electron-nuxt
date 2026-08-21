import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({appended: [] as string[]}));

vi.mock('fs', () => ({
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({
        size: 0,
        isFile: () => true,
        mtimeMs: 0,
    })),
}));
vi.mock('fs/promises', () => ({
    appendFile: vi.fn(async (_path: string, payload: string) => {
        if (payload.length > 0) {
            mocks.appended.push(payload);
        }
    }),
    readdir: vi.fn(async () => []),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
}));

function countWrittenLines() {
    return mocks.appended
        .join('')
        .split('\n')
        .filter(line => line.length > 0)
        .length;
}

describe('file logger write buffering', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        mocks.appended = [];
        process.env.ELECTRON_FILE_LOG_LEVEL = 'DEBUG';
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.ELECTRON_FILE_LOG_LEVEL;
    });

    it('coalesces a burst of lines into a single append', async () => {
        const { createLogger } = await import('@electron/utils/createLogger');
        const logger = createLogger('buffer-test', {broadcastToRenderers: false});

        for (let index = 0; index < 25; index += 1) {
            logger.info(`line ${index}`);
        }
        expect(mocks.appended).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(150);
        expect(mocks.appended).toHaveLength(1);
        expect(countWrittenLines()).toBe(25);
    });

    it('writes error lines without waiting for the flush window', async () => {
        const { createLogger } = await import('@electron/utils/createLogger');
        const logger = createLogger('buffer-error-test', {broadcastToRenderers: false});

        logger.info('buffered');
        logger.error('urgent');

        await vi.advanceTimersByTimeAsync(0);
        expect(countWrittenLines()).toBe(2);
    });

    it('flushes buffered lines on shutdown', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('buffer-flush-test', {broadcastToRenderers: false});

        logger.info('pending on quit');
        expect(mocks.appended).toHaveLength(0);

        await flushPendingLogWrites();
        expect(countWrittenLines()).toBe(1);
        expect(mocks.appended.join('')).toContain('pending on quit');
    });
});
