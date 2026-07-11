import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('PdfInitialSurfacePlaceholder contract', () => {
    it('renders the full-area page skeleton surface without the legacy card internals', async () => {
        const placeholderSource = await readFile(
            join(process.cwd(), 'app/modules/pdf-viewer/components/PdfInitialSurfacePlaceholder.vue'),
            'utf8',
        );

        expect(placeholderSource).toContain('PdfPageSkeleton');
        expect(placeholderSource).toContain('data-evb-initial-visual-placeholder');
        expect(placeholderSource).toContain('var(--app-pdf-initial-surface-z-index)');
        expect(placeholderSource).not.toContain('pdf-initial-surface-placeholder__bar');
        expect(placeholderSource).not.toContain('pdf-initial-surface-placeholder__mark');
        expect(placeholderSource).not.toContain('pageWidth');
    });

    it('keeps the initial surface and workspace transition skeletons geometrically identical', async () => {
        const [
            placeholderSource,
            transitionSkeletonSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/components/PdfInitialSurfacePlaceholder.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceDocumentTransitionSkeleton.vue'),
                'utf8',
            ),
        ]);

        const sharedGeometryStrings = [
            'aspect-ratio: 1 / 1.409',
            'width: calc(100% - 2rem)',
        ];

        for (const geometryString of sharedGeometryStrings) {
            expect(placeholderSource).toContain(geometryString);
            expect(transitionSkeletonSource).toContain(geometryString);
        }

        for (const surfaceSource of [
            placeholderSource,
            transitionSkeletonSource,
        ]) {
            expect(surfaceSource).toContain('const skeletonContentHeight = 760;');
            expect(surfaceSource).toContain(':content-height="skeletonContentHeight"');
            expect(surfaceSource).toContain('top: 56');
            expect(surfaceSource).toContain('right: 56');
            expect(surfaceSource).toContain('bottom: 56');
            expect(surfaceSource).toContain('left: 56');
            expect(surfaceSource).toContain(':padding="skeletonPadding"');
        }

        expect(placeholderSource).toContain('margin-top: var(--app-initial-surface-offset)');
        expect(transitionSkeletonSource).toContain('margin-top: var(--app-workspace-transition-content-offset)');

        const cssSource = await readFile(
            join(process.cwd(), 'app/assets/css/main.css'),
            'utf8',
        );
        expect(cssSource).toContain('--app-initial-surface-offset: var(--app-space-12xl);');
        expect(cssSource).toContain('--app-workspace-transition-content-offset: var(--app-space-12xl);');
    });

    it('defines the initial surface and workspace transition overlay z-index tokens', async () => {
        const cssSource = await readFile(
            join(process.cwd(), 'app/assets/css/main.css'),
            'utf8',
        );

        expect(cssSource).toContain('--app-pdf-initial-surface-z-index: var(--app-z-progress);');
        expect(cssSource).toContain('--app-workspace-transition-overlay-z-index: var(--app-z-modal);');
    });
});
