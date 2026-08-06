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
    resolveScanCleanupPipelineMaxPixels,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    type IEffectiveNativeScanCleanupOptionsV3,
    type IScanCleanupExperimentalOptions,
    type TScanCleanupQualityPath,
} from '@scan-cleanup-core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@scan-cleanup-core/errors';
import {assertScanCleanupPathWithinRoot} from '@scan-cleanup-core/assertScanCleanupPathWithinRoot';

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
    allowedPathRoot?: string;
}

function clampNativeLimit(value: unknown, maximum: number, label: string) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ScanCleanupContractError(`${label} must be a number`);
    }
    return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function assertManifestPagePaths(
    page: IScanCleanupManifestPageInput,
    pageIndex: number,
    allowedPathRoot: string,
) {
    const pageLabel = `page ${String(pageIndex + 1)}`;
    assertScanCleanupPathWithinRoot(page.inputPath, allowedPathRoot, `${pageLabel} input path`);
    assertScanCleanupPathWithinRoot(page.pageMetadataPath, allowedPathRoot, `${pageLabel} metadata path`);
    for (const [
        label,
        path,
    ] of [
            [
                'trusted foreground mask path',
                page.trustedForegroundMaskPath,
            ],
            [
                'trusted MRC background path',
                page.trustedMrcBackgroundPath,
            ],
        ] as const) {
        if (path !== undefined) assertScanCleanupPathWithinRoot(path, allowedPathRoot, `${pageLabel} ${label}`);
    }
    for (const [
        outputIndex,
        output,
    ] of (page.outputs ?? []).entries()) {
        for (const [
            label,
            path,
        ] of [
                [
                    'output path',
                    output.outputPath,
                ],
                [
                    'metadata path',
                    output.metadataPath,
                ],
                [
                    'bilevel output path',
                    output.bilevelOutputPath,
                ],
                [
                    'background output path',
                    output.backgroundOutputPath,
                ],
                [
                    'foreground mask output path',
                    output.foregroundMaskOutputPath,
                ],
                [
                    'foreground alpha output path',
                    output.foregroundAlphaOutputPath,
                ],
                [
                    'picture mask output path',
                    output.pictureMaskOutputPath,
                ],
                [
                    'tone-preservation alpha output path',
                    output.tonePreservationAlphaOutputPath,
                ],
            ] as const) {
            if (path !== undefined) {
                assertScanCleanupPathWithinRoot(
                    path,
                    allowedPathRoot,
                    `${pageLabel} output ${String(outputIndex)} ${label}`,
                );
            }
        }
    }
    const detailRenderPlan = page.detailRenderPlan;
    if (detailRenderPlan !== undefined) {
        for (const [
            label,
            path,
        ] of [
                [
                    'detail base metadata path',
                    detailRenderPlan.baseMetadataPath,
                ],
                [
                    'detail base raster path',
                    detailRenderPlan.baseRasterPath,
                ],
                [
                    'detail base cleaned raster path',
                    detailRenderPlan.baseCleanedRasterPath,
                ],
            ] as const) {
            if (path !== undefined) assertScanCleanupPathWithinRoot(path, allowedPathRoot, `${pageLabel} ${label}`);
        }
    }
}

function assertManifestOutputContract(
    page: IScanCleanupManifestPageInput,
    pageIndex: number,
) {
    for (const [
        outputIndex,
        output,
    ] of (page.outputs ?? []).entries()) {
        const foregroundPlane = output.foregroundAlphaOutputPath !== undefined
            ? 'soft-alpha'
            : output.foregroundMaskOutputPath !== undefined
                ? 'soft-mask'
                : undefined;
        if (foregroundPlane !== undefined && output.backgroundOutputPath === undefined) {
            throw new ScanCleanupContractError(
                `page ${String(pageIndex + 1)} output ${String(outputIndex)} declares a ${foregroundPlane} plane without a base background image`,
            );
        }
    }
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
    allowedPathRoot,
}: IBuildNativeScanCleanupManifestInput): INativeScanCleanupManifestV3 {
    return {
        version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        operation,
        ...(analysisPurpose === undefined ? {} : {analysisPurpose}),
        renderMode,
        canvasScope,
        ...(documentCanvas === undefined ? {} : {documentCanvas}),
        ...(hostMemoryBytes !== undefined && hostMemoryBytes > 0 ? {hostMemoryBytes} : {}),
        pages: pages.map((page, pageIndex) => {
            assertManifestOutputContract(page, pageIndex);
            if (allowedPathRoot !== undefined) assertManifestPagePaths(page, pageIndex, allowedPathRoot);
            const resolvedOptions = {
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
            };
            const maxPixels = resolveScanCleanupPipelineMaxPixels(
                resolvedOptions.outputMode === 'auto' ? undefined : resolvedOptions.outputMode,
            );
            return {
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
                    ...resolvedOptions,
                    maxPixels: clampNativeLimit(resolvedOptions.maxPixels, maxPixels, 'maxPixels'),
                    maxDimensionPx: clampNativeLimit(
                        resolvedOptions.maxDimensionPx,
                        SCAN_CLEANUP_MAX_DIMENSION_PX,
                        'maxDimensionPx',
                    ),
                }),
                outputs: page.outputs ?? [],
                ...(page.documentPrior === undefined ? {} : {documentPrior: page.documentPrior}),
                ...(page.detailRenderPlan === undefined ? {} : {detailRenderPlan: page.detailRenderPlan}),
            };
        }),
    };
}
