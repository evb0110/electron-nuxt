import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('DocumentWorkspace native initial visual contract', () => {
    it('wires native PDF and DjVu into viewer-owned initial visual readiness without shell placeholder suppression', async () => {
        const workspaceSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/DocumentWorkspace.vue'),
            'utf8',
        );
        const viewerHostSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/layout/WorkspaceViewerHost.vue'),
            'utf8',
        );
        const transitionSkeletonSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceDocumentTransitionSkeleton.vue'),
            'utf8',
        );

        const standardPdfBlock = workspaceSource.slice(
            workspaceSource.indexOf('<PdfViewer'),
            workspaceSource.indexOf('/>', workspaceSource.indexOf('<PdfViewer')),
        );
        const nativePdfBlock = workspaceSource.slice(
            workspaceSource.indexOf('<NativePdfViewer'),
            workspaceSource.indexOf('/>', workspaceSource.indexOf('<NativePdfViewer')),
        );
        const djvuBlock = workspaceSource.slice(
            workspaceSource.indexOf('<DjvuViewer'),
            workspaceSource.indexOf('/>', workspaceSource.indexOf('<DjvuViewer')),
        );

        expect(standardPdfBlock).not.toContain('suppress-loading-overlay');

        for (const viewerBlock of [
            nativePdfBlock,
            djvuBlock,
        ]) {
            expect(viewerBlock).not.toContain('suppress-initial-placeholder');
            expect(viewerBlock).toContain('@initial-visual-pending="handleDocumentInitialVisualPending"');
            expect(viewerBlock).toContain('@initial-visual-ready="handleDocumentInitialVisualReady"');
        }

        expect(workspaceSource).not.toContain(':show-opening-surface');
        expect(workspaceSource).not.toContain('showOpeningSurface');
        expect(workspaceSource).toContain(':show-transition-overlay="showDocumentTransitionSkeleton"');
        expect(workspaceSource).toContain('useDocumentTransitionSkeletonLease');
        expect(workspaceSource).toContain('pendingDocumentStatusPath');
        expect(workspaceSource).toContain('showPendingDocumentOpenSkeleton');
        expect(workspaceSource).toContain('<WorkspaceDocumentTransitionSkeleton v-if="showWorkspaceTransitionSkeleton" />');
        expect(viewerHostSource).not.toContain('WorkspaceDocumentOpeningSurface');
        expect(viewerHostSource).not.toContain('showOpeningSurface');
        expect(viewerHostSource).not.toContain('document-workspace__opening-placeholder');
        expect(viewerHostSource).toContain('<template v-if="hasDocument">');
        expect(viewerHostSource).toContain('v-if="showTransitionOverlay"');
        expect(viewerHostSource).toContain('workspace-viewer-host__transition-overlay');
        expect(transitionSkeletonSource).toContain('PdfPageSkeleton');
        expect(transitionSkeletonSource).not.toContain('PdfInitialSurfacePlaceholder');
    });

    it('keeps the deferred workspace host from painting a detached opening surface', async () => {
        const [
            hostSource,
            fallbackSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceHostDocumentOpenFallback.vue'),
                'utf8',
            ),
        ]);

        expect(hostSource).not.toContain('openingDocumentSkeleton');
        expect(hostSource).not.toContain('PdfPageSkeleton');
        expect(hostSource).not.toContain('WorkspaceDocumentOpeningSurface');
        expect(hostSource).not.toContain('layer="host"');
        expect(hostSource).not.toContain('workspace-host__opening-surface');
        expect(hostSource).not.toContain('isDocumentOpeningSurfaceVisible');
        expect(hostSource).toContain(':pending-document-path="pendingDocumentPath"');
        expect(hostSource).toContain('const pendingDocumentPath = computed');
        expect(hostSource).toContain('WorkspaceHostDocumentOpenFallback');
        expect(hostSource).toContain('showHostDocumentOpenSkeleton');
        expect(hostSource).toContain('requestWorkspaceMount(`document-open:${intent.action}`)');
        expect(hostSource).toContain('requestWorkspaceMount(`ensureWorkspaceLoaded:${reason}`)');
        expect(fallbackSource).toContain('WorkspaceDocumentTransitionSkeleton');
        expect(fallbackSource).toContain('PdfStatusBar');
        expect(fallbackSource).toContain('usePageStatusBar');
        expect(fallbackSource).not.toContain('AppSpinner');
        expect(fallbackSource).not.toContain('PdfInitialSurfacePlaceholder');
    });
});
