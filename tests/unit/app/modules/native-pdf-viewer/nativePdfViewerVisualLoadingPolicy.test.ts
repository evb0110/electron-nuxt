import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('Native PDF viewer visual loading policy', () => {
    it('owns initial and page placeholders through the shared PDF skeleton contract', async () => {
        const viewerSource = await readFile(
            join(process.cwd(), 'app/modules/native-pdf-viewer/components/NativePdfViewer.vue'),
            'utf8',
        );
        const pageContentSource = await readFile(
            join(process.cwd(), 'app/modules/native-pdf-viewer/components/NativePdfPageContent.vue'),
            'utf8',
        );

        expect(viewerSource).not.toContain('AppLoaderOverlay');
        expect(viewerSource).not.toContain('native-pdf-viewer-container--pending');
        expect(viewerSource).toContain('const NATIVE_PDF_DEVICE_PIXEL_RATIO_CAP = 2;');
        expect(viewerSource).toContain('\'initial-visual-pending\': []');
        expect(viewerSource).toContain('\'initial-visual-ready\': [payload: {pageNumber: number;}]');
        expect(viewerSource).toContain('PdfInitialSurfacePlaceholder');
        expect(viewerSource).toContain('showInitialSurfacePlaceholder');
        expect(viewerSource).not.toContain('useInitialSurfacePlaceholderLayout');
        expect(viewerSource).not.toContain('native-pdf-viewer-initial-placeholder');
        expect(viewerSource).toContain('native-pdf-viewer-container--initial-visual-pending');
        expect(viewerSource).toContain('@visual-ready="handlePageVisualReady"');
        expect(viewerSource).toContain('paintedPageObjectUrls.get(pageNumber) === pageState.objectUrl');
        expect(viewerSource).toContain('waitForViewerLoadSettled');
        expect(viewerSource).toContain('const decodedState = pageStates.value[pageNumber - 1];');
        expect(viewerSource).toContain('source.revokeObjectURL(pendingObjectUrl);');
        expect(viewerSource).toContain('!isActive.value');
        expect(viewerSource).not.toContain('suppressInitialPlaceholder');
        expect(viewerSource).not.toContain('suppress-initial-placeholder');
        expect(pageContentSource).toContain('PdfPageSkeleton');
        expect(pageContentSource).toContain('\'visual-ready\'');
        expect(pageContentSource).toContain('handlePendingImageLoad');
        expect(pageContentSource).toContain('displayedObjectUrl');
        expect(pageContentSource).not.toContain('suppressInitialPlaceholder');
        expect(pageContentSource).not.toContain('native-pdf-page-skeleton');
    });
});
