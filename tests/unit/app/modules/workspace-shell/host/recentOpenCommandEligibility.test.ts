import {
    describe,
    expect,
    it,
} from 'vitest';
import { isRecentOpenCommandEligible } from '@app/modules/workspace-shell/host/isRecentOpenCommandEligible';

describe('Recent open command eligibility', () => {
    it('allows a cold Recent open to queue while its viewer owner is mounting', () => {
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: null,
            documentRef: '/documents/cold.pdf',
        })).toBe(true);
    });

    it('blocks only the exact path already owned by the active open transaction', () => {
        const firstPath = '/documents/duplicate-source-a/duplicate-recent-source.pdf';
        const secondPath = '/documents/duplicate-source-b/duplicate-recent-source.pdf';

        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: firstPath,
            documentRef: firstPath,
        })).toBe(false);
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: secondPath,
            documentRef: firstPath,
        })).toBe(true);
    });
});
