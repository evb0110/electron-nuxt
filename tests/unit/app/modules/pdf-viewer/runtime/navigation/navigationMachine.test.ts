import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfNavigationMachineState } from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationMachineState';

describe('pdf navigation machine', () => {
    it('starts idle', () => {
        expect(createPdfNavigationMachineState()).toEqual({
            anchor: null,
            currentPage: null,
            source: null,
            status: 'idle',
            targetPage: null,
            txn: 0,
        });
    });
});
