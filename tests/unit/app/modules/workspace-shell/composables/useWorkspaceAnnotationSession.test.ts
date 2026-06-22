import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type * as PdfViewerPublic from '@app/modules/pdf-viewer/public';

vi.mock('@app/modules/pdf-viewer/public', async (importOriginal) => {
    const actual = await importOriginal<typeof PdfViewerPublic>();
    return {
        ...actual,
        collectLivePdfJsAnnotationChangeFingerprint: vi.fn(() => 'annotation-fingerprint'),
    };
});

function createSession() {
    return useWorkspaceAnnotationSession({
        pdfViewerRef: ref(null),
        pdfDocument: ref(null),
        dragMode: ref(false),
    });
}

describe('useWorkspaceAnnotationSession', () => {
    it('exposes when a saved PDF.js annotation baseline preserves the live session', () => {
        const session = createSession();

        expect(session.hasPreservedLivePdfjsAnnotationSession()).toBe(false);

        session.markAnnotationSaved({ preserveLivePdfjsSession: true });
        expect(session.hasPreservedLivePdfjsAnnotationSession()).toBe(true);

        session.resetAnnotationTracking();
        expect(session.hasPreservedLivePdfjsAnnotationSession()).toBe(false);
    });

    it('does not report a preserved live session for ordinary saves', () => {
        const session = createSession();

        session.markAnnotationSaved();

        expect(session.hasPreservedLivePdfjsAnnotationSession()).toBe(false);
    });
});
