import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('DjVu viewer visual loading policy', () => {
    it('owns initial and page placeholders through the shared PDF skeleton contract', async () => {
        const viewerSource = await readFile(
            join(process.cwd(), 'app/modules/djvu-viewer/components/DjvuViewer.vue'),
            'utf8',
        );
        const pageContentSource = await readFile(
            join(process.cwd(), 'app/modules/djvu-viewer/components/DjvuPageContent.vue'),
            'utf8',
        );

        expect(viewerSource).not.toContain('AppLoaderOverlay');
        expect(viewerSource).not.toContain('isInitialPreviewPending');
        expect(viewerSource).not.toContain('djvu-viewer-container--pending');
        expect(viewerSource).toContain('\'initial-visual-pending\': []');
        expect(viewerSource).toContain('\'initial-visual-ready\': [payload: {pageNumber: number;}]');
        expect(viewerSource).toContain('PdfInitialSurfacePlaceholder');
        expect(viewerSource).toContain('class="djvu-viewer-initial-placeholder"');
        expect(viewerSource).toContain('waitForViewerLoadSettled');
        expect(viewerSource).toContain('.djvu-viewer-container--initial-visual-pending > div');
        expect(viewerSource).not.toContain('suppressInitialPlaceholder');
        expect(viewerSource).not.toContain('suppress-initial-placeholder');
        expect(pageContentSource).toContain('PdfPageSkeleton');
        expect(pageContentSource).not.toContain('suppressInitialPlaceholder');
        expect(pageContentSource).not.toContain('djvu-page-skeleton');
    });
});
