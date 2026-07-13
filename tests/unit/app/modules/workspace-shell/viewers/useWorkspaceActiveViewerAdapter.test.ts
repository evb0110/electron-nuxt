import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { PDFJS_NATIVE_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/runtime/pdfNativePreviewRouting';
import { useWorkspaceActiveViewerAdapter } from '@app/modules/workspace-shell/viewers/useWorkspaceActiveViewerAdapter';

function createPendingPdfAdapter(size: number | null) {
    return useWorkspaceActiveViewerAdapter({
        djvuSourcePath: ref(null),
        isDjvuMode: ref(false),
        pdfSrc: ref(null),
        pendingDocumentPath: ref('/managed/oversized.pdf'),
        pendingDocumentSize: ref(size),
    });
}

describe('useWorkspaceActiveViewerAdapter', () => {
    it('selects the native chassis presentation from authoritative pending-open size', () => {
        const result = createPendingPdfAdapter(PDFJS_NATIVE_PREVIEW_MIN_BYTES);

        expect(result.activeViewerAdapter.value?.id).toBe('native-pdf');
    });

    it('keeps a normal pending PDF on the PDF.js adapter', () => {
        const result = createPendingPdfAdapter(PDFJS_NATIVE_PREVIEW_MIN_BYTES - 1);

        expect(result.activeViewerAdapter.value?.id).toBe('pdf');
    });

    it('does not infer native routing when pending size metadata is unavailable', () => {
        const result = createPendingPdfAdapter(null);

        expect(result.activeViewerAdapter.value?.id).toBe('pdf');
    });
});
