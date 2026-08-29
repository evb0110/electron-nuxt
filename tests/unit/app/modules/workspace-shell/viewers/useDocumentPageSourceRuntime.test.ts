import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolveDocumentPageSourceReadyEdgeSemanticPage} from '@app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime';

describe('document page-source ready-edge reconciliation', () => {
    it('preserves the committed navigation target until a trusted page is observed', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: 11,
            observedPage: null,
        })).toBe(11);
    });

    it('falls back to the requested page when no page is committed', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: null,
            observedPage: null,
        })).toBe(11);
    });

    it('does not reconcile before the viewport session is ready', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'opening',
            requestedPage: 11,
            committedPage: 11,
            observedPage: null,
        })).toBeNull();
    });

    it('leaves a physically observed page for viewport reconciliation', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: 11,
            observedPage: 18,
        })).toBeNull();
    });
});
