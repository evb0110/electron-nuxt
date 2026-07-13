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

    it('keeps the workspace skeleton inside the exact canvas frame', async () => {
        const [
            pageSource,
            skeletonSource,
            viewerSource,
            viewportSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/components/PdfViewerPage.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/components/PdfPageSkeleton.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/components/PdfViewer.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/components/PdfViewerViewport.vue'),
                'utf8',
            ),
        ]);
        const wrapperStart = pageSource.indexOf('<div class="page_canvas">');
        expect(wrapperStart).toBeGreaterThan(-1);
        const pageFrameSource = pageSource.slice(wrapperStart, pageSource.indexOf('</div>\n    </div>', wrapperStart));
        expect(pageFrameSource).toContain('<div class="page_canvas__render-layer canvasWrapper"></div>');
        expect(pageFrameSource).toContain('<PdfPageSkeleton');
        expect(pageSource).toContain(':padding="pageSkeletonPadding"');
        expect(pageSource).toContain('scaledSkeletonPadding.value ?? fallbackSkeletonPadding');
        expect(skeletonSource).not.toContain('box-shadow:');
        expect(skeletonSource).toContain('border-radius: inherit');
        expect(skeletonSource).toContain('background: inherit');
        expect(viewerSource).toContain(':initial-page-shell="showCommittedInitialPageShell && hasProjectedOpeningPageFrame"');
        expect(viewerSource).toContain(':opening-page-frame-page="hasProjectedOpeningPageFrame ? committedInitialPageNumber : null"');
        expect(viewerSource).toContain('canonicalOpeningPageStyle.value ?? openingPageFrameRecord.value?.style ?? null');
        const committedShellStart = viewerSource.indexOf('const isCommittedInitialPageTransition');
        const committedShellEnd = viewerSource.indexOf('const emit =', committedShellStart);
        expect(viewerSource.slice(committedShellStart, committedShellEnd)).not.toContain('snapshot.phase === \'idle\'');
        expect(viewerSource).toContain('buildPdfCommittedOpenPageShellStyle');
        expect(viewerSource).toContain('shouldApplyPdfOpeningPageFrame');
        expect(viewerSource).toContain('snapshot.phase === \'ready\'');
        expect(viewerSource).toContain('clearOpeningPageFrame(snapshot.generation, openingPageFrameOwnerId)');
        expect(viewerSource).not.toContain('openingPageFrameMatchesCanonical');
        expect(viewportSource).toContain(':show-skeleton="shouldRenderPageSkeleton(item.page)"');
        expect(viewportSource).toContain('return shouldShowSkeleton(page);');
        expect(viewportSource).not.toContain('isInitialPageShellItem');
        expect(viewportSource).toContain(':placeholder-style="getEffectivePagePlaceholderStyle(item.page)"');
        expect(viewportSource).not.toContain(':has-visual="hasPageVisual(item.page)"');
        expect(pageSource).toContain(':data-page-visual="pageVisualState"');
        expect(pageSource).toMatch(/rendered\s*\? 'ready'\s*:\s*'none'/u);
        expect(pageSource).toContain('showPageSkeleton && !rendered && !renderFailed');
        expect(viewportSource).toContain('page === openingPageFramePage && openingPageFrameStyle');
        expect(viewerSource).toContain('openingPageFrameRecord');
        expect(viewerSource).toContain('createPdfOpeningPageFrameOwnerId()');
        expect(viewerSource).toContain('openingPageFrameOwnedByRenderer');
        expect(viewerSource).toContain('if (openingPageFrameOwnedByRenderer.value)');
    });

    it('lets feature renderers reuse the chassis-owned frame without taking ownership', async () => {
        const [
            chassisSource,
            pageSourceFeature,
            chassisAuthoritySource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DocumentViewerChassis.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/utils/document-viewer/chassis/documentViewerChassisAuthority.ts'),
                'utf8',
            ),
        ]);

        expect(chassisSource).toContain('v-if="chassisOpeningPageShell && shouldRenderChassisOpeningPageShell"');
        expect(chassisSource).toContain('const provisionalStyle = {');
        expect(chassisSource).toContain('const style = liveFrame?.style ?? frame?.style ?? provisionalStyle;');
        expect(chassisSource).toContain('ownerId: frame?.ownerId ?? \'chassis-provisional\'');
        expect(chassisSource).toContain('provisional: frame === null');
        expect(chassisSource).toContain('chassisOpeningPageShell.value !== null');
        expect(chassisSource).toContain(':id="chassisOpeningPageShell.id"');
        expect(chassisSource).toContain(':ref="bindChassisOpeningPageElement"');
        expect(chassisSource).toContain(':data-page-source-visual="chassisAuthority.openingPageVisual.value"');
        expect(chassisSource).toContain('data-document-opening-shell-id');
        expect(chassisSource).toContain('resolveDocumentOpeningPageShellId(chassisAuthority.instanceId, snapshot.generation)');
        expect(chassisSource).toContain('const isPdf = sourceKind.value === \'pdf\';');
        expect(chassisSource).toContain('z-index: var(--app-workspace-transition-overlay-z-index);');
        expect(chassisSource).toContain('const isOpening = snapshot.phase === \'pending\'');
        expect(chassisSource).toContain('!isOpening');
        expect(chassisSource).not.toContain('v-if="chassisOpeningPageShell.isPdf"');
        expect(chassisSource).toContain(':content-height="chassisOpeningPageShell.height"');
        expect(chassisSource).toContain('const margin = resolveDocumentOpeningPageMargin(geometry, props.rendererKind);');
        expect(chassisSource).not.toContain('sourceKind.value !== \'djvu\'');
        expect(chassisSource).toContain('frame.pageNumber !== chassisAuthority.currentPage.value');
        expect(chassisSource).toContain('if (snapshot.openingPageGeometry === null)');
        expect(chassisSource).toContain('!chassisAuthority.openSurface.commitOpeningPageGeometry(generation, geometry)');
        expect(chassisSource).toContain('() => chassisAuthority.openSurface.snapshot.value.generation');
        expect(chassisAuthoritySource).toContain('readonly instanceId: string;');
        expect(chassisAuthoritySource).toContain('readonly openingPageElement: Readonly<ShallowRef<HTMLElement | null>>;');
        expect(chassisAuthoritySource).toContain('bindOpeningPageElement(element: HTMLElement | null): void;');
        expect(pageSourceFeature).toContain(':to="getChassisOpeningShellTarget(pageNumber)!"');
        expect(pageSourceFeature).toContain('const target = chassisAuthority?.openingPageElement.value;');
        expect(pageSourceFeature).toContain('target?.isConnected');
        expect(pageSourceFeature).toContain('target.dataset.openSurfaceGeneration === String(snapshot?.generation)');
        expect(pageSourceFeature).toContain('image.parentElement === openingTarget && openingTarget.isConnected');
        expect(pageSourceFeature).toContain('if (viewportVisual.presentation === \'canvas\') {');
        expect(pageSourceFeature).toContain('destinationPage: chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber');
        expect(pageSourceFeature).toContain('pageSlots?.markMounted(pageNumber);');
        expect(pageSourceFeature).toContain(':data-page-render-generation="getRenderGeneration(pageNumber)"');
        expect(pageSourceFeature).toContain('expectedOpenSurfaceGeneration !== activeOpenSurfaceGeneration');
        expect(pageSourceFeature).not.toContain('getOpeningShellId');
        expect(pageSourceFeature).not.toContain('document.querySelector');
        expect(pageSourceFeature).toContain('class="document-source-feature-pack"');
        expect(pageSourceFeature).toContain('defineOptions({inheritAttrs: false})');
        expect(pageSourceFeature).toContain('fitMode?: \'width\' | \'height\';');
        expect(pageSourceFeature).toContain('dragMode?: boolean;');
    });

    it('defines every token that owns the initial page frame', async () => {
        const [
            cssSource,
            pdfViewerSource,
        ] = await Promise.all([
            readFile(join(process.cwd(), 'app/assets/css/main.css'), 'utf8'),
            readFile(join(process.cwd(), 'app/assets/css/pdf-viewer.scss'), 'utf8'),
        ]);

        expect(cssSource).toContain('--app-pdf-initial-surface-z-index: var(--app-z-progress);');
        expect(cssSource).toContain('--app-workspace-transition-overlay-z-index: var(--app-z-modal);');
        expect(cssSource).toContain('--app-pdf-page-bg:');
        expect(cssSource).toContain('--app-pdf-page-shadow:');
        expect(pdfViewerSource).toContain('background: var(--app-pdf-page-bg);');
        expect(pdfViewerSource).toContain('box-shadow: var(--app-pdf-page-shadow);');
        expect(pdfViewerSource).toContain('.page_container:not(.page_container--rendered) .text-layer');
        expect(pdfViewerSource).toContain('.page_container:not(.page_container--rendered) .annotation-layer');
        expect(pdfViewerSource).toContain('pointer-events: none;');
        expect(pdfViewerSource).not.toContain('var(--pdf-page-bg)');
        expect(pdfViewerSource).not.toContain('var(--pdf-page-shadow)');
    });

    it('seeds warm geometry only from authoritative fingerprints and never stats the original path', async () => {
        const [
            geometryLifecycleSource,
            virtualSurfaceSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/runtime/lifecycle/usePdfTrustedOpenGeometryLifecycle.ts'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/pdf-viewer/runtime/viewport/usePdfOpenVirtualSurfaceGeometry.ts'),
                'utf8',
            ),
        ]);
        const prevalidatedReadIndex = geometryLifecycleSource.indexOf('snapshot.value.openingPageGeometry');
        const prevalidatedSeedIndex = geometryLifecycleSource.indexOf('pdfDocumentResult.seedTrustedPageGeometry({');

        expect(geometryLifecycleSource).toMatch(/props\.originalPath,\s*props\.src,\s*\]\s+as const/);
        expect(geometryLifecycleSource).toContain('flush: \'sync\'');
        expect(prevalidatedReadIndex).toBeGreaterThan(-1);
        expect(prevalidatedSeedIndex).toBeGreaterThan(prevalidatedReadIndex);
        expect(geometryLifecycleSource).toContain('if (trustedGeometryStat.value)');
        expect(geometryLifecycleSource).toContain('trustedGeometryStat.value = {size: sourceAtLookup.size};');
        expect(geometryLifecycleSource).not.toContain('statFile(documentId)');
        expect(geometryLifecycleSource).not.toContain('getDocumentFilesCapability');
        expect(geometryLifecycleSource).not.toContain('if (!sourceAtLookup)');
        expect(geometryLifecycleSource).not.toContain('hasOptimisticGeometrySeed:');
        expect(virtualSurfaceSource).toContain('options.hasExactPageGeometry(pageNumber)');
        expect(virtualSurfaceSource).toContain('fitViewport.clientWidth <= 0');
        expect(virtualSurfaceSource).toContain('options.isFitWidthScaleCurrent(fitViewport, { page: pageNumber })');
        expect(geometryLifecycleSource).not.toContain('.commitPdfInitialPageSkeletonGeometry(');
    });
});
