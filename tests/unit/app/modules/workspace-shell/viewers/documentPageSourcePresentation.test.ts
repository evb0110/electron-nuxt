import {
    describe,
    expect,
    it,
} from 'vitest';
import {isDocumentPageSourceSurfaceFresh} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';

describe('document page-source visual presentation', () => {
    it('never presents a ready page as fresh without a connected owned surface', () => {
        expect(isDocumentPageSourceSurfaceFresh(true, false)).toBe(false);
        expect(isDocumentPageSourceSurfaceFresh(true, true)).toBe(true);
    });
});
