import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupOutputV3,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    resolveEffectiveScanCleanupOptions,
    type IEffectiveNativeScanCleanupOptionsV3,
    type IScanCleanupExperimentalOptions,
    type TScanCleanupQualityPath,
} from '@scan-cleanup-core/policy/effectiveOptions';

export interface IScanCleanupManifestPageInput {
    inputPath: string;
    trustedForegroundMaskPath?: string;
    trustedMrcBackgroundPath?: string;
    pageNumber: number;
    dpi: number;
    sourceDpi?: number;
    sourceHasBilevelLayer?: boolean;
    sourceBackgroundDpi?: number;
    requestedRenderDpi?: number;
    renderCrop?: INativeScanCleanupManifestV3['pages'][number]['options']['renderCrop'];
    resolvedOutputMode?: TScanCleanupOutputMode;
    preferSoftAlphaForeground?: boolean;
    resolvedTextToneDiagnostics?: INativeScanCleanupManifestV3['pages'][number]['options']['resolvedTextToneDiagnostics'];
    observedLayout?: TScanCleanupLayoutClassification;
    automaticSplit?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticSplit'];
    automaticContentBoxes?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticContentBoxes'];
    automaticSkewDegrees?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticSkewDegrees'];
    /** Trusted replay values supplied by a core consumer such as the corpus harness. */
    resolvedOptions?: Partial<IEffectiveNativeScanCleanupOptionsV3>;
    pageMetadataPath: string;
    outputs?: INativeScanCleanupOutputV3[];
    documentPrior?: IScanCleanupDocumentPrior;
    detailRenderPlan?: INativeScanCleanupManifestV3['pages'][number]['detailRenderPlan'];
}

export interface IBuildNativeScanCleanupManifestInput {
    operation: TNativeScanCleanupOperation;
    analysisPurpose?: INativeScanCleanupManifestV3['analysisPurpose'];
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    qualityPath: TScanCleanupQualityPath;
    options: IScanCleanupOptions;
    pages: IScanCleanupManifestPageInput[];
    documentCanvas?: IScanCleanupDocumentCanvasPlan;
    experimental?: IScanCleanupExperimentalOptions;
    hostMemoryBytes?: number;
}

export function serializeNativeScanCleanupOptions(
    options: IEffectiveNativeScanCleanupOptionsV3,
): INativeScanCleanupManifestV3['pages'][number]['options'] {
    const {
        despeckleLevel,
        manualZones,
        ...baselineOptions
    } = options;
    const derivedDespeckleLevel = options.despeckle ? 'normal' : 'off';
    const hasManualZones = manualZones.picture.length > 0 || manualZones.fill.length > 0;
    return {
        ...baselineOptions,
        ...(despeckleLevel === derivedDespeckleLevel ? {} : {despeckleLevel}),
        ...(hasManualZones ? {manualZones} : {}),
    };
}

export function buildNativeScanCleanupManifest({
    operation,
    analysisPurpose,
    renderMode,
    canvasScope,
    qualityPath,
    options,
    pages,
    documentCanvas,
    experimental,
    hostMemoryBytes,
}: IBuildNativeScanCleanupManifestInput): INativeScanCleanupManifestV3 {
    return {
        version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        operation,
        ...(analysisPurpose === undefined ? {} : {analysisPurpose}),
        renderMode,
        canvasScope,
        ...(documentCanvas === undefined ? {} : {documentCanvas}),
        ...(hostMemoryBytes !== undefined && hostMemoryBytes > 0 ? {hostMemoryBytes} : {}),
        pages: pages.map(page => ({
            inputPath: page.inputPath,
            ...(page.trustedForegroundMaskPath === undefined
                ? {}
                : {trustedForegroundMaskPath: page.trustedForegroundMaskPath}),
            ...(page.trustedMrcBackgroundPath === undefined
                ? {}
                : {trustedMrcBackgroundPath: page.trustedMrcBackgroundPath}),
            sourcePageIndex: page.pageNumber - 1,
            pageMetadataPath: page.pageMetadataPath,
            options: serializeNativeScanCleanupOptions({
                ...resolveEffectiveScanCleanupOptions({
                    options,
                    pageOverride: getScanCleanupPageOverride(options.pageOverrides, page.pageNumber),
                    dpi: page.dpi,
                    ...(page.sourceDpi === undefined ? {} : {sourceDpi: page.sourceDpi}),
                    ...(page.sourceHasBilevelLayer === undefined
                        ? {}
                        : {sourceHasBilevelLayer: page.sourceHasBilevelLayer}),
                    ...(page.sourceBackgroundDpi === undefined
                        ? {}
                        : {sourceBackgroundDpi: page.sourceBackgroundDpi}),
                    ...(page.requestedRenderDpi === undefined
                        ? {}
                        : {requestedRenderDpi: page.requestedRenderDpi}),
                    ...(page.renderCrop === undefined ? {} : {renderCrop: page.renderCrop}),
                    ...(page.resolvedOutputMode === undefined
                        ? {}
                        : {resolvedOutputMode: page.resolvedOutputMode}),
                    ...(page.preferSoftAlphaForeground === undefined
                        ? {}
                        : {preferSoftAlphaForeground: page.preferSoftAlphaForeground}),
                    ...(page.resolvedTextToneDiagnostics === undefined
                        ? {}
                        : {resolvedTextToneDiagnostics: page.resolvedTextToneDiagnostics}),
                    ...(page.observedLayout === undefined
                        ? {}
                        : {observedLayout: page.observedLayout}),
                    ...(page.automaticSplit === undefined
                        ? {}
                        : {automaticSplit: page.automaticSplit}),
                    ...(page.automaticContentBoxes === undefined
                        ? {}
                        : {automaticContentBoxes: page.automaticContentBoxes}),
                    ...(page.automaticSkewDegrees === undefined
                        ? {}
                        : {automaticSkewDegrees: page.automaticSkewDegrees}),
                    qualityPath,
                    ...(experimental === undefined ? {} : {experimental}),
                }),
                ...(page.resolvedOptions ?? {}),
            }),
            outputs: page.outputs ?? [],
            ...(page.documentPrior === undefined ? {} : {documentPrior: page.documentPrior}),
            ...(page.detailRenderPlan === undefined ? {} : {detailRenderPlan: page.detailRenderPlan}),
        })),
    };
}
