import {shouldSubmitRequestedCurrentPage} from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('requested current-page policy', () => {
    it('treats a committed-page v-model echo as an acknowledgement', () => {
        expect(shouldSubmitRequestedCurrentPage(4, 4, null)).toBe(false);
    });

    it('submits a different external target and can cancel a pending target', () => {
        expect(shouldSubmitRequestedCurrentPage(5, 4, null)).toBe(true);
        expect(shouldSubmitRequestedCurrentPage(4, 4, 9)).toBe(true);
    });

    it('does not resubmit an acknowledgement matching the pending target', () => {
        expect(shouldSubmitRequestedCurrentPage(4, 4, 4)).toBe(false);
    });

});
