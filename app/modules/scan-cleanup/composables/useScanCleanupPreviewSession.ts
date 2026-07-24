import type {
    IScanCleanupOptions,
    IScanCleanupDocumentPrior,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupNormalizedRect,
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {createScanCleanupPreviewPrefetcher} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPrefetcher';
import {createScanCleanupPreviewCache} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import type {TScanCleanupSelectionIntent} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

interface IUseScanCleanupPreviewSessionOptions {
    active: () => boolean;
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
    documentRevision: ComputedRef<string>;
    documentPriorByPage: ReadonlyMap<number, IScanCleanupDocumentPrior>;
    documentCanvasPlan: ComputedRef<IScanCleanupDocumentCanvasPlan | undefined>;
    initialViewMode?: 'original' | 'cleaned' | undefined;
    isRunning: ComputedRef<boolean>;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    previewPage: Ref<number>;
    selectPage: (page: number, intent: TScanCleanupSelectionIntent, orderedPages: readonly number[]) => void;
    settings: IScanCleanupOptions;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
    whenRunStops: () => void;
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
    return JSON.stringify({
        sourcePath: previewSourcePath,
        documentRevision,
        documentPrior,
        documentCanvasPlan,
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
    const detailTileAliases = new Map<string, string>();
    const metadataByPage = reactive(new Map<number, IScanCleanupPreviewResult['pageMetadata']>());
    let sequence = 0;
    let detailSequence = 0;
    let displayedDetailSourceKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

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
            return capability.preview(toBridgeSafeScanCleanupPayload(request));
        },
        store: cachePreview,
    });

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

    function cancel(invalidateRawCache = true) {
        sequence += 1;
        detailSequence += 1;
        prefetcher.supersede();
        clearTimer();
        loading.value = false;
        detailLoading.value = false;
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
        if (!options.active() || !options.sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            error.value = t('scanCleanup.preview.unavailable');
            return;
        }
        prefetcher.supersede();
        void capability.cancelPreview({
            sourcePdfPath: options.sourcePath.value,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            invalidateRawCache: false,
        }).catch(() => undefined);
        const requestSequence = ++sequence;
        clearTimer();
        const requestPage = options.previewPage.value;
        const requestOptions = toPlainScanCleanupOptions(options.settings);
        const requestSourcePath = options.sourcePath.value;
        const documentPrior = options.documentPriorByPage.get(requestPage);
        const key = cacheKey(requestPage, requestOptions, requestSourcePath);
        if (displayedDetailSourceKey !== detailSourceKey(key, resolveDetailOutputMode(requestPage))) {
            detailResult.value = null;
            displayedDetailSourceKey = null;
        }
        const cached = cache.get(key);
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
                const nextRawResult = await capability.previewRaw({
                    sourcePdfPath: requestSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber: requestPage,
                });
                if (requestSequence !== sequence) {
                    return;
                }
                rawResult.value = nextRawResult;
                const previewResult = await capability.preview(toBridgeSafeScanCleanupPayload({
                    sourcePdfPath: requestSourcePath,
                    ownerId: options.ownerId,
                    documentRevision: options.documentRevision.value,
                    pageNumber: requestPage,
                    options: requestOptions,
                    ...(documentPrior === undefined ? {} : {documentPrior}),
                    ...(options.documentCanvasPlan.value === undefined
                        ? {}
                        : {documentCanvasPlan: options.documentCanvasPlan.value}),
                }));
                if (requestSequence !== sequence) {
                    return;
                }
                cachePreview(key, previewResult);
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
        timer = setTimeout(() => { void runPreview(); }, result.value && result.value.pageNumber !== requestPage ? 0 : 250);
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
            maxPixels: 4_000_000,
        });
    }

    function detailTileKey(sourceKey: string, viewport: IScanCleanupNormalizedRect) {
        return JSON.stringify({
            sourceKey,
            viewport,
        });
    }

    async function requestDetail(viewport: IScanCleanupNormalizedRect) {
        if (
            !options.active()
            || !options.sourcePath.value
            || options.settings.preserveOriginalQuality
            || !resultCurrent.value
        ) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        const requestPage = options.previewPage.value;
        const requestOptions = toPlainScanCleanupOptions(options.settings);
        const requestSourcePath = options.sourcePath.value;
        const outputMode = resolveDetailOutputMode(requestPage);
        const baseKey = cacheKey(requestPage, requestOptions, requestSourcePath);
        const sourceKey = detailSourceKey(baseKey, outputMode);
        const tileKey = detailTileKey(sourceKey, viewport);
        const aliasedSourceKey = detailTileAliases.get(tileKey);
        const cached = detailSourceCache.get(aliasedSourceKey ?? sourceKey);
        if (cached) {
            detailTileAliases.delete(tileKey);
            detailTileAliases.set(tileKey, sourceKey);
            detailResult.value = cached;
            displayedDetailSourceKey = sourceKey;
            detailLoading.value = false;
            return;
        }
        const requestSequence = ++detailSequence;
        detailLoading.value = true;
        try {
            const documentPrior = options.documentPriorByPage.get(requestPage);
            const next = await capability.preview(toBridgeSafeScanCleanupPayload({
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
                    viewport,
                    outputMode,
                    maxPixels: 4_000_000,
                },
            }));
            if (requestSequence !== detailSequence || baseKey !== cacheKey()) {
                return;
            }
            detailSourceCache.set(sourceKey, next);
            detailTileAliases.set(tileKey, sourceKey);
            while (detailTileAliases.size > 32) {
                const oldestKey = detailTileAliases.keys().next().value;
                if (oldestKey === undefined) break;
                detailTileAliases.delete(oldestKey);
            }
            detailResult.value = next;
            displayedDetailSourceKey = sourceKey;
        } catch (caught) {
            if (!(caught instanceof Error && caught.name === 'AbortError')) {
                detailResult.value = null;
                displayedDetailSourceKey = null;
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

    watch(options.active, active => {
        if (active) schedule();
        else cancel();
    }, {immediate: true});
    watch(options.lifecycleDocumentKey, () => {
        cache.clear();
        detailSourceCache.clear();
        detailTileAliases.clear();
        metadataByPage.clear();
        result.value = null;
        rawResult.value = null;
        resultKey.value = null;
        detailResult.value = null;
        displayedDetailSourceKey = null;
    });
    watch(cacheKey, schedule);
    watch(options.isRunning, running => {
        if (!running && options.active()) {
            schedule();
            options.whenRunStops();
        }
    });
    onBeforeUnmount(() => cancel());

    return {
        cancel,
        classificationDiffersByPage,
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
