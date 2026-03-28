import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createMacOpenFileRouter } from '@electron/bootstrap/external-open';

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    };
}

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
