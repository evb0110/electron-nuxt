import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {measureOperationPhase} from '@contracts/measureOperationPhase';

describe('measureOperationPhase', () => {
    it('reports a rounded duration after success', async () => {
        const report = vi.fn();
        await expect(measureOperationPhase(async () => 'done', report)).resolves.toBe('done');
        expect(report).toHaveBeenCalledOnce();
        expect(report.mock.calls[0]?.[0]).toEqual(expect.any(Number));
    });

    it('reports duration when the operation rejects', async () => {
        const report = vi.fn();
        await expect(measureOperationPhase(async () => { throw new Error('failure'); }, report))
            .rejects.toThrow('failure');
        expect(report).toHaveBeenCalledOnce();
    });
});
