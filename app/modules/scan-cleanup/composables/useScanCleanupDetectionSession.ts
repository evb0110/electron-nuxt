import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewResult,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
    shouldShowScanCleanupOutputEstimate,
} from '@contracts/scanCleanupPageOverrides';
import type {TDocumentRef} from '@contracts/documentRef';
import type {ComputedRef} from 'vue';
import {applyScanCleanupDetectionResults} from '@app/modules/scan-cleanup/runtime/applyScanCleanupDetectionResults';
import {
    scanCleanupAutoDetectionCanceledDocuments as autoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache as detectionSessionCache,
    type IScanCleanupDetectionSessionCacheEntry as IDetectionSessionCacheEntry,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

interface IUseScanCleanupDetectionSessionOptions {
    active: () => boolean;
    documentRevision: ComputedRef<string>;
    isRunning: ComputedRef<boolean>;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    settings: IScanCleanupOptions;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
}



function resolveManualLayoutClassification(
    options: Pick<IScanCleanupOptions, 'layoutMode'>,
    pageOverride: IScanCleanupPageOverride,
): TScanCleanupLayoutClassification | undefined {
    const layout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    if (layout === 'force-two-page') {
        return 'two-page-spread';
    }
    if (layout === 'force-single') {
        return 'single-uncut-page';
    }
    if (layout === 'keep-left' || layout === 'keep-right') {
        return 'page-with-offcut';
    }
    return pageOverride.manualSplit === null ? undefined : 'two-page-spread';
}

export const useScanCleanupDetectionSession = (options: IUseScanCleanupDetectionSessionOptions) => {
    const {t} = useTypedI18n();
    const starting = ref(false);
    const autoPending = ref(false);
    const jobState = shallowRef<TScanCleanupDetectionJobState | null>(null);
    const error = ref('');
    const signatures = new Map<number, string>();
    const detectedLayoutByPage = reactive(new Map<number, TScanCleanupLayoutClassification>());
    const confidenceByPage = reactive(new Map<number, number>());
    const documentPriorByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['documentPrior']>>());
    const textAxisByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['textAxis']>>());
    let jobId: string | null = null;
    let jobDocumentKey: string | null = null;
    let jobDocumentRevision: string | null = null;
    let stopSubscription: (() => void) | null = null;
    let disposed = false;

    const manualLayoutOverrideByPage = computed<ReadonlyMap<number, TScanCleanupLayoutClassification>>(() => {
        const layouts = new Map<number, TScanCleanupLayoutClassification>();
        for (let pageNumber = 1; pageNumber <= options.totalPages.value; pageNumber += 1) {
            const classification = resolveManualLayoutClassification(
                options.settings,
                getScanCleanupPageOverride(options.settings.pageOverrides, pageNumber),
            );
            if (classification !== undefined) layouts.set(pageNumber, classification);
        }
        return layouts;
    });
    const authoritativeLayoutByPage = computed<ReadonlyMap<number, TScanCleanupLayoutClassification>>(() => {
        const layouts = new Map(detectedLayoutByPage);
        for (const [
            pageNumber,
            classification,
        ] of manualLayoutOverrideByPage.value) {
            layouts.set(pageNumber, classification);
        }
        return layouts;
    });
    const isDetecting = computed(() => jobState.value?.status === 'queued'
        || jobState.value?.status === 'running'
        || jobState.value?.status === 'canceling');
    const cancelRequested = computed(() => jobState.value?.status === 'canceling');
    const pending = computed(() => autoPending.value || starting.value || isDetecting.value);
    const canStart = computed(() => Boolean(options.sourcePath.value)
        && !options.isRunning.value
        && !isDetecting.value
        && !starting.value
        && getScanCleanupCapability() !== null);
    const canDetectAll = computed(() => canStart.value && !autoPending.value);
    const progress = computed(() => jobState.value?.progress ?? {
        stage: 'detecting' as const,
        completedUnits: 0,
        totalUnits: Math.max(1, options.totalPages.value),
        percent: 0,
        completedPageNumbers: [],
    });
    const outputEstimate = computed(() => {
        const estimate = estimateScanCleanupOutputPages(
            options.totalPages.value,
            options.settings,
            authoritativeLayoutByPage.value,
        );
        if (!shouldShowScanCleanupOutputEstimate(
            options.totalPages.value,
            options.settings,
            authoritativeLayoutByPage.value,
        )) {
            return '';
        }
        return t(estimate.exact ? 'scanCleanup.estimateExact' : 'scanCleanup.estimateAbout', {
            input: options.totalPages.value,
            output: estimate.outputPages,
        });
    });

    function signature(pageNumber: number) {
        const pageOverride = getScanCleanupPageOverride(options.settings.pageOverrides, pageNumber);
        const lossless = options.settings.preserveOriginalQuality === true;
        return JSON.stringify({
            layoutMode: options.settings.layoutMode,
            layoutOverride: pageOverride.layoutOverride,
            outputMode: lossless ? 'color' : options.settings.outputMode,
            thickness: lossless ? 0 : options.settings.thickness,
            despeckle: !lossless
                && (options.settings.outputMode === 'bw' || options.settings.outputMode === 'mixed')
                && options.settings.despeckle,
            rotationDegrees: pageOverride.rotationDegrees,
            excluded: pageOverride.excluded,
            manualSplit: pageOverride.manualSplit,
            manualZones: pageOverride.manualZones ?? {
                picture: [],
                fill: [],
            },
        });
    }

    function applyState(state: TScanCleanupDetectionJobState) {
        if (disposed || state.jobId !== jobId) {
            return;
        }
        jobState.value = state;
        applyScanCleanupDetectionResults(
            state.results,
            detectedLayoutByPage,
            confidenceByPage,
            pageNumber => signatures.get(pageNumber) === signature(pageNumber),
            documentPriorByPage,
            textAxisByPage,
        );
        if (state.status === 'failed') error.value = state.error;
        if (!disposed && jobDocumentKey && state.status === 'completed') {
            detectionSessionCache.set(jobDocumentKey, {
                results: state.results.map(result => ({...result})),
                signatures: new Map(signatures),
                state: structuredClone(state),
                totalPages: state.progress.totalUnits,
            });
        }
    }

    async function detectAllPages(automatic = false) {
        if (!options.sourcePath.value || !canStart.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        error.value = '';
        if (!automatic && options.lifecycleDocumentKey.value) {
            autoDetectionCanceledDocuments.delete(options.lifecycleDocumentKey.value);
        }
        signatures.clear();
        for (let pageNumber = 1; pageNumber <= options.totalPages.value; pageNumber += 1) {
            signatures.set(pageNumber, signature(pageNumber));
        }
        const requestSourcePath = options.sourcePath.value;
        jobDocumentKey = options.lifecycleDocumentKey.value;
        jobDocumentRevision = options.documentRevision.value;
        starting.value = true;
        let result;
        try {
            result = await capability.detectAll(toBridgeSafeScanCleanupPayload({
                sourcePdfPath: requestSourcePath,
                ownerId: options.ownerId,
                documentRevision: jobDocumentRevision,
                options: toPlainScanCleanupOptions(options.settings),
            }));
        } catch (caught) {
            if (!disposed) {
                error.value = caught instanceof Error ? caught.message : t('scanCleanup.detectAll.failed');
            }
            return;
        } finally {
            if (!disposed) starting.value = false;
        }
        if (disposed || requestSourcePath !== options.sourcePath.value) {
            if (result.started) {
                void capability.cancelDetection(result.jobId, {
                    ownerId: options.ownerId,
                    documentRevision: jobDocumentRevision ?? options.documentRevision.value,
                }).catch(() => undefined);
            }
            return;
        }
        if (!result.started) {
            error.value = result.error ?? t('scanCleanup.detectAll.failed');
            return;
        }
        detectedLayoutByPage.clear();
        confidenceByPage.clear();
        documentPriorByPage.clear();
        textAxisByPage.clear();
        jobId = result.jobId;
        jobState.value = {
            jobId: result.jobId,
            status: 'queued',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: options.totalPages.value,
                percent: 0,
                completedPageNumbers: [],
            },
            results: [],
            updatedAtMs: Date.now(),
        };
        const state = await capability.subscribeDetectionJob(result.jobId, {
            ownerId: options.ownerId,
            documentRevision: jobDocumentRevision ?? options.documentRevision.value,
        });
        if (disposed || result.jobId !== jobId) {
            return;
        }
        if (state) applyState(state);
    }

    async function cancel() {
        if (!jobId || cancelRequested.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        if (await capability.cancelDetection(jobId, {
            ownerId: options.ownerId,
            documentRevision: jobDocumentRevision ?? options.documentRevision.value,
        }) && !disposed && jobDocumentKey) {
            autoDetectionCanceledDocuments.add(jobDocumentKey);
        }
    }

    function cacheIsFresh(entry: IDetectionSessionCacheEntry) {
        if (entry.totalPages !== options.totalPages.value || entry.signatures.size !== options.totalPages.value) {
            return false;
        }
        for (let pageNumber = 1; pageNumber <= options.totalPages.value; pageNumber += 1) {
            if (entry.signatures.get(pageNumber) !== signature(pageNumber)) {
                return false;
            }
        }
        return entry.state.status === 'completed' && entry.results.length === options.totalPages.value;
    }

    function restoreSession(key: string | null) {
        const cached = key ? detectionSessionCache.get(key) : undefined;
        if (!cached || !cacheIsFresh(cached)) {
            return false;
        }
        jobState.value = structuredClone(cached.state);
        signatures.clear();
        for (const [
            pageNumber,
            value,
        ] of cached.signatures) signatures.set(pageNumber, value);
        applyScanCleanupDetectionResults(
            cached.results,
            detectedLayoutByPage,
            confidenceByPage,
            undefined,
            documentPriorByPage,
            textAxisByPage,
        );
        return true;
    }

    async function maybeAutoDetect() {
        const key = options.lifecycleDocumentKey.value;
        if (
            disposed
            || !options.active()
            || !options.sourcePath.value
            || !canStart.value
            || restoreSession(key)
            || (key !== null && autoDetectionCanceledDocuments.has(key))
        ) {
            autoPending.value = false;
            return;
        }
        autoPending.value = true;
        try {
            await detectAllPages(true);
        } finally {
            autoPending.value = false;
        }
    }

    onMounted(() => {
        stopSubscription = getScanCleanupCapability()?.onDetectionJobState(applyState) ?? null;
        void maybeAutoDetect();
    });
    watch(options.lifecycleDocumentKey, (_key, previousKey) => {
        if (jobId && isDetecting.value) {
            void getScanCleanupCapability()?.cancelDetection(jobId, {
                ownerId: options.ownerId,
                documentRevision: jobDocumentRevision ?? options.documentRevision.value,
            }).catch(() => undefined);
        }
        jobId = null;
        jobDocumentRevision = null;
        jobDocumentKey = options.lifecycleDocumentKey.value;
        jobState.value = null;
        error.value = '';
        signatures.clear();
        detectedLayoutByPage.clear();
        confidenceByPage.clear();
        documentPriorByPage.clear();
        textAxisByPage.clear();
        autoPending.value = Boolean(options.active() && options.sourcePath.value);
        // The mounted hook owns the initial auto-detect; scheduling it here too
        // would race a just-started or just-completed job on the same document.
        if (previousKey !== undefined) {
            void nextTick(maybeAutoDetect);
        }
    }, {immediate: true});
    watch(options.active, active => {
        if (active) void nextTick(maybeAutoDetect);
    });
    onBeforeUnmount(() => {
        disposed = true;
        stopSubscription?.();
        if (jobId && isDetecting.value) {
            void getScanCleanupCapability()?.cancelDetection(jobId, {
                ownerId: options.ownerId,
                documentRevision: jobDocumentRevision ?? options.documentRevision.value,
            }).catch(() => undefined);
        }
    });

    return {
        authoritativeLayoutByPage,
        canDetectAll,
        cancel,
        cancelRequested,
        confidenceByPage,
        detectAllPages,
        documentPriorByPage,
        error,
        isDetecting,
        maybeAutoDetect,
        outputEstimate,
        pending,
        progress,
        textAxisByPage,
    };
};
