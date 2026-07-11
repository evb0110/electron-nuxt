import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    classifyUnhandledRejectionSubsystem,
    createUnhandledRejectionRecovery,
} from '@electron/unhandledRejectionRecovery';

describe('unhandled rejection recovery', () => {
    it('classifies subsystem failures from stack and message evidence', () => {
        const error = new Error('Tesseract worker failed');
        error.stack = 'Error\n at electron/ocr/jobManager.ts:10';
        expect(classifyUnhandledRejectionSubsystem(error)).toBe('ocr');
        expect(classifyUnhandledRejectionSubsystem(new Error('unrelated failure'))).toBe('unknown');
    });

    it('restarts a subsystem only after the rolling threshold', async () => {
        let timestamp = 1_000;
        const recover = vi.fn();
        const handle = createUnhandledRejectionRecovery({
            threshold: 3,
            windowMs: 10_000,
            now: () => timestamp,
            recover,
        });
        const failure = new Error('search worker rejected');

        await expect(handle(failure)).resolves.toMatchObject({
            count: 1,
            recovered: false,
            subsystem: 'search',
        });
        timestamp += 1_000;
        await expect(handle(failure)).resolves.toMatchObject({
            count: 2,
            recovered: false,
        });
        timestamp += 1_000;
        await expect(handle(failure)).resolves.toMatchObject({
            count: 3,
            recovered: true,
        });
        expect(recover).toHaveBeenCalledOnce();
    });
});
