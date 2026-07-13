import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    beginRecentOpenGeometryPrewarm,
    isRecentOpenGeometryActionable,
    isRecentOpenGeometryExactFrameReady,
    readRecentOpenGeometryState,
    settleRecentOpenGeometryPrewarm,
    readRecentOpenExactGeometry,
} from '@app/modules/workspace-shell/host/recentOpenGeometryReadiness';
import { rememberValidatedTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';

describe('recentOpenGeometryReadiness', () => {
    it('keeps cold or missing optional geometry command-actionable', () => {
        beginRecentOpenGeometryPrewarm(['/documents/pending.pdf']);

        expect(readRecentOpenGeometryState('/documents/pending.pdf')).toBe('pending');
        expect(isRecentOpenGeometryActionable('/documents/pending.pdf')).toBe(false);
        expect(isRecentOpenGeometryExactFrameReady('/documents/pending.pdf')).toBe(false);
        expect(readRecentOpenGeometryState('/documents/untracked.pdf')).toBe('cold-fallback');
        expect(isRecentOpenGeometryActionable('/documents/untracked.pdf')).toBe(true);
        expect(isRecentOpenGeometryExactFrameReady('/documents/untracked.pdf')).toBe(false);
    });

    it.each([
        'ready',
        'cold-fallback',
    ] as const)('only makes exact geometry actionable after settling as %s', (state) => {
        const path = `/documents/${state}.pdf`;
        beginRecentOpenGeometryPrewarm([path]);

        if (state === 'ready') {
            rememberValidatedTrustedPdfOpenGeometry({
                documentId: path,
                size: 10,
                modifiedAt: 20,
                pageNumber: 1,
                pageCount: 2,
                width: 600,
                height: 800,
                rotation: 0,
                savedAt: Date.now(),
            });
        }
        settleRecentOpenGeometryPrewarm(path, state);

        expect(readRecentOpenGeometryState(path)).toBe(state);
        expect(isRecentOpenGeometryActionable(path)).toBe(true);
        expect(isRecentOpenGeometryExactFrameReady(path)).toBe(state === 'ready');
        if (state === 'ready') {
            expect(readRecentOpenExactGeometry(path, {
                modifiedAt: 20,
                size: 10,
            })).not.toBeNull();
            expect(readRecentOpenExactGeometry(path, {
                modifiedAt: 21,
                size: 10,
            })).toBeNull();
            expect(readRecentOpenExactGeometry(path, {
                modifiedAt: 20,
                size: 11,
            })).toBeNull();
        }
    });

    it('refuses ready state when the exact geometry cache has no matching entry', () => {
        const path = '/documents/drifted.pdf';
        beginRecentOpenGeometryPrewarm([path]);

        settleRecentOpenGeometryPrewarm(path, 'ready');

        expect(readRecentOpenGeometryState(path)).toBe('cold-fallback');
        expect(isRecentOpenGeometryActionable(path)).toBe(true);
    });

    it('discards a prepared frame when its authoritative fingerprint is replaced', () => {
        const path = '/documents/replaced.pdf';
        rememberValidatedTrustedPdfOpenGeometry({
            documentId: path,
            size: 10,
            modifiedAt: 20,
            pageNumber: 1,
            pageCount: 2,
            width: 600,
            height: 800,
            rotation: 0,
            savedAt: Date.now(),
        });
        settleRecentOpenGeometryPrewarm(path, 'ready');
        expect(readRecentOpenExactGeometry(path)).not.toBeNull();

        rememberValidatedTrustedPdfOpenGeometry({
            documentId: path,
            size: 11,
            modifiedAt: 21,
            pageNumber: 1,
            pageCount: 2,
            width: 700,
            height: 900,
            rotation: 0,
            savedAt: Date.now(),
        });

        expect(readRecentOpenExactGeometry(path)).toBeNull();
        expect(isRecentOpenGeometryExactFrameReady(path)).toBe(false);
        expect(isRecentOpenGeometryActionable(path)).toBe(true);
    });
});
