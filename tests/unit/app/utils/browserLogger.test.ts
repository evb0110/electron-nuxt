import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const LOG_LEVEL_STORAGE_KEY = 'evb-viewer:log-level';

interface IWindowStubOptions {
    logLevel?: string;
    diagnosticWarnAsWarn?: boolean;
}

function createWindowStub(options: IWindowStubOptions = {}) {
    const rendererLog = vi.fn();
    const windowStub: Record<string, unknown> = {
        localStorage: {getItem: vi.fn((key: string) => (
            key === LOG_LEVEL_STORAGE_KEY
                ? options.logLevel ?? null
                : null
        ))},
        electronAPI: {settings: {rendererLog}},
    };
    if (options.diagnosticWarnAsWarn !== undefined) {
        windowStub.__diagnosticWarnAsWarn = options.diagnosticWarnAsWarn;
    }
    return {
        windowStub,
        rendererLog,
    };
}

function spyOnConsole() {
    return {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        info: vi.spyOn(console, 'info').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
}

async function importBrowserLogger() {
    const module = await import('@app/utils/browserLogger');
    return module.BrowserLogger;
}

describe('BrowserLogger', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('suppresses debug and info at the default warn level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.debug('section-a', 'debug message');
        logger.info('section-a', 'info message');

        expect(consoleSpies.log).not.toHaveBeenCalled();
        expect(consoleSpies.info).not.toHaveBeenCalled();
        expect(rendererLog).not.toHaveBeenCalled();
    });

    it('emits and forwards warn and error at the default level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.warn('section-a', 'warn message', {detail: 1});
        logger.error('section-a', 'error message');

        expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
        expect(consoleSpies.error).toHaveBeenCalledTimes(1);
        expect(rendererLog).toHaveBeenCalledTimes(2);
        expect(rendererLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
            level: 'warn',
            section: 'section-a',
            message: 'warn message',
            data: {detail: 1},
        }));
        expect(rendererLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
            level: 'error',
            section: 'section-a',
            message: 'error message',
        }));
    });

    it('keeps diagnostic silent at the default level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message');
        logger.diagnosticThrottled('pdf-nav', 'key-1', 100, 'throttled trace');

        expect(consoleSpies.log).not.toHaveBeenCalled();
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(rendererLog).not.toHaveBeenCalled();
    });

    it('emits diagnostic as debug when the configured level is debug', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'debug'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message', {step: 1});

        expect(consoleSpies.log).toHaveBeenCalledTimes(1);
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'debug',
            section: 'pdf-nav',
            message: 'trace message',
            data: {step: 1},
        }));
    });

    it('promotes diagnostic to warn when __diagnosticWarnAsWarn is set', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({diagnosticWarnAsWarn: true});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message');

        expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
        expect(consoleSpies.log).not.toHaveBeenCalled();
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'warn',
            section: 'pdf-nav',
        }));
    });

    it('throttles diagnosticThrottled and reports the suppressed count', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'debug'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnosticThrottled('pdf-nav', 'key-1', 1_000, 'tick', {sequence: 1});
        logger.diagnosticThrottled('pdf-nav', 'key-1', 1_000, 'tick', {sequence: 2});
        logger.diagnosticThrottled('pdf-nav', 'key-1', 1_000, 'tick', {sequence: 3});

        expect(consoleSpies.log).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
        logger.diagnosticThrottled('pdf-nav', 'key-1', 1_000, 'tick', {sequence: 4});

        expect(consoleSpies.log).toHaveBeenCalledTimes(2);
        expect(rendererLog).toHaveBeenLastCalledWith(expect.objectContaining({data: expect.objectContaining({
            sequence: 4,
            throttledSuppressedCount: 2,
            throttledIntervalMs: 1_000,
            throttledKey: 'key-1',
        })}));
    });

    it('resolves lazy data only when the log is emitted', async () => {
        const { windowStub } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const logger = await importBrowserLogger();
        const lazyData = vi.fn(() => ({heavy: true}));

        logger.debug('section-a', 'filtered message', lazyData);
        expect(lazyData).not.toHaveBeenCalled();

        logger.warn('section-a', 'emitted message', lazyData);
        expect(lazyData).toHaveBeenCalledTimes(1);
    });

    it('serializes Error data for forwarding', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const logger = await importBrowserLogger();

        logger.warn('section-a', 'failed', new Error('boom'));

        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({
            name: 'Error',
            message: 'boom',
        })}));
    });

    it('suppresses everything at the silent level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'silent'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.error('section-a', 'error message');
        logger.warn('section-a', 'warn message');

        expect(consoleSpies.error).not.toHaveBeenCalled();
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(rendererLog).not.toHaveBeenCalled();
    });
});
