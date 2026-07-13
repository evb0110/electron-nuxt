import {
    describe,
    expect,
    it,
} from 'vitest';
import { isRecentOpenCommandEligible } from '@app/modules/workspace-shell/host/isRecentOpenCommandEligible';

describe('Recent open command eligibility', () => {
    it('allows a cold Recent open when its command owner is ready', () => {
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: null,
            documentRef: '/documents/cold.pdf',
            ownerReady: true,
        })).toBe(true);
    });

    it('blocks only the row already owned by the active open transaction', () => {
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: '/documents/opening.pdf',
            documentRef: '/documents/opening.pdf',
            ownerReady: true,
        })).toBe(false);
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: '/documents/opening.pdf',
            documentRef: '/documents/other.pdf',
            ownerReady: true,
        })).toBe(true);
    });

    it('blocks commands until the workspace owner is mounted', () => {
        expect(isRecentOpenCommandEligible({
            activeOpenDocumentRef: null,
            documentRef: '/documents/cold.pdf',
            ownerReady: false,
        })).toBe(false);
    });
});
