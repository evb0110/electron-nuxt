import type {
    IScanCleanupOptions,
    IScanCleanupDocumentPrior,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupRawPreviewEvent,
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
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

/**
 * Longer than the ~400-500 ms cadence of a rail flick measured in the user's
 * recording, so a burst of navigations coalesces into the page it ends on,
 * and only ever applied while a preview is already rendering.
 */
const SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS = 600;

interface IUseScanCleanupPreviewSessionOptions {
    active: () => boolean;
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
    documentRevision: ComputedRef<string>;
    documentPriorByPage: ReadonlyMap<number, IScanCleanupDocumentPrior>;
    documentCanvasPlan: ComputedRef<IScanCleanupDocumentCanvasPlan | undefined>;
    initialViewMode?: 'original' | 'cleaned' | undefined;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    previewPage: Ref<number>;
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
    documentCanvasPlan: IScanCleanupDocumentCanvasPlan | null = null,
) {
    const pageOverride = getScanCleanupPageOverride(previewOptions.pageOverrides, pageNumber);
    // Detection's contribution is keyed separately from the page's identity: it
    // lands for the whole document at once, and the cache revalidates an entry
    // against it instead of orphaning it. The plan reaches the sidecar only
    // under matchPageSize (createScanCleanupPreviewService.ts:1117-1123), so a
    // plan the render cannot consume must not re-key the page.
    const validity = JSON.stringify({
        documentPrior,
        documentCanvasPlan: previewOptions.matchPageSize ? documentCanvasPlan : null,
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

function carriesRaster(value: TScanCleanupPreviewWireResult): value is IScanCleanupPreviewResult {
    return value.rawImageData !== undefined;
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
    const inFlightPreviewPages: number[] = [];
    // A base preview pushes its page's raster the moment it exists and leaves
    // it out of the result it resolves with, so the bytes cross once. They wait
    // here for the result they belong to — which two callers can share, when a
    // navigation adopts a prefetch — and the window covers the visible page,
    // its two neighbours and the one still rendering. A retained entry is the
    // same buffer the cached result holds, so it costs nothing while that page
    // is cached.
    const streamedRawByPage = new Map<number, IScanCleanupRawPreviewEvent>();
    const STREAMED_RAW_PAGES_MAX = 4;

    const totalPages = computed(() => rawResult.value?.totalPages
        ?? result.value?.totalPages
        ?? Math.max(1, options.totalPages.value));
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
            return capability.preview(toBridgeSafeScanCleanupPayload(request)).then(withStreamedRaw);
        },
        store: cachePreview,
    });

    function acceptStreamedRaw(raw: IScanCleanupRawPreviewEvent) {
        if (raw.ownerId !== options.ownerId || raw.documentRevision !== options.documentRevision.value) {
            return;
        }
        streamedRawByPage.delete(raw.pageNumber);
        streamedRawByPage.set(raw.pageNumber, raw);
        while (streamedRawByPage.size > STREAMED_RAW_PAGES_MAX) {
            const oldest = streamedRawByPage.keys().next().value;
            if (oldest === undefined) break;
            streamedRawByPage.delete(oldest);
        }
        // The raw page is shown while its cleanup runs, so it becomes the
        // displayed raster as soon as it lands — but only for the page the user
        // is actually on. A prefetched neighbour just waits for its result.
        if (raw.pageNumber === options.previewPage.value) rawResult.value = raw;
    }

    /**
     * Puts the streamed raster back on the result it was rendered from. A
     * detail tile answers with its own raster and needs nothing.
     */
    function withStreamedRaw(previewResult: TScanCleanupPreviewWireResult): IScanCleanupPreviewResult {
        if (carriesRaster(previewResult)) {
            return previewResult;
        }
        const streamed = streamedRawByPage.get(previewResult.pageNumber);
        if (!streamed) throw new Error('Scan cleanup preview arrived without its page raster');
        return {
            ...previewResult,
            rawImageData: streamed.rawImageData,
        };
    }

    function cacheKey(
        pageNumber = options.previewPage.value,
        previewOptions = toPlainScanCleanupOptions(options.settings),
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
            options.documentCanvasPlan.value ?? null,
        );
    }

    function cachePreview(key: string, previewResult: IScanCleanupPreviewResult) {
        cache.set(key, previewResult);
        metadataByPage.set(previewResult.pageNumber, previewResult.pageMetadata);
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
        streamedRawByPage.clear();
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
            return {
                key: cacheKey(pageNumber, previewOptions, previewSourcePath),
                request: {
                    sourcePdfPath: previewSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber,
                    options: previewOptions,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(options.documentCanvasPlan.value === undefined
                        ? {}
                        : {documentCanvasPlan: options.documentCanvasPlan.value}),
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
        const requestOptions = toPlainScanCleanupOptions(options.settings);
        const requestSourcePath = options.sourcePath.value;
        const documentPrior = options.documentPriorByPage.get(requestPage);
        const key = cacheKey(requestPage, requestOptions, requestSourcePath);
        // A navigation reaches the previous page's key unchanged; anything else
        // — a settings change, a new document prior, another source — makes
        // every page's work stale and keeps no window.
        const navigated = scheduledPage !== null
            && scheduledKey === cacheKey(scheduledPage, requestOptions, requestSourcePath);
        scheduledPage = requestPage;
        scheduledKey = key;
        const activeDetailSourceKey = detailSourceKey(key, resolveDetailOutputMode(requestPage));
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
                    sourcePdfPath: requestSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber: requestPage,
                    options: requestOptions,
                    visible: true,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(options.documentCanvasPlan.value === undefined
                        ? {}
                        : {documentCanvasPlan: options.documentCanvasPlan.value}),
                })));
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
        timer = setTimeout(() => {
            inFlightPreviewPages.push(requestPage);
            void runPreview().finally(() => {
                const index = inFlightPreviewPages.indexOf(requestPage);
                if (index >= 0) inFlightPreviewPages.splice(index, 1);
            });
        }, navigated
            ? (inFlightPreviewPages.length === 0 ? 0 : SCAN_CLEANUP_PREVIEW_BURST_DEBOUNCE_MS)
            : 250);
    }

    function resolveDetailOutputMode(pageNumber = options.previewPage.value) {
        const pageOverride = getScanCleanupPageOverride(options.settings.pageOverrides, pageNumber);
        if (options.settings.preserveOriginalQuality) {
            return 'color' as const;
        }
        if (pageOverride.outputModeOverride) {
            return pageOverride.outputModeOverride;
        }
        if (options.settings.outputMode !== 'auto') {
            return options.settings.outputMode;
        }
        return result.value?.pageNumber === pageNumber
            ? result.value.pageMetadata.recommendedOutputMode ?? 'bw'
            : 'bw';
    }

    function detailSourceKey(baseKey: string, outputMode: ReturnType<typeof resolveDetailOutputMode>) {
        return JSON.stringify({
            baseKey,
            outputMode,
        });
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
        const requestOptions = toPlainScanCleanupOptions(options.settings);
        const requestSourcePath = options.sourcePath.value;
        const outputMode = resolveDetailOutputMode(requestPage);
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
            const next = withStreamedRaw(await capability.preview(toBridgeSafeScanCleanupPayload({
                sourcePdfPath: requestSourcePath,
                ownerId: options.ownerId,
                documentRevision: options.documentRevision.value,
                pageNumber: requestPage,
                options: requestOptions,
                ...(documentPrior === undefined ? {} : {documentPrior}),
                ...(options.documentCanvasPlan.value === undefined
                    ? {}
                    : {documentCanvasPlan: options.documentCanvasPlan.value}),
                detail: {
                    viewports,
                    outputMode,
                },
            })));
            if (requestSequence !== detailSequence || baseKey !== cacheKey()) {
                return;
            }
            detailSourceCache.set(tileKey, next);
            detailResult.value = next;
            displayedDetailSourceKey = sourceKey;
        } catch (caught) {
            if (!(caught instanceof Error && caught.name === 'AbortError')) {
                // A failed detail render retries on its own: the viewport is
                // stationary, so no user gesture would otherwise re-request it.
                if (requestSequence === detailSequence && detailRetriesRemaining > 0) {
                    detailRetriesRemaining -= 1;
                    detailRetryTimer = setTimeout(() => {
                        detailRetryTimer = null;
                        void requestDetail(viewports, true);
                    }, 1_000);
                }
            }
        } finally {
            if (requestSequence === detailSequence) {
                detailLoading.value = false;
            }
        }
    }

    function retry() {
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
        cache.clear();
        detailSourceCache.clear();
        metadataByPage.clear();
        streamedRawByPage.clear();
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
        schedule,
        totalPages,
        viewMode,
    };
};
