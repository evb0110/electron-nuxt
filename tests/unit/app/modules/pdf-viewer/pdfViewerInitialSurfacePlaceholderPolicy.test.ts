import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('PDF viewer initial surface placeholder policy', () => {
    it('keeps a viewer-owned first-surface placeholder until the initial visual is ready', async () => {
        const viewerSource = await readFile(
            join(process.cwd(), 'app/modules/pdf-viewer/components/PdfViewer.vue'),
            'utf8',
        );

        expect(viewerSource).toContain('PdfInitialSurfacePlaceholder');
        expect(viewerSource).toContain('showInitialSurfacePlaceholder');
        expect(viewerSource).toContain('initialSurfacePlaceholderPending.value = true;');
        expect(viewerSource).toContain('event === \'initial-visual-pending\'');
        expect(viewerSource).toContain('event === \'initial-visual-ready\' || event === \'load-error\'');
        expect(viewerSource).toContain('openErrorLatch.consumeMatchingSuccess(generation)');
        expect(viewerSource).toContain('(\'load-error\', null)');
        expect(viewerSource).toContain('openErrorLatch.recordFailure(generation)');
        expect(viewerSource).toContain('usePdfViewerFeatureController(props, emit)');
    });
});
