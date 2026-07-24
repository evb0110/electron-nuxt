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

const DETECTION_CANCELLATION_TIMEOUT_MS = 10_000;

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

function detectionPhaseRank(stage: TScanCleanupDetectionJobState['progress']['stage']) {
    if (stage === 'queued') {
        return 0;
    }
    if (stage === 'rasterizing') {
        return 1;
    }
    return 2;
}

function detectionIsTerminal(state: TScanCleanupDetectionJobState | null) {
    return state !== null && [
        'completed',
        'failed',
        'canceled',
    ].includes(state.status);
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
    const documentCanvasPlan = shallowRef<TScanCleanupDetectionJobState['documentCanvasPlan']>();
    const textAxisByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['textAxis']>>());
    const recommendedOutputModeByPage = reactive(
        new Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputMode']>>(),
    );
    const recommendedOutputModeConfidenceByPage = reactive(new Map<number, number>());
    const recommendedOutputModeReasonByPage = reactive(
        new Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputModeReason']>>(),
    );
    let jobId: string | null = null;
    let jobDocumentKey: string | null = null;
    let jobDocumentRevision: string | null = null;
    let stopSubscription: (() => void) | null = null;
    let disposed = false;
    const terminalWaiters = new Map<string, Set<() => void>>();

    function clearOutputModeRecommendations() {
        recommendedOutputModeByPage.clear();
        recommendedOutputModeConfidenceByPage.clear();
        recommendedOutputModeReasonByPage.clear();
    }

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
    const progressText = computed(() => t(
        progress.value.stage === 'rasterizing'
            ? 'scanCleanup.detectAll.rasterizingProgress'
            : 'scanCleanup.detectAll.analyzingProgress',
        {
            completed: progress.value.completedUnits,
            total: progress.value.totalUnits,
        },
    ));
    const blankPageCount = computed(() => jobState.value?.status === 'completed'
        ? jobState.value.results.filter(result => result.recommendedOutputModeReason === 'blank').length
        : 0);
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
        const outputMode = lossless
            ? 'color'
            : pageOverride.outputModeOverride ?? options.settings.outputMode;
        return JSON.stringify({
            layoutMode: options.settings.layoutMode,
            layoutOverride: pageOverride.layoutOverride,
            outputMode,
            binarization: options.settings.binarization ?? 'auto',
            normalizeIllumination: !lossless && (options.settings.normalizeIllumination ?? true),
            thickness: lossless ? 0 : options.settings.thickness,
            despeckleLevel: !lossless
                && (outputMode === 'auto' || outputMode === 'bw' || outputMode === 'mixed')
                ? options.settings.despeckleLevel
                    ?? ((options.settings.despeckle ?? true) ? 'normal' : 'off')
                : 'off',
            autoDewarp: !lossless && (options.settings.autoDewarp ?? false),
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
        if (detectionIsTerminal(state)) {
            for (const settle of terminalWaiters.get(state.jobId) ?? []) settle();
            terminalWaiters.delete(state.jobId);
        }
        if (disposed || state.jobId !== jobId) {
            return;
        }
        const current = jobState.value;
        if (current?.jobId === state.jobId) {
            const currentPhase = detectionPhaseRank(current.progress.stage);
            const nextPhase = detectionPhaseRank(state.progress.stage);
            if (
                state.updatedAtMs < current.updatedAtMs
                || nextPhase < currentPhase
                || (
                    nextPhase === currentPhase
                    && state.progress.completedUnits < current.progress.completedUnits
                )
            ) {
                return;
            }
        }
        jobState.value = state;
        if (state.status === 'completed') {
            documentCanvasPlan.value = state.documentCanvasPlan;
        }
        applyScanCleanupDetectionResults(
            state.results,
            detectedLayoutByPage,
            confidenceByPage,
            pageNumber => signatures.get(pageNumber) === signature(pageNumber),
            documentPriorByPage,
            textAxisByPage,
            recommendedOutputModeByPage,
            recommendedOutputModeConfidenceByPage,
            recommendedOutputModeReasonByPage,
        );
        if (state.status === 'failed') error.value = state.error;
        if (!disposed && jobDocumentKey && state.status === 'completed') {
            detectionSessionCache.set(jobDocumentKey, {
                ownerId: options.ownerId,
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
        documentCanvasPlan.value = undefined;
        textAxisByPage.clear();
        clearOutputModeRecommendations();
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
            updatedAtMs: 0,
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

    async function cancelAndWaitForTerminal() {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let stopStarting: (() => void) | null = null;
            let targetJobId: string | null = null;
            let terminalWaiter: (() => void) | null = null;
            const timeout = setTimeout(() => {
                finish(new Error(t('scanCleanup.detectAll.cancelTimeout')));
            }, DETECTION_CANCELLATION_TIMEOUT_MS);

            function cleanup() {
                clearTimeout(timeout);
                stopStarting?.();
                if (targetJobId && terminalWaiter) {
                    const waiters = terminalWaiters.get(targetJobId);
                    waiters?.delete(terminalWaiter);
                    if (waiters?.size === 0) terminalWaiters.delete(targetJobId);
                }
            }

            function finish(caught?: unknown) {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (caught === undefined) {
                    resolve();
                } else {
                    reject(caught);
                }
            }

            void (async () => {
                if (starting.value) {
                    await new Promise<void>(resolveStarting => {
                        stopStarting = watch(starting, value => {
                            if (!value) resolveStarting();
                        }, {flush: 'sync'});
                    });
                    const stopAfterStarting = stopStarting as (() => void) | null;
                    stopAfterStarting?.();
                    stopStarting = null;
                    if (settled) {
                        return;
                    }
                    await nextTick();
                }
                targetJobId = jobId;
                const targetJobRevision = jobDocumentRevision ?? options.documentRevision.value;
                const targetDocumentKey = jobDocumentKey;
                if (!targetJobId || detectionIsTerminal(jobState.value)) {
                    finish();
                    return;
                }
                const capability = getScanCleanupCapability();
                if (!capability) {
                    finish();
                    return;
                }
                terminalWaiter = () => finish();
                const waiters = terminalWaiters.get(targetJobId) ?? new Set<() => void>();
                waiters.add(terminalWaiter);
                terminalWaiters.set(targetJobId, waiters);
                if (!cancelRequested.value) {
                    const canceled = await capability.cancelDetection(targetJobId, {
                        ownerId: options.ownerId,
                        documentRevision: targetJobRevision,
                    });
                    if (settled) {
                        return;
                    }
                    if (canceled && !disposed && targetDocumentKey) {
                        autoDetectionCanceledDocuments.add(targetDocumentKey);
                    }
                }
                const latest = await capability.getDetectionJobState(targetJobId, {
                    ownerId: options.ownerId,
                    documentRevision: targetJobRevision,
                });
                if (settled) {
                    return;
                }
                if (!latest) {
                    finish();
                    return;
                }
                applyState(latest);
            })().catch(finish);
        });
    }

    function cacheIsFresh(entry: IDetectionSessionCacheEntry) {
        if (
            entry.ownerId !== options.ownerId
            || entry.totalPages !== options.totalPages.value
            || entry.signatures.size !== options.totalPages.value
        ) {
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
        documentCanvasPlan.value = cached.state.documentCanvasPlan;
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
            recommendedOutputModeByPage,
            recommendedOutputModeConfidenceByPage,
            recommendedOutputModeReasonByPage,
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
        documentCanvasPlan.value = undefined;
        textAxisByPage.clear();
        clearOutputModeRecommendations();
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
    watch(
        () => [
            options.settings.outputMode,
            options.settings.preserveOriginalQuality === true,
        ] as const,
        clearOutputModeRecommendations,
    );
    watch(
        () => Array.from(
            {length: options.totalPages.value},
            (_, index) => JSON.stringify(options.settings.pageOverrides[String(index + 1)]?.manualZones ?? null),
        ),
        (currentZones, previousZones) => {
            for (let index = 0; index < currentZones.length; index += 1) {
                if (currentZones[index] !== previousZones[index]) {
                    recommendedOutputModeByPage.delete(index + 1);
                    recommendedOutputModeConfidenceByPage.delete(index + 1);
                    recommendedOutputModeReasonByPage.delete(index + 1);
                }
            }
        },
    );
    watch(
        () => JSON.stringify({
            crop: options.settings.crop,
            layoutMode: options.settings.layoutMode,
            marginsMm: options.settings.marginsMm,
            pageOverrides: options.settings.pageOverrides,
            preserveOriginalQuality: options.settings.preserveOriginalQuality === true,
        }),
        () => {
            if (jobState.value?.status === 'completed') {
                documentCanvasPlan.value = undefined;
            }
        },
    );
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
        blankPageCount,
        canDetectAll,
        cancel,
        cancelAndWaitForTerminal,
        cancelRequested,
        confidenceByPage,
        detectAllPages,
        documentCanvasPlan,
        documentPriorByPage,
        error,
        isDetecting,
        maybeAutoDetect,
        outputEstimate,
        pending,
        progress,
        progressText,
        recommendedOutputModeByPage,
        recommendedOutputModeConfidenceByPage,
        recommendedOutputModeReasonByPage,
        textAxisByPage,
    };
};
