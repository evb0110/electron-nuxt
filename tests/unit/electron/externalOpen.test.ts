import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createExternalOpenManager,
    createMacOpenFileRouter,
} from '@electron/bootstrap/external-open';

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('createMacOpenFileRouter', () => {
    it('buffers supported open-file paths before the external-open manager is attached', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };

        router.handleOpenFile('  /Users/test/Documents/sample.PDF  ');
        router.attachExternalOpenManager(externalOpenManager);

        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledTimes(1);
        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledWith(['/Users/test/Documents/sample.PDF']);
        expect(externalOpenManager.requestMainWindowForExternalOpen).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            'Buffered macOS open-file path before external open manager init: /Users/test/Documents/sample.PDF',
        );
        expect(logger.info).toHaveBeenCalledWith('Flushing 1 early macOS open-file path(s)');
    });

    it('ignores unsupported open-file paths', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };

        router.handleOpenFile('/Users/test/Documents/readme.txt');
        router.attachExternalOpenManager(externalOpenManager);

        expect(externalOpenManager.queueOpenRequest).not.toHaveBeenCalled();
        expect(externalOpenManager.requestMainWindowForExternalOpen).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Ignoring unsupported macOS open-file path: /Users/test/Documents/readme.txt',
        );
    });

    it('routes later open-file events directly once the external-open manager is attached', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };

        router.attachExternalOpenManager(externalOpenManager);
        router.handleOpenFile('/Users/test/Documents/live.pdf');

        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledTimes(1);
        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledWith(['/Users/test/Documents/live.pdf']);
        expect(externalOpenManager.requestMainWindowForExternalOpen).toHaveBeenCalledTimes(1);
    });
});

describe('createExternalOpenManager', () => {
    function createManagerHarness(options: {
        isRendererReady?: boolean;
        hasWindows?: boolean;
        dispatchOpenPaths?: (paths: string[]) => boolean;
        grantOpenPaths?: (paths: string[]) => void;
    } = {}) {
        const logger = createLogger();
        let rendererReady = options.isRendererReady ?? true;
        let hasWindows = options.hasWindows ?? true;
        const dispatchOpenPaths = options.dispatchOpenPaths ?? vi.fn((_paths: string[]) => true);
        const createWindow = vi.fn(async () => {
            hasWindows = true;
        });
        const focus = vi.fn();
        const restore = vi.fn();
        const isMinimized = vi.fn(() => false);

        const manager = createExternalOpenManager({
            logger,
            noFocus: false,
            logStartupPhase: vi.fn(),
            isMainWindowRendererReady: () => rendererReady,
            getMainWindow: () => ({
                isMinimized,
                restore,
                focus,
            }),
            hasWindows: () => hasWindows,
            createWindow,
            grantOpenPaths: options.grantOpenPaths,
            dispatchOpenPaths,
        });

        return {
            manager,
            logger,
            dispatchOpenPaths,
            setRendererReady(value: boolean) {
                rendererReady = value;
            },
        };
    }

    it('flushes newly queued paths immediately once bootstrap, window, and renderer are ready', () => {
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/Users/test/Documents/live.pdf']);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith(['/Users/test/Documents/live.pdf']);
    });

    it('grants open capabilities before dispatching later external-open paths', () => {
        const grantOpenPaths = vi.fn();
        const dispatchOpenPaths = vi.fn(() => true);
        const harness = createManagerHarness({
            dispatchOpenPaths,
            grantOpenPaths,
        });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs(['C:\\Users\\test\\Desktop\\book.pdf']);

        expect(grantOpenPaths).toHaveBeenCalledTimes(1);
        expect(grantOpenPaths).toHaveBeenCalledWith(['C:\\Users\\test\\Desktop\\book.pdf']);
        expect(dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(dispatchOpenPaths).toHaveBeenCalledWith(['C:\\Users\\test\\Desktop\\book.pdf']);
        expect(grantOpenPaths.mock.invocationCallOrder[0]).toBeLessThan(dispatchOpenPaths.mock.invocationCallOrder[0]!);
    });

    it('delivers later repeated open requests after the initial dispatch', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/first.pdf']);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.dispatchOpenPaths).toHaveBeenNthCalledWith(1, ['/docs/first.pdf']);

        harness.manager.queueOpenRequest(['/docs/second.pdf']);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(800);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(harness.dispatchOpenPaths).toHaveBeenNthCalledWith(2, ['/docs/second.pdf']);
    });

    it('keeps queued paths until renderer readiness returns', () => {
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/retry.pdf']);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();

        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith(['/docs/retry.pdf']);
    });

    it('lets the startup renderer claim queued paths before renderer-ready dispatch', () => {
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/startup.pdf']);

        expect(harness.manager.claimPendingOpenPaths()).toEqual(['/docs/startup.pdf']);

        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
    });

    it('retries queued paths after a failed renderer dispatch instead of dropping them', async () => {
        vi.useFakeTimers();
        const dispatchOpenPaths = vi
            .fn(() => true)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const harness = createManagerHarness({ dispatchOpenPaths });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/failure.pdf']);

        expect(dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(dispatchOpenPaths).toHaveBeenNthCalledWith(1, ['/docs/failure.pdf']);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(dispatchOpenPaths).toHaveBeenNthCalledWith(2, ['/docs/failure.pdf']);
        expect(harness.logger.warn).toHaveBeenCalledWith(
            'External open dispatch could not reach the renderer; keeping paths queued for retry',
        );
    });
});
