import type {
    IScanCleanupOptions,
    IScanCleanupDocumentPrior,
    IScanCleanupPagePlanEvidence,
    IScanCleanupRawPreviewEvent,
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupOutputMode,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    scanCleanupLayoutSignature,
    scanCleanupMatchedCanvasOverridesSignature,
    toScanCleanupLayoutByPage,
} from '@contracts/scanCleanupPageOverrides';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {createScanCleanupPreviewPrefetcher} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPrefetcher';
import {
    createScanCleanupPreviewCache,
    SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR,
} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import type {TScanCleanupSelectionIntent} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

function normalizePreviewContentBox(
    metadata: IScanCleanupPreviewResult['outputs'][number]['metadata'],
) {
    const contentBox = metadata.contentBox;
    if (
        contentBox === null
        || metadata.inputWidthPx <= 0
        || metadata.inputHeightPx <= 0
        || metadata.sourceRegion.widthPx <= 0
        || metadata.sourceRegion.heightPx <= 0
    ) {
        return undefined;
    }
    const analysisWidth = metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270
        ? metadata.inputHeightPx
        : metadata.inputWidthPx;
    const analysisHeight = metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270
        ? metadata.inputWidthPx
        : metadata.inputHeightPx;
    // Native content boxes are local to their output's source region, while
    // normalized content overrides use the full rotated sheet as their scale.
    // Clip in local space, then divide by the full-sheet dimensions. Adding
    // sourceRegion.xPx here shifts a right-hand page by the cutter twice.
    const regionWidth = metadata.sourceRegion.widthPx;
    const regionHeight = metadata.sourceRegion.heightPx;
    const left = Math.max(0, Math.min(regionWidth, contentBox.xPx));
    const top = Math.max(0, Math.min(regionHeight, contentBox.yPx));
    const right = Math.max(
        left,
        Math.min(regionWidth, contentBox.xPx + contentBox.widthPx),
    );
    const bottom = Math.max(
        top,
        Math.min(regionHeight, contentBox.yPx + contentBox.heightPx),
    );
    if (right <= left || bottom <= top) {
        return undefined;
    }
    return {
        xNormalized: left / analysisWidth,
        yNormalized: top / analysisHeight,
        widthNormalized: (right - left) / analysisWidth,
        heightNormalized: (bottom - top) / analysisHeight,
        rotationDegrees: metadata.rotationDegrees,
    };
}

export function createScanCleanupPagePlanEvidence(
    previewResult: IScanCleanupPreviewResult,
): IScanCleanupPagePlanEvidence | undefined {
    const rotationDegrees = previewResult.pageMetadata.rotationDegrees;
    const analysisWidth = rotationDegrees === 90 || rotationDegrees === 270
        ? previewResult.rawHeightPx
        : previewResult.rawWidthPx;
    const cutterXPx = previewResult.pageMetadata.cutterXPx;
    const splitXNormalized = cutterXPx === null || analysisWidth <= 0
        ? undefined
        : cutterXPx / analysisWidth;
    const automaticSplit = splitXNormalized === undefined
        || splitXNormalized <= 0
        || splitXNormalized >= 1
        ? undefined
        : {
            xNormalized: splitXNormalized,
            rotationDegrees,
        };
    const outputs = Object.fromEntries(previewResult.outputs.flatMap(output => {
        const metadata = output.metadata;
        // A dewarp model is resolution-dependent and is not part of the
        // portable evidence yet. Re-analyze such pages instead of replaying
        // only half of their geometry.
        if (metadata.dewarpApplied === true) {
            return [];
        }
        const contentBox = normalizePreviewContentBox(metadata);
        const detectedSkewDegrees = metadata.manualSkew !== true
            && metadata.skewApplied === true
            && Number.isFinite(metadata.detectedSkewDegrees)
            ? metadata.detectedSkewDegrees
            : undefined;
        const textToneDiagnostics = metadata.textToneDiagnostics;
        if (
            contentBox === undefined
            && detectedSkewDegrees === undefined
            && textToneDiagnostics === undefined
        ) {
            return [];
        }
        return [[
            metadata.half,
            {
                ...(contentBox === undefined ? {} : {contentBox}),
                ...(detectedSkewDegrees === undefined ? {} : {detectedSkewDegrees}),
                ...(textToneDiagnostics === undefined ? {} : {textToneDiagnostics}),
            },
        ]];
    }));
    if (Object.keys(outputs).length === 0 && automaticSplit === undefined) {
        return undefined;
    }
    return {
        pageNumber: previewResult.pageNumber,
        rotationDegrees,
        layoutClassification: previewResult.pageMetadata.layoutClassification,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        outputs,
    };
}

/**
 * Longer than the ~400-500 ms cadence of a rail flick measured in the user's
 * recording, so a burst of navigations coalesces into the page it ends on,
 * and only ever applied while a preview is already rendering.
 */
const SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS = 600;
// How many times a page may re-ask for a preview that answered `canceled`
// before it stops. Two covers losing the run to a supersede and then to the
// prefetch drop behind it; beyond that something is wrong that retrying will
// not fix.
const PREVIEW_CANCELLATION_RETRY_LIMIT = 2;

interface IUseScanCleanupPreviewSessionOptions {
    active: () => boolean;
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
    documentRevision: ComputedRef<string>;
    documentPriorByPage: ReadonlyMap<number, IScanCleanupDocumentPrior>;
    initialViewMode?: 'original' | 'cleaned' | undefined;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    previewPage: Ref<number>;
    resolvedOptions?: ComputedRef<IScanCleanupOptions>;
    recommendedOutputModeByPage: ReadonlyMap<number, TScanCleanupOutputMode>;
    softAlphaForegroundRecommendationByPage: ReadonlyMap<number, boolean>;
    selectPage: (page: number, intent: TScanCleanupSelectionIntent, orderedPages: readonly number[]) => void;
    settings: IScanCleanupOptions;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
}

export function createScanCleanupPreviewCacheKey(
    pageNumber: number,
    previewOptions: IScanCleanupOptions,
    previewSourcePath: TDocumentRef | null,
    documentRevision: string | null = null,
    documentPrior: IScanCleanupDocumentPrior | null = null,
    // Already reduced by scanCleanupLayoutSignature: a cache key is asked for
    // once per page on every schedule and every prefetch candidate, and
    // reducing the whole document's layouts inside each of those turns one
    // navigation into a pass over every page of the document, repeatedly.
    layoutSignature = '',
    // Likewise already reduced, by scanCleanupMatchedCanvasOverridesSignature.
    // This one cannot be derived here at all: `previewOptions` carries only the
    // keyed page's override, and the canvas is measured from every page's.
    matchedCanvasOverridesSignature = '',
    // Detection can settle after the first visible preview has already
    // started. It revalidates the one cached entry owned by this page.
    outputModeRecommendation: TScanCleanupOutputMode | null = null,
    softAlphaForegroundRecommendation: boolean | null = null,
) {
    const pageOverride = getScanCleanupPageOverride(previewOptions.pageOverrides, pageNumber);
    // Detection's contribution is keyed separately from the page's identity: it
    // lands for the whole document at once, and the cache revalidates an entry
    // against it instead of orphaning it. The matched canvas belongs here too:
    // the main process measures it from the document's geometry, from these
    // layouts and from every page's own overrides, so a detection pass that
    // changes which pages are spreads — or an exclusion, a layout choice, a
    // manual split or an output mode set on some other page — changes the
    // rectangle every page was drawn on.
    const validity = JSON.stringify({
        documentPrior,
        outputModeRecommendation,
        softAlphaForegroundRecommendation,
        layouts: previewOptions.matchPageSize ? layoutSignature : '',
        canvasOverrides: previewOptions.matchPageSize ? matchedCanvasOverridesSignature : '',
    });
    const identity = JSON.stringify({
        sourcePath: previewSourcePath,
        documentRevision,
        page: pageNumber,
        documentOptions: {
            preserveOriginalQuality: previewOptions.preserveOriginalQuality === true,
            layoutMode: previewOptions.layoutMode,
            outputMode: previewOptions.outputMode,
            binarization: previewOptions.binarization ?? 'auto',
            normalizeIllumination: previewOptions.normalizeIllumination ?? true,
            thickness: previewOptions.thickness,
            crop: previewOptions.crop,
            matchPageSize: previewOptions.matchPageSize,
            pageAlignment: previewOptions.pageAlignment,
            marginsMm: previewOptions.marginsMm,
            despeckleLevel: previewOptions.despeckleLevel
                ?? ((previewOptions.despeckle ?? true) ? 'normal' : 'off'),
            autoDewarp: previewOptions.autoDewarp ?? false,
            autoDewarpDepth: previewOptions.autoDewarpDepth,
            readingOrder: previewOptions.readingOrder,
            skipBlankPages: previewOptions.skipBlankPages,
        },
        pageOverride: {
            rotationDegrees: pageOverride.rotationDegrees,
            layoutOverride: pageOverride.layoutOverride,
            excluded: pageOverride.excluded,
            manualSplit: pageOverride.manualSplit,
            manualSkewDegrees: pageOverride.manualSkewDegrees,
            manualContentBoxes: pageOverride.manualContentBoxes ?? {},
            manualZones: pageOverride.manualZones ?? {
                picture: [],
                fill: [],
            },
            outputModeOverride: pageOverride.outputModeOverride,
            marginsMm: pageOverride.marginsMm,
        },
    });
    return `${identity}${SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR}${validity}`;
}

export function createScanCleanupDetailTileCacheKey(
    sourceKey: string,
    viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
) {
    return JSON.stringify({
        sourceKey,
        viewports: {
            ...(viewports.full === undefined ? {} : {full: viewports.full}),
            ...(viewports.left === undefined ? {} : {left: viewports.left}),
            ...(viewports.right === undefined ? {} : {right: viewports.right}),
        },
    });
}

function isCanceledPreview(value: TScanCleanupPreviewWireResult): value is {canceled: true} {
    return value.canceled === true;
}

function carriesRaster(value: TScanCleanupPreviewWireResult): value is IScanCleanupPreviewResult {
    return !isCanceledPreview(value) && value.rawImageData !== undefined;
}

export const useScanCleanupPreviewSession = (options: IUseScanCleanupPreviewSessionOptions) => {
    const {t} = useTypedI18n();
    const result = shallowRef<IScanCleanupPreviewResult | null>(null);
    const rawResult = shallowRef<IScanCleanupRawPreviewResult | null>(null);
    const resultKey = shallowRef<string | null>(null);
    const detailResult = shallowRef<IScanCleanupPreviewResult | null>(null);
    const detailLoading = ref(false);
    const loading = ref(false);
    const error = ref('');
    const viewMode = ref<'original' | 'cleaned'>(options.initialViewMode ?? 'cleaned');
    const cache = createScanCleanupPreviewCache();
    const detailSourceCache = createScanCleanupPreviewCache({
        maxEntries: 4,
        maxBytes: 48 * 1024 * 1024,
    });
    const metadataByPage = reactive(new Map<number, IScanCleanupPreviewResult['pageMetadata']>());
    let sequence = 0;
    let detailSequence = 0;
    let displayedDetailSourceKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let detailRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let detailRetriesRemaining = 0;
    let scheduledPage: number | null = null;
    let scheduledKey: string | null = null;
    let cancellationRetryKey: string | null = null;
    let cancellationRetries = 0;
    let requestNonce = 0;
    let activeVisibleRequestId: string | null = null;
    const inFlightPreviewPages: number[] = [];
    const inFlightPreviewRequestIds = new Set<string>();
    // A base preview pushes its page's raster the moment it exists and leaves
    // it out of the result it resolves with, so the bytes cross once. They wait
    // here for the result they belong to — which two callers can share, when a
    // navigation adopts a prefetch — and the window covers the visible page,
    // its two neighbours and the one still rendering. A retained entry is the
    // same buffer the cached result holds, so it costs nothing while that page
    // is cached.
    const streamedRawByRequest = new Map<string, IScanCleanupRawPreviewEvent>();
    const STREAMED_RAW_PAGES_MAX = 4;

    function retainedRawForPage(pageNumber: number) {
        return [...streamedRawByRequest.values()]
            .reverse()
            .find(raw => raw.pageNumber === pageNumber);
    }

    function trimStreamedRaw() {
        while (streamedRawByRequest.size > STREAMED_RAW_PAGES_MAX) {
            const evictable = [...streamedRawByRequest.keys()].find(requestId => (
                !inFlightPreviewRequestIds.has(requestId)
                && requestId !== activeVisibleRequestId
            ));
            if (evictable === undefined) break;
            streamedRawByRequest.delete(evictable);
        }
    }

    const totalPages = computed(() => rawResult.value?.totalPages
        ?? result.value?.totalPages
        ?? Math.max(1, options.totalPages.value));
    const resolvedOptions = options.resolvedOptions
        ?? computed(() => toPlainScanCleanupOptions(options.settings));
    const resultCurrent = computed(() => result.value !== null && resultKey.value === cacheKey());
    const classificationDiffersByPage = computed<ReadonlyMap<number, boolean>>(() => {
        const differences = new Map<number, boolean>();
        for (const [
            pageNumber,
            metadata,
        ] of metadataByPage) {
            const authoritative = options.authoritativeLayoutByPage.value.get(pageNumber);
            if (authoritative !== undefined && authoritative !== metadata.layoutClassification) {
                differences.set(pageNumber, true);
            }
        }
        return differences;
    });
    const prefetcher = createScanCleanupPreviewPrefetcher<IScanCleanupPreviewRequest, IScanCleanupPreviewResult>({
        isCached: key => cache.has(key),
        preview: request => {
            const capability = getScanCleanupCapability();
            if (!capability) {
                return Promise.reject(new Error('Scan cleanup preview is unavailable'));
            }
            inFlightPreviewRequestIds.add(request.requestId);
            return capability.preview(toBridgeSafeScanCleanupPayload(request))
                .then(previewResult => withStreamedRaw(previewResult, request.requestId))
                .finally(() => {
                    inFlightPreviewRequestIds.delete(request.requestId);
                    trimStreamedRaw();
                });
        },
        store: cachePreview,
    });

    function acceptStreamedRaw(raw: IScanCleanupRawPreviewEvent) {
        if (raw.ownerId !== options.ownerId || raw.documentRevision !== options.documentRevision.value) {
            return;
        }
        streamedRawByRequest.delete(raw.requestId);
        streamedRawByRequest.set(raw.requestId, raw);
        trimStreamedRaw();
        // The raw page is shown while its cleanup runs, so it becomes the
        // displayed raster as soon as it lands — but only for the page the user
        // is actually on. A prefetched neighbour just waits for its result.
        if (raw.pageNumber === options.previewPage.value) {
            rawResult.value = raw;
        }
    }

    /**
     * Puts the streamed raster back on the result it was rendered from. A
     * detail tile reuses the already-held base raster locally. A cancelled
     * request has no result at all and answers with null.
     */
    function withStreamedRaw(
        previewResult: TScanCleanupPreviewWireResult,
        requestId: string,
    ): IScanCleanupPreviewResult | null {
        if (isCanceledPreview(previewResult)) {
            return null;
        }
        if (carriesRaster(previewResult)) {
            return previewResult;
        }
        // Detail tiles no longer echo the raw PNG. The page number is the
        // inexpensive identity tying them to the base raster already held by
        // this session; revision ownership was checked when that raster event
        // was accepted.
        const heldBase = rawResult.value?.pageNumber === previewResult.pageNumber
            ? rawResult.value
            : result.value?.pageNumber === previewResult.pageNumber
                ? result.value
                : undefined;
        const streamed = streamedRawByRequest.get(previewResult.requestId ?? requestId)
            ?? retainedRawForPage(previewResult.pageNumber)
            ?? heldBase;
        if (!streamed) throw new Error('Scan cleanup preview arrived without its page raster');
        return {
            ...previewResult,
            rawImageData: streamed.rawImageData,
        };
    }

    function cacheKey(
        pageNumber = options.previewPage.value,
        previewOptions = resolvedOptions.value,
        previewSourcePath = options.sourcePath.value,
    ) {
        const pageOverride = getScanCleanupPageOverride(previewOptions.pageOverrides, pageNumber);
        return createScanCleanupPreviewCacheKey(
            pageNumber,
            {
                ...previewOptions,
                pageOverrides: {[String(pageNumber)]: {
                    ...pageOverride,
                    placementOverrides: {},
                }},
            },
            previewSourcePath,
            options.documentRevision.value,
            options.documentPriorByPage.get(pageNumber) ?? null,
            layoutSignature.value,
            matchedCanvasOverridesSignature.value,
            resolveOutputModeRecommendation(pageNumber) ?? null,
            resolveSoftAlphaForegroundRecommendation(pageNumber) ?? null,
        );
    }

    // The layouts the main process measures the matched canvas from. They are
    // the renderer's own view of the document — the detection the user watched
    // run, plus their manual layout choices — so the preview it draws and the
    // run it starts are measured against the same document.
    //
    // Both are derived once per change of that view rather than once per
    // request: every preview, prefetch candidate and cache key of a burst reads
    // the same record and the same signature.
    const layoutByPage = computed(() => toScanCleanupLayoutByPage(options.authoritativeLayoutByPage.value));
    const layoutSignature = computed(() => scanCleanupLayoutSignature(layoutByPage.value));
    // The other half of what the canvas is measured from: the page overrides of
    // the whole document, which a single page's cache key cannot see. Derived
    // once per settings change for the same reason — a burst reads it, it does
    // not recompute it.
    const matchedCanvasOverridesSignature = computed(
        () => scanCleanupMatchedCanvasOverridesSignature(options.settings.pageOverrides),
    );

    function resolveOutputModeRecommendation(pageNumber: number) {
        const pageOverride = getScanCleanupPageOverride(options.settings.pageOverrides, pageNumber);
        if (
            options.settings.preserveOriginalQuality
            || options.settings.outputMode !== 'auto'
            || pageOverride.outputModeOverride !== undefined
        ) {
            return undefined;
        }
        return resolveScanCleanupEffectiveOutputMode({
            options: options.settings,
            pageOverride,
            detectedOutputMode: options.recommendedOutputModeByPage.get(pageNumber),
        });
    }

    function resolveSoftAlphaForegroundRecommendation(pageNumber: number) {
        return resolveOutputModeRecommendation(pageNumber) === 'mixed'
            ? options.softAlphaForegroundRecommendationByPage.get(pageNumber)
            : undefined;
    }

    function nextRequestId(key: string) {
        requestNonce += 1;
        return `${options.ownerId}:${requestNonce}:${key}`;
    }

    function cachePreview(key: string, previewResult: IScanCleanupPreviewResult) {
        cache.set(key, previewResult);
        metadataByPage.set(previewResult.pageNumber, previewResult.pageMetadata);
    }

    function resolvePagePlanEvidence(pageNumbers: readonly number[]) {
        const evidence = new Map<number, IScanCleanupPagePlanEvidence>();
        const previewOptions = resolvedOptions.value;
        for (const pageNumber of pageNumbers) {
            const cached = cache.get(cacheKey(pageNumber, previewOptions));
            if (!cached) continue;
            const pagePlan = createScanCleanupPagePlanEvidence(cached);
            if (pagePlan !== undefined) evidence.set(pageNumber, pagePlan);
        }
        return evidence;
    }

    function clearTimer() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }

    function clearDetailRetry() {
        if (detailRetryTimer !== null) clearTimeout(detailRetryTimer);
        detailRetryTimer = null;
    }

    function invalidateDetailRequest() {
        detailSequence += 1;
        clearDetailRetry();
        detailRetriesRemaining = 0;
        detailLoading.value = false;
    }

    function clearDetail() {
        invalidateDetailRequest();
        detailResult.value = null;
        displayedDetailSourceKey = null;
    }

    function cancel(invalidateRawCache = true) {
        sequence += 1;
        prefetcher.supersede();
        clearTimer();
        invalidateDetailRequest();
        // Every request a streamed raster could still belong to is superseded.
        streamedRawByRequest.clear();
        inFlightPreviewRequestIds.clear();
        activeVisibleRequestId = null;
        loading.value = false;
        if (!options.sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        void capability.cancelPreview({
            sourcePdfPath: options.sourcePath.value,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            invalidateRawCache,
        }).catch(() => undefined);
    }

    function scheduleAdjacentPrefetch(
        previewResult: IScanCleanupPreviewResult,
        previewOptions: IScanCleanupOptions,
        previewSourcePath: string,
    ) {
        const adjacentPages = [
            previewResult.pageNumber + 1,
            previewResult.pageNumber - 1,
        ]
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= previewResult.totalPages);
        prefetcher.schedule(adjacentPages.map(pageNumber => {
            const documentPrior = options.documentPriorByPage.get(pageNumber);
            const outputModeRecommendation = resolveOutputModeRecommendation(pageNumber);
            const softAlphaForegroundRecommendation =
                resolveSoftAlphaForegroundRecommendation(pageNumber);
            const key = cacheKey(pageNumber, previewOptions, previewSourcePath);
            return {
                key,
                request: {
                    requestId: nextRequestId(key),
                    sourcePdfPath: previewSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber,
                    options: previewOptions,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(outputModeRecommendation === undefined
                        ? {}
                        : {outputModeRecommendation}),
                    ...(softAlphaForegroundRecommendation === undefined
                        ? {}
                        : {softAlphaForegroundRecommendation}),
                    layoutByPage: layoutByPage.value,
                },
            };
        }));
    }

    function schedule() {
        // Base-preview identity owns detail identity. Invalidate detail work
        // before the availability guard so source removal/deactivation cannot
        // leave a retry or an older viewport render alive.
        invalidateDetailRequest();
        if (!options.active() || !options.sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            error.value = t('scanCleanup.preview.unavailable');
            return;
        }
        const requestSequence = ++sequence;
        clearTimer();
        const requestPage = options.previewPage.value;
        const requestOptions = resolvedOptions.value;
        const requestSourcePath = options.sourcePath.value;
        const documentPrior = options.documentPriorByPage.get(requestPage);
        const outputModeRecommendation = resolveOutputModeRecommendation(requestPage);
        const softAlphaForegroundRecommendation =
            resolveSoftAlphaForegroundRecommendation(requestPage);
        const key = cacheKey(requestPage, requestOptions, requestSourcePath);
        const requestId = nextRequestId(key);
        activeVisibleRequestId = requestId;
        const retainedRaw = retainedRawForPage(requestPage);
        if (retainedRaw) rawResult.value = retainedRaw;
        const initialRequest = scheduledPage === null;
        // A navigation reaches the previous page's key unchanged; anything else
        // — a settings change, a new document prior, another source — makes
        // every page's work stale and keeps no window.
        const navigated = scheduledPage !== null
            && scheduledKey === cacheKey(scheduledPage, requestOptions, requestSourcePath);
        // Turning to another page starts a new attempt at whatever page the
        // user lands on, including the one that gave up earlier.
        if (scheduledPage !== requestPage) {
            cancellationRetryKey = null;
            cancellationRetries = 0;
        }
        scheduledPage = requestPage;
        scheduledKey = key;
        const activeDetailOutputMode = resolveDetailOutputMode(requestPage);
        const activeDetailSourceKey = activeDetailOutputMode === undefined
            ? null
            : detailSourceKey(key, activeDetailOutputMode);
        if (displayedDetailSourceKey !== activeDetailSourceKey) {
            detailResult.value = null;
            displayedDetailSourceKey = null;
        }
        // Look the page up before cancelling anything: a navigation that the
        // cache can answer has no reason to disturb work in flight at all.
        const cached = cache.get(key);
        if (!navigated) prefetcher.supersede();
        void capability.cancelPreview({
            sourcePdfPath: requestSourcePath,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            invalidateRawCache: false,
            // The page being opened, its neighbours, and the page still
            // rendering: the adjacent prefetch of the page the user is about to
            // reach used to be the first casualty of reaching it. Only the most
            // recent render is held, so a sustained walk retires the older one
            // instead of accumulating pipelines. Anything that is not a
            // navigation names no window and cancels the document, as before.
            ...(navigated
                ? {retainPages: [...new Set([
                    ...inFlightPreviewPages.slice(-1),
                    requestPage - 1,
                    requestPage,
                    requestPage + 1,
                ])].filter(pageNumber => pageNumber >= 1 && pageNumber <= totalPages.value)}
                : {}),
        }).catch(() => undefined);
        if (cached) {
            result.value = cached;
            rawResult.value = cached;
            resultKey.value = key;
            loading.value = false;
            error.value = '';
            scheduleAdjacentPrefetch(cached, requestOptions, requestSourcePath);
            return;
        }
        loading.value = true;
        error.value = '';
        const runPreview = async () => {
            timer = null;
            try {
                // One request per page switch. Its raw raster arrives over
                // `onPreviewRaw` a sidecar run ahead of the cleaned outputs and
                // is displayed there; this promise settles with the cleaned
                // result that supersedes it.
                const previewResult = withStreamedRaw(await capability.preview(toBridgeSafeScanCleanupPayload({
                    requestId,
                    sourcePdfPath: requestSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber: requestPage,
                    options: requestOptions,
                    visible: true,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(outputModeRecommendation === undefined
                        ? {}
                        : {outputModeRecommendation}),
                    ...(softAlphaForegroundRecommendation === undefined
                        ? {}
                        : {softAlphaForegroundRecommendation}),
                    layoutByPage: layoutByPage.value,
                })), requestId);
                // A cancelled request has no result to keep or display. When the
                // page it was rendering is still the page the user is on, the
                // run was retired by something that has since finished — a
                // superseded generation, a prefetch whose lease was dropped —
                // so the page is asked for again instead of being left on a
                // spinner that nothing will ever answer. The budget is per key,
                // so a page that keeps losing its run stops rather than looping.
                if (previewResult === null) {
                    if (requestSequence === sequence) {
                        if (cancellationRetryKey !== key) {
                            cancellationRetryKey = key;
                            cancellationRetries = 0;
                        }
                        if (cancellationRetries < PREVIEW_CANCELLATION_RETRY_LIMIT) {
                            cancellationRetries += 1;
                            timer = setTimeout(schedule, 0);
                            return;
                        }
                        // Out of budget. Saying so puts the page on the same
                        // recoverable footing a failed render has — the error
                        // surface carries a Retry — instead of leaving a blank
                        // frame that nothing will ever fill.
                        error.value = t('scanCleanup.preview.canceledRepeatedly');
                    }
                    return;
                }
                cancellationRetryKey = null;
                // Cached before the staleness check: the key names the page and
                // the options that produced this result, so a preview that
                // outlived the navigation that asked for it is still exactly
                // what the next visit to that page needs.
                cachePreview(key, previewResult);
                if (requestSequence !== sequence) {
                    return;
                }
                result.value = previewResult;
                resultKey.value = key;
                scheduleAdjacentPrefetch(previewResult, requestOptions, requestSourcePath);
            } catch (caught) {
                if (requestSequence !== sequence || (caught instanceof Error && caught.name === 'AbortError')) {
                    return;
                }
                error.value = caught instanceof Error ? caught.message : t('scanCleanup.preview.unavailable');
            } finally {
                if (requestSequence === sequence) loading.value = false;
            }
        };
        // A deliberate page turn goes straight through: nothing is rendering, so
        // waiting would only delay the page. A turn made while a page is still
        // rendering is a burst — every navigation restarts this timer, so a
        // flick issues one request for the page it stops on instead of one per
        // page it passes. Everything else is an options change and keeps the
        // settled debounce it has always had.
        const requestDelayMs = initialRequest
            ? 0
            : navigated
                ? (inFlightPreviewPages.length === 0 ? 0 : SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS)
                : 250;
        timer = setTimeout(() => {
            inFlightPreviewPages.push(requestPage);
            inFlightPreviewRequestIds.add(requestId);
            void runPreview().finally(() => {
                const index = inFlightPreviewPages.indexOf(requestPage);
                if (index >= 0) inFlightPreviewPages.splice(index, 1);
                inFlightPreviewRequestIds.delete(requestId);
                trimStreamedRaw();
            });
        }, requestDelayMs);
    }

    function resolveDetailOutputMode(pageNumber = options.previewPage.value) {
        const pageOverride = getScanCleanupPageOverride(options.settings.pageOverrides, pageNumber);
        const renderedOutputMode = result.value?.pageNumber === pageNumber
            ? result.value.outputs[0]?.metadata.outputMode
                ?? result.value.pageMetadata.recommendedOutputMode
            : undefined;
        return resolveScanCleanupEffectiveOutputMode({
            options: options.settings,
            pageOverride,
            detectedOutputMode: options.recommendedOutputModeByPage.get(pageNumber),
            renderedOutputMode,
        });
    }

    function detailSourceKey(baseKey: string, outputMode: ReturnType<typeof resolveDetailOutputMode>) {
        return JSON.stringify({
            baseKey,
            outputMode,
        });
    }

    function scheduleDetailRetry(
        viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
        requestSequence: number,
    ) {
        if (requestSequence !== detailSequence || detailRetriesRemaining <= 0) {
            return;
        }
        detailRetriesRemaining -= 1;
        detailRetryTimer = setTimeout(() => {
            detailRetryTimer = null;
            void requestDetail(viewports, true);
        }, 1_000);
    }

    async function requestDetail(
        viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
        isRetry = false,
    ) {
        if (
            !options.active()
            || !options.sourcePath.value
            || options.settings.preserveOriginalQuality
            || !resultCurrent.value
        ) {
            return;
        }
        if (!isRetry) {
            clearDetailRetry();
            detailRetriesRemaining = 2;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        prefetcher.supersede();
        const requestPage = options.previewPage.value;
        const requestOptions = resolvedOptions.value;
        const requestSourcePath = options.sourcePath.value;
        const outputMode = resolveDetailOutputMode(requestPage);
        if (outputMode === undefined) {
            detailLoading.value = false;
            return;
        }
        const baseKey = cacheKey(requestPage, requestOptions, requestSourcePath);
        const sourceKey = detailSourceKey(baseKey, outputMode);
        const tileKey = createScanCleanupDetailTileCacheKey(sourceKey, viewports);
        const requestSequence = ++detailSequence;
        const cached = detailSourceCache.get(tileKey);
        if (cached) {
            detailResult.value = cached;
            displayedDetailSourceKey = sourceKey;
            detailLoading.value = false;
            return;
        }
        detailResult.value = null;
        displayedDetailSourceKey = null;
        detailLoading.value = true;
        try {
            const documentPrior = options.documentPriorByPage.get(requestPage);
            const softAlphaForegroundRecommendation =
                options.softAlphaForegroundRecommendationByPage.get(requestPage);
            const requestId = nextRequestId(tileKey);
            const next = withStreamedRaw(await capability.preview(toBridgeSafeScanCleanupPayload({
                requestId,
                sourcePdfPath: requestSourcePath,
                ownerId: options.ownerId,
                documentRevision: options.documentRevision.value,
                pageNumber: requestPage,
                options: requestOptions,
                ...(documentPrior === undefined ? {} : {documentPrior}),
                ...(softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {softAlphaForegroundRecommendation}),
                layoutByPage: layoutByPage.value,
                detail: {
                    viewports,
                    outputMode,
                },
            })), requestId);
            if (requestSequence !== detailSequence || baseKey !== cacheKey()) {
                return;
            }
            // A cancelled tile has no result; the viewport is stationary, so it
            // takes the same bounded retry a failed one does rather than
            // waiting for a gesture that is not coming.
            if (next === null) {
                scheduleDetailRetry(viewports, requestSequence);
                return;
            }
            detailSourceCache.set(tileKey, next);
            detailResult.value = next;
            displayedDetailSourceKey = sourceKey;
        } catch (caught) {
            if (
                caught instanceof Error
                && caught.message.startsWith('Scan cleanup detail geometry is unavailable')
            ) {
                cache.delete(baseKey);
                schedule();
                return;
            }
            // A failed detail render retries on its own: the viewport is
            // stationary, so no user gesture would otherwise re-request it.
            if (!(caught instanceof Error && caught.name === 'AbortError')) {
                scheduleDetailRetry(viewports, requestSequence);
            }
        } finally {
            if (requestSequence === detailSequence) {
                detailLoading.value = false;
            }
        }
    }

    function retry() {
        // The user asking again is a fresh start: the budget that gave up is
        // theirs to spend again.
        cancellationRetryKey = null;
        cancellationRetries = 0;
        cache.delete(cacheKey(options.previewPage.value));
        schedule();
    }

    function navigate(delta: number) {
        const page = Math.min(totalPages.value, Math.max(1, options.previewPage.value + delta));
        options.selectPage(page, 'single', Array.from({length: totalPages.value}, (_, index) => index + 1));
    }

    const stopRawStream = getScanCleanupCapability()?.onPreviewRaw(acceptStreamedRaw) ?? null;

    watch(options.active, active => {
        if (active) schedule();
        else cancel();
    }, {immediate: true});
    watch(options.lifecycleDocumentKey, () => {
        invalidateDetailRequest();
        cancellationRetryKey = null;
        cancellationRetries = 0;
        error.value = '';
        cache.clear();
        detailSourceCache.clear();
        metadataByPage.clear();
        streamedRawByRequest.clear();
        inFlightPreviewRequestIds.clear();
        activeVisibleRequestId = null;
        result.value = null;
        rawResult.value = null;
        resultKey.value = null;
        detailResult.value = null;
        displayedDetailSourceKey = null;
    });
    watch(cacheKey, schedule);
    onBeforeUnmount(() => {
        stopRawStream?.();
        cancel();
    });

    return {
        cancel,
        classificationDiffersByPage,
        clearDetail,
        error,
        detailLoading,
        detailResult,
        loading,
        metadataByPage,
        navigate,
        result,
        rawResult,
        resultCurrent,
        retry,
        requestDetail,
        resolvePagePlanEvidence,
        schedule,
        totalPages,
        viewMode,
    };
};
