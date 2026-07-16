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

    it('submits a different external target while idle', () => {
        expect(shouldSubmitRequestedCurrentPage(5, 4, null)).toBe(true);
    });

    it('does not let an outer projection supersede newer pending intent', () => {
        expect(shouldSubmitRequestedCurrentPage(4, 4, 4)).toBe(false);
        expect(shouldSubmitRequestedCurrentPage(4, 4, 9)).toBe(false);
        expect(shouldSubmitRequestedCurrentPage(5, 4, 9)).toBe(false);
    });

});
