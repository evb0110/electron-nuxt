import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runDetached } from '@electron/utils/runDetached';

describe('runDetached', () => {
    it('contains rejected detached work and reports its label', async () => {
        const logger = {error: vi.fn()};

        runDetached(
            () => Promise.reject(new Error('cleanup failed')),
            {
                label: 'cleanup',
                logger,
            },
        );
        await Promise.resolve();

        expect(logger.error).toHaveBeenCalledWith('Detached task "cleanup" failed: cleanup failed');
    });

    it('contains synchronous task failures', () => {
        const logger = {error: vi.fn()};

        runDetached(
            () => {
                throw new Error('sync failure');
            },
            {
                label: 'sync cleanup',
                logger,
            },
        );

        expect(logger.error).toHaveBeenCalledWith('Detached task "sync cleanup" failed: sync failure');
    });
});
