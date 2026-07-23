import {
    describe,
    expect,
    it,
} from 'vitest';
import { isRecentOpenCommandEligible } from '@app/modules/workspace-shell/host/isRecentOpenCommandEligible';

describe('Recent open command eligibility', () => {
    it('allows a cold Recent open before any workspace owner exists', () => {
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: null,
            documentRef: '/documents/cold.pdf',
        })).toBe(true);
    });

    it('blocks only the row already owned by the active open transaction', () => {
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: '/documents/opening.pdf',
            documentRef: '/documents/opening.pdf',
        })).toBe(false);
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: '/documents/opening.pdf',
            documentRef: '/documents/other.pdf',
        })).toBe(true);
    });
});
