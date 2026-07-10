import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canMutateCombineFiles,
    removeCompletedCombineSnapshot,
} from '@app/services/pdf/combineOperationSnapshot';

describe('combine operation snapshots', () => {
    it('rejects picker additions and drops while a combine is in flight', () => {
        expect(canMutateCombineFiles(true)).toBe(false);
        expect(canMutateCombineFiles(true)).toBe(false);
        expect(canMutateCombineFiles(false)).toBe(true);
    });

    it('removes only the completed immutable snapshot after success', () => {
        const first = {id: 'first'};
        const second = {id: 'second'};
        const lateDrop = {id: 'late-drop'};
        const latePickerFile = {id: 'late-picker'};
        const snapshot = Object.freeze([
            Object.freeze({...first}),
            Object.freeze({...second}),
        ]);

        expect(removeCompletedCombineSnapshot([
            first,
            second,
            lateDrop,
            latePickerFile,
        ], snapshot)).toEqual([
            lateDrop,
            latePickerFile,
        ]);
    });
});
