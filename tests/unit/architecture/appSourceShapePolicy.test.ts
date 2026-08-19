import {readFileSync} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';

function readSource(path: string) {
    return readFileSync(path, 'utf8');
}

describe('app source-shape architecture policy', () => {
    it('uses viewer readiness instead of DOM polling or native viewer selection shortcuts', () => {
        const readinessSource = readSource(
            'app/modules/workspace-shell/composables/useWorkspaceStartupReadiness.ts',
        );
        const exposeSource = readSource(
            'app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types.ts',
        );

        expect(exposeSource).toContain('waitForViewerLoadSettled?: () => Promise<void>');
        expect(readinessSource).toContain('waitForViewerLoadSettled');
        expect(readinessSource).not.toContain('querySelector');
        expect(readinessSource).not.toContain('hasRenderedStartupDocument');
        expect(readinessSource).not.toContain('requestAnimationFrame');
        expect(readinessSource).not.toContain('showDjvuSource');
        expect(readinessSource).not.toContain('showNativePdfViewer');
    });

    it('fences page rendering on exact per-page metric readiness', () => {
        const runtime = readSource(
            'app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime.ts',
        );
        const presentation = readSource(
            'app/modules/workspace-shell/viewers/documentPageSourcePresentation.ts',
        );
        const state = readSource(
            'app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState.ts',
        );

        expect(runtime).toContain('const exactPageMetricNumbers = new Set<number>();');
        expect(runtime).toContain('if (exactPageMetricNumbers.has(pageNumber) && exactMetric)');
        expect(presentation).toContain('await options.ensureExactPageMetric(');
        expect(presentation).toContain('if (!isCurrent())');
        expect(presentation).not.toContain('if (pageNumber !== currentPage)');
        expect(state).toContain('onMetric: context.scheduleRender,');
    });

    it('keeps scan-cleanup preview composition and session boundaries wired', () => {
        const previewFiles = [
            'PreviewShell.vue',
            'OriginalCanvas.vue',
            'CleanedCanvas.vue',
            'CutterOverlay.vue',
            'ContentBoxOverlay.vue',
            'PlacementOverlay.vue',
        ].map(file => readSource(`app/modules/scan-cleanup/components/preview/${file}`)).join('\n');
        const workspace = readSource('app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue');
        const settingsPanel = readSource(
            'app/modules/scan-cleanup/components/settings/ScanCleanupSettingsPanel.vue',
        );
        const scopeSelector = readSource(
            'app/modules/scan-cleanup/components/settings/ScanCleanupScopeSelector.vue',
        );
        const previewSession = readSource(
            'app/modules/scan-cleanup/composables/useScanCleanupPreviewSession.ts',
        );
        const previewCss = readSource(
            'app/modules/scan-cleanup/components/preview/PreviewShell.css',
        );
        const selection = readSource(
            'app/modules/scan-cleanup/composables/useScanCleanupSelection.ts',
        );
        const tokens = readSource('app/assets/css/main.css');

        expect(previewFiles).toContain('effectiveViewMode.value === \'original\'');
        expect(previewFiles).toContain('@keydown.left.prevent');
        expect(previewFiles).not.toContain([
            'zoom',
            'Mode',
        ].join(''));
        expect(previewFiles).not.toContain([
            'is',
            'actual',
        ].join('-'));
        expect(previewFiles).toContain('cursor: col-resize');
        expect(previewFiles).not.toContain('<Transition name="scan-preview-crossfade">');
        expect(previewFiles).not.toContain('previewTransitionKey');
        expect(previewFiles).toContain('class="preview-comparison-layer"');
        expect(previewFiles).toContain(':inert="!cleanedLayerVisible"');
        expect(previewCss).toContain('.preview-comparison-layer.is-visible');
        expect(previewFiles).toContain('.content-overlay:focus-within .content-handle::after');
        expect(previewFiles).not.toMatch(/\.content-handle\.is-n::after,[\s\S]*?display: none;/u);
        expect(previewCss).toMatch(/\.uniform-canvas \{[\s\S]*?border: 0;/u);
        expect(previewCss).toMatch(/\.uniform-canvas::after \{[\s\S]*?inset: 0;[\s\S]*?border: var\(--app-hairline-height\) dashed transparent;/u);
        expect(previewCss).toMatch(/\.uniform-canvas\.has-uniform-canvas::after \{[\s\S]*?border-color: var\(--ui-border\);/u);
        expect(previewCss).toMatch(/\.content-overlay \{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: 0 0 0 var\(--app-hairline-height\) var\(--ui-primary\);/u);
        expect(previewFiles).toContain('class="margin-boundary-overlay"');
        expect(previewFiles).toContain(':show-margin-boundary="showMarginBoundary"');
        expect(previewCss).toMatch(/\.margin-boundary-overlay \{[\s\S]*?border: var\(--app-hairline-height\) solid var\(--ui-warning\);/u);
        expect(settingsPanel).toContain('@focusin="$emit(\'margin-interaction\', true)"');
        expect(previewFiles).toContain('v-for="output in outputs"');
        expect(previewFiles).toContain('transformPreviewContentBox(metadata)');
        expect(previewFiles.match(/<ScanCleanupSegmented/gu)).toHaveLength(1);
        expect(workspace).toContain('<ScanCleanupSettingsPanel');
        expect(workspace).not.toContain('scan-cleanup-blank-hint');
        expect(settingsPanel).toContain('scanCleanup.crop.blankDetected');
        expect(workspace).not.toContain('<DocumentSettings');
        expect(workspace).not.toContain('<SelectionSettings');
        expect(settingsPanel).toContain('class="scan-cleanup-details-trigger"');
        expect(settingsPanel).toContain('icon="i-ph-info"');
        expect(settingsPanel).not.toContain('data-margin-side="all"');
        expect(settingsPanel.indexOf('data-margin-side'))
            .toBeLessThan(settingsPanel.indexOf('data-margins-link'));
        expect(settingsPanel.match(/class="scan-cleanup-alignment-grid"/gu)).toHaveLength(1);
        expect(scopeSelector).toContain('role="radiogroup"');
        expect(previewSession).toContain('const cache = createScanCleanupPreviewCache()');
        expect(previewSession).toContain('capability.cancelPreview({');
        expect(previewSession).toContain(
            'inFlightPreviewPages.length === 0 ? 0 : SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS',
        );
        expect(previewSession).toContain('...(navigated');
        expect(previewSession).toContain('requestSequence !== sequence');
        expect(previewSession).not.toContain('options.active() || options.isRunning.value');
        expect(workspace).toContain('@update:manual-split="updateCurrentManualSplit"');
        expect(selection).toContain('manualSplit: value');
        expect(workspace).not.toContain('UModal');
        expect(workspace).not.toContain('scan-cleanup-progress-overlay');
        expect(tokens).toContain('--app-scan-dialog-rail-width');
        expect(tokens).toContain('--app-scan-preview-crossfade-duration');
    });

    it('keeps the global toolbar row invariant when pane ownership changes', () => {
        const shellCss = readSource('app/assets/css/app-shell-critical.scss');
        const toolbarShellRule = shellCss.match(
            /\.editor-global-toolbar-shell,\s*\.editor-global-toolbar-host \{(?<rules>[\s\S]*?)\n\}/u,
        )?.groups?.rules;
        const toolbarRule = shellCss.match(
            /\.toolbar \{(?<rules>[\s\S]*?)\n\}/u,
        )?.groups?.rules;

        expect(toolbarShellRule).toContain(
            'flex: 0 0 var(--app-toolbar-row-height, 3.5rem)',
        );
        expect(toolbarShellRule).toContain(
            'height: var(--app-toolbar-row-height, 3.5rem)',
        );
        expect(toolbarShellRule).toContain(
            'max-height: var(--app-toolbar-row-height, 3.5rem)',
        );
        expect(toolbarRule).toContain(
            'flex: 0 0 var(--app-toolbar-row-height, 3.5rem)',
        );
        expect(toolbarRule).toContain(
            'height: var(--app-toolbar-row-height, 3.5rem)',
        );
        expect(toolbarRule).toContain(
            'max-height: var(--app-toolbar-row-height, 3.5rem)',
        );
    });

    it('stacks the settings rail before narrow panes can squeeze or hide preview controls', () => {
        const workspace = readSource('app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue');
        const previewStyles = readSource(
            'app/modules/scan-cleanup/components/preview/PreviewShell.css',
        );
        const narrowWorkspace = workspace.match(
            /@container \(width <= 52rem\) \{(?<rules>[\s\S]*?)\n\}/u,
        )?.groups?.rules;
        const narrowPreview = previewStyles.match(
            /@container \(width <= 34rem\) \{(?<rules>[\s\S]*)\n\}/u,
        )?.groups?.rules;

        expect(narrowWorkspace).toContain('\'thumbnails preview\' minmax(16rem, 3fr)');
        expect(narrowWorkspace).toContain('\'settings settings\' minmax(12rem, 2fr)');
        expect(narrowWorkspace).toContain('minmax(var(--app-scan-page-list-collapsed-width), 8rem)');
        expect(narrowWorkspace).toContain('overflow: auto');
        expect(narrowWorkspace).not.toContain('display: none');
        expect(narrowPreview).toMatch(/\.preview-header \{[\s\S]*?flex-wrap: wrap/u);
        expect(narrowPreview).toMatch(/\.page-navigation \{[\s\S]*?width: 100%/u);
        expect(narrowPreview).toMatch(
            /\.preview-controls \{[\s\S]*?width: 100%[\s\S]*?flex-wrap: wrap/u,
        );
        expect(narrowPreview).toContain('.preview-controls > *');
    });

    it('keeps scan-cleanup source-shape style and interaction contracts', () => {
        const previewShellStyleSource = readSource(
            'app/modules/scan-cleanup/components/preview/PreviewShell.css',
        );
        const previewShellSource = readSource(
            'app/modules/scan-cleanup/components/preview/PreviewShell.vue',
        );
        const segmentedSource = readSource(
            'app/modules/scan-cleanup/components/ScanCleanupSegmented.vue',
        );
        const toolbarSource = readSource(
            'app/modules/scan-cleanup/components/ScanCleanupToolbar.vue',
        );
        const workspaceSource = readSource(
            'app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue',
        );

        expect(toolbarSource).toContain('minmax(0, 1fr)');
        expect(toolbarSource).toContain('minmax(0, var(--app-scan-toolbar-meter-width))');
        // The meter status line lets only the phase label shrink and ellipsize;
        // the count, step counter and ETA keep their reserved width, so an
        // over-long phase label in any locale never pushes them out of the meter.
        expect(toolbarSource).toMatch(
            /\.scan-cleanup-run-meter-phase\s*\{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*\}/,
        );
        expect(toolbarSource).toMatch(
            /\.scan-cleanup-run-meter-count,\s*\.scan-cleanup-run-meter-step,\s*\.scan-cleanup-run-meter-eta\s*\{[^}]*flex: none;[^}]*\}/,
        );
        expect(toolbarSource).toContain('width: 100%;');
        expect(toolbarSource).not.toContain('minmax(var(--app-scan-toolbar-right-zone-width), auto)');
        expect(previewShellStyleSource).toMatch(
            /\.preview-zoom-button\.is-active\s*\{[^}]*--app-toolbar-control-active-bg[^}]*\}/,
        );
        expect(previewShellStyleSource).not.toMatch(
            /\.preview-zoom-button\.is-active(?::hover[^\s{]*)?\s*\{[^}]*box-shadow/,
        );
        expect(previewShellStyleSource).toMatch(
            /\.preview-zoom-button\.is-fit-page\s*\{[^}]*border-start-end-radius:[^}]*border-end-end-radius:/,
        );
        expect(segmentedSource).toMatch(
            /\.scan-cleanup-segmented-option\.is-selected\s*\{[^}]*--app-control-active-bg[^}]*--app-control-active-border[^}]*\}/,
        );
        expect(segmentedSource).not.toMatch(
            /\.scan-cleanup-segmented-option\.is-selected\s*\{[^}]*--ui-primary/,
        );
        expect(previewShellStyleSource).toMatch(
            /\.preview-skeleton-page \.preview-skeleton-fill\s*\{[^}]*inset: 0;/,
        );
        expect(previewShellSource).toContain('<template #content>');
        expect(previewShellSource).toContain('class="preview-overlay-tooltip"');
        expect(previewShellSource).toContain(
            '<span v-if="matchPageSize"><i class="legend-swatch is-canvas"',
        );
        expect(toolbarSource).toContain(':text="detectionCancelLabel"');
        expect(toolbarSource).toContain(':aria-label="detectionCancelLabel"');
        expect(workspaceSource).toContain('waitingForDetection.value');
        expect(workspaceSource).toContain(':percent="meterPercent"');
    });

    it('keeps compact thumbnail controls and exclusion affordances visible', () => {
        const thumbnailRailSource = readSource(
            'app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue',
        );
        const compactRules = thumbnailRailSource.match(
            /@container \(width <= 10rem\) \{(?<rules>[\s\S]*)\n\}/u,
        )?.groups?.rules;

        expect(thumbnailRailSource).toContain('container-type: inline-size');
        expect(compactRules).toMatch(/\.scan-thumbnail-rail-header \{[\s\S]*?padding-inline/u);
        expect(compactRules).toMatch(/\.scan-thumbnail-rail-actions \{[\s\S]*?flex: 1/u);
        expect(compactRules).toMatch(
            /\.scan-thumbnail-actions \{[\s\S]*?padding: var\(--app-space-xs\)/u,
        );
        expect(thumbnailRailSource).toMatch(
            /\.scan-thumbnail-status \{[\s\S]*?text-overflow: ellipsis/u,
        );
        expect(thumbnailRailSource).toMatch(
            /data-document-thumbnail-item\]:hover\) \.scan-thumbnail-exclude-toggle/,
        );
    });
});
