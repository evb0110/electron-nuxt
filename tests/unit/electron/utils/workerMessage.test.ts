import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';

describe('worker message guards', () => {
    it('accepts non-null objects as message records', () => {
        expect(isWorkerMessageRecord({type: 'progress'})).toBe(true);
        expect(isWorkerMessageRecord([])).toBe(true);
    });

    it('rejects null and primitives as message records', () => {
        expect(isWorkerMessageRecord(null)).toBe(false);
        expect(isWorkerMessageRecord('message')).toBe(false);
        expect(isWorkerMessageRecord(1)).toBe(false);
    });

    it('accepts only finite numbers', () => {
        expect(isFiniteWorkerMessageNumber(0)).toBe(true);
        expect(isFiniteWorkerMessageNumber(1.5)).toBe(true);
        expect(isFiniteWorkerMessageNumber(Number.NaN)).toBe(false);
        expect(isFiniteWorkerMessageNumber(Number.POSITIVE_INFINITY)).toBe(false);
        expect(isFiniteWorkerMessageNumber('1')).toBe(false);
    });
});
