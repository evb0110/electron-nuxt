import type {
    IScanCleanupDetectionResult,
    IScanCleanupSourcePageMetadata,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPageOverride,
    IScanCleanupPreviewResult,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
    shouldShowScanCleanupOutputEstimate,
} from '@contracts/scanCleanupPageOverrides';
import {isScanCleanupSourceSha256} from '@contracts/scanCleanupSettings';
import type {TDocumentRef} from '@contracts/documentRef';
import type {ComputedRef} from 'vue';
import {applyScanCleanupDetectionResults} from '@app/modules/scan-cleanup/runtime/applyScanCleanupDetectionResults';
import {formatScanCleanupPreAnalysisProgress} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {
    scanCleanupAutoDetectionCanceledDocuments as autoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache as detectionSessionCache,
    discardScanCleanupDetectionStateForAliases,
    isScanCleanupLifecycleIdentityPromotion,
    promoteScanCleanupDetectionState,
    retireSupersededScanCleanupDetectionState,
    type IScanCleanupDetectionSessionCacheEntry as IDetectionSessionCacheEntry,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {useScanCleanupPageEta} from '@app/modules/scan-cleanup/composables/useScanCleanupPageEta';

type TScanCleanupLayoutClassification = IScanCleanupPreviewResult['pageMetadata']['layoutClassification'];

const DETECTION_CANCELLATION_TIMEOUT_MS = 10_000;
const DETECTION_SUBSCRIPTION_RECONCILIATION_ATTEMPTS = 3;

interface IUseScanCleanupDetectionSessionOptions {
    active: () => boolean;
    documentRevision: ComputedRef<string>;
    isRunning: ComputedRef<boolean>;
    lifecycleDocumentKey: ComputedRef<string | null>;
    ownerId: string;
    settings: IScanCleanupOptions;
    sourceSha256: ComputedRef<string | null>;
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

function yieldToDetectionReconciliation() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export const useScanCleanupDetectionSession = (options: IUseScanCleanupDetectionSessionOptions) => {
    const {t} = useTypedI18n();
    const starting = ref(false);
    const autoPending = ref(false);
    const jobState = shallowRef<TScanCleanupDetectionJobState | null>(null);
    const documentCanvasSignature = shallowRef('');
    const detectionResultsByPage = new Map<number, IScanCleanupDetectionResult>();
    const error = ref('');
    const errorCode = ref<TScanCleanupErrorCode | null>(null);
    const signatures = new Map<number, string>();
    const detectedLayoutByPage = reactive(new Map<number, TScanCleanupLayoutClassification>());
    const confidenceByPage = reactive(new Map<number, number>());
    const documentPriorByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['documentPrior']>>());
    const textAxisByPage = reactive(new Map<number, NonNullable<IScanCleanupDetectionResult['textAxis']>>());
    const recommendedOutputModeByPage = reactive(
        new Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputMode']>>(),
    );
    const pagePlanEvidenceByPage = reactive(new Map<number, IScanCleanupPagePlanEvidence>());
    // Pages the running job has finished a stage for, accumulated across the
    // job: the rasterizing stage reports read pages and the detecting stage
    // reports analyzed ones, and neither set is a superset of the other. A page
    // leaves its loading state as soon as its own work lands, instead of
    // waiting for the whole batch.
    const settledPages = reactive(new Set<number>());
    const recommendedOutputModeConfidenceByPage = reactive(new Map<number, number>());
    const recommendedOutputModeReasonByPage = reactive(
        new Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputModeReason']>>(),
    );
    const softAlphaForegroundRecommendationByPage = reactive(new Map<number, boolean>());
    const sourcePageMetadataByPage = computed<ReadonlyMap<number, IScanCleanupSourcePageMetadata>>(
        () => new Map(
            (jobState.value?.results ?? []).flatMap(result => result.sourcePageMetadata === undefined
                ? []
                : [[
                    result.pageNumber,
                    result.sourcePageMetadata,
                ] as const]),
        ),
    );
    let jobId: string | null = null;
    let jobDocumentKey: string | null = null;
    let jobDocumentRevision: string | null = null;
    // Bumped whenever the document lifecycle replaces the session. A pending
    // detect-all continuation from before the bump must never cache results,
    // subscribe, or mutate session maps for the replacement document.
    let requestGeneration = 0;
    let stopSubscription: (() => void) | null = null;
    let disposed = false;
    let scheduledAutoDetection: ReturnType<typeof setTimeout> | null = null;
    let detectionRetirementTail = Promise.resolve();
    const terminalWaiters = new Map<string, Set<() => void>>();
    // The native detection cache owns both aliases while a source hash is
    // being published. Keep only the current document's aliases so closing a
    // workspace cannot erase an unrelated document's restore entry.
    const documentAliases = new Set<string>();
    let rememberedSourcePath = options.sourcePath.value;

    function rememberDocumentAliases(lifecycleKey: string | null | undefined) {
        if (lifecycleKey) documentAliases.add(lifecycleKey);
        if (options.sourcePath.value) documentAliases.add(options.sourcePath.value);
    }

    function enqueueDetectionRetirement(detectionJobId: string, documentRevision: string) {
        const capability = getScanCleanupCapability();
        detectionRetirementTail = detectionRetirementTail.then(async () => {
            if (!capability) {
                return;
            }
            await new Promise<void>(resolve => {
                let settled = false;
                let timeout: ReturnType<typeof setTimeout> | null = null;
                const finish = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (timeout !== null) clearTimeout(timeout);
                    const waiters = terminalWaiters.get(detectionJobId);
                    waiters?.delete(finish);
                    if (waiters?.size === 0) terminalWaiters.delete(detectionJobId);
                    resolve();
                };
                const waiters = terminalWaiters.get(detectionJobId) ?? new Set<() => void>();
                waiters.add(finish);
                terminalWaiters.set(detectionJobId, waiters);
                timeout = setTimeout(finish, DETECTION_CANCELLATION_TIMEOUT_MS);
                void capability.cancelDetection(detectionJobId, {
                    ownerId: options.ownerId,
                    documentRevision,
                }).then(async () => {
                    // IPC acknowledges the transition to `canceling`, not the
                    // terminal cancellation. Reusing the stable broker owner
                    // before that terminal event can rejoin the retiring job.
                    const state = await capability.getDetectionJobState(detectionJobId, {
                        ownerId: options.ownerId,
                        documentRevision,
                    }).catch(() => null);
                    if (!state || detectionIsTerminal(state)) finish();
                }).catch(finish);
            });
        });
        return detectionRetirementTail;
    }

    async function waitForDetectionRetirements() {
        // A second lifecycle transition can enqueue while the first cancel is
        // crossing IPC. Follow the moving tail until the exact serialized
        // queue observed after the last await has drained.
        let awaitedTail: Promise<void>;
        do {
            awaitedTail = detectionRetirementTail;
            await awaitedTail;
        } while (awaitedTail !== detectionRetirementTail);
    }

    function clearOutputModeRecommendations() {
        recommendedOutputModeByPage.clear();
        recommendedOutputModeConfidenceByPage.clear();
        recommendedOutputModeReasonByPage.clear();
        softAlphaForegroundRecommendationByPage.clear();
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
    function jobBelongsToCurrentDocument() {
        return jobDocumentKey === options.lifecycleDocumentKey.value
            && jobDocumentRevision === options.documentRevision.value;
    }
    const terminalStatus = computed<'completed' | 'failed' | 'canceled' | null>(() => {
        const status = jobState.value?.status;
        if (
            !jobBelongsToCurrentDocument()
            || (status === 'completed' && !evidenceIsCurrent())
        ) {
            return null;
        }
        return status === 'completed' || status === 'failed' || status === 'canceled'
            ? status
            : null;
    });
    const layoutDetectionComplete = computed(() => terminalStatus.value === 'completed');
    const cancelRequested = computed(() => jobState.value?.status === 'canceling');
    // `autoPending` owns the outer async startup/subscription call and can
    // remain true for a turn after a terminal event has already supplied the
    // final document plan. Terminal detection is authoritative for the UI:
    // cleanup starting in that turn must not keep the provisional caption or
    // page frames alive.
    const pending = computed(() => starting.value
        || isDetecting.value
        || (autoPending.value && terminalStatus.value === null));
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
    // Raster production and native analysis overlap, but that handoff is an
    // implementation detail. Count only actual page verdicts so the one
    // user-facing pre-analysis counter never changes meaning or moves backward.
    const preAnalysisProgress = computed(() => ({
        completedUnits: jobState.value?.results.length ?? 0,
        totalUnits: Math.max(1, options.totalPages.value),
    }));
    const preAnalysisParts = computed(() => formatScanCleanupPreAnalysisProgress(preAnalysisProgress.value, t));
    const progressText = computed(() => preAnalysisParts.value.text);
    const progressPhaseText = computed(() => preAnalysisParts.value.phase);
    const progressCountText = computed(() => preAnalysisParts.value.count);
    const progressPercent = computed(() => preAnalysisProgress.value.totalUnits === 0
        ? 0
        : preAnalysisProgress.value.completedUnits / preAnalysisProgress.value.totalUnits * 100);
    const {
        progressEtaText,
        progressEtaWidestText,
    } = useScanCleanupPageEta(computed(() => {
        const state = jobState.value;
        if (state === null || detectionIsTerminal(state)) {
            return null;
        }
        return {
            completedAtMs: state.updatedAtMs > 0 ? state.updatedAtMs : Date.now(),
            completedUnits: preAnalysisProgress.value.completedUnits,
            phaseKey: 'analysis',
            runKey: state.jobId,
            totalUnits: preAnalysisProgress.value.totalUnits,
        };
    }));
    // The same sentence at its widest counter, so the status line can reserve
    // its box and the cancel button beside it never moves as the count grows.
    const progressWidestText = computed(() => formatScanCleanupPreAnalysisProgress({
        ...preAnalysisProgress.value,
        completedUnits: preAnalysisProgress.value.totalUnits,
    }, t).text);
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

    // Page evidence signatures contain document-wide inputs plus the override
    // inputs that change what one page's detection computes. The configured
    // output mode is deliberately absent — the recommendation is a page
    // diagnostic and survives mode changes while the evidence is unchanged. So
    // is matchPageSize: the canvas is measured from the document's own page
    // geometry, so toggling it no longer changes anything detection reports and
    // must not throw a whole document's evidence away. So is excluded: it only
    // decides whether the analyzed page reaches the output, so toggling it must
    // not drop the page back to a pending spinner. Manual content boxes are
    // render overrides over the retained automatic page-plan evidence; editing
    // one must redraw that page, not restart document reconciliation.
    const documentSignature = computed(() => {
        const lossless = options.settings.preserveOriginalQuality === true;
        return JSON.stringify({
            layoutMode: options.settings.layoutMode,
            preserveOriginalQuality: lossless,
            crop: options.settings.crop,
            marginsMm: options.settings.marginsMm,
            normalizeIllumination: !lossless && (options.settings.normalizeIllumination ?? true),
            autoDewarp: !lossless && (options.settings.autoDewarp ?? false),
            autoDewarpDepth: options.settings.autoDewarpDepth,
        });
    });
    const pageOverrideSignatures = new Map<number, ComputedRef<string>>();

    function pageOverrideSignature(pageNumber: number) {
        let signature = pageOverrideSignatures.get(pageNumber);
        if (!signature) {
            signature = computed(() => {
                const pageOverride = getScanCleanupPageOverride(options.settings.pageOverrides, pageNumber);
                return JSON.stringify({
                    layoutOverride: pageOverride.layoutOverride,
                    rotationDegrees: pageOverride.rotationDegrees,
                    manualSplit: pageOverride.manualSplit,
                    manualSkewDegrees: pageOverride.manualSkewDegrees,
                    manualZones: pageOverride.manualZones ?? {
                        picture: [],
                        fill: [],
                    },
                });
            });
            pageOverrideSignatures.set(pageNumber, signature);
        }
        return signature.value;
    }

    // Settings changes are the only thing that invalidates an evidence
    // signature, so the document portion is serialized once per change and a
    // page's override portion is recomputed only when that page's reactive
    // override entry changes.
    const signatureByPage = computed(() => new Map(Array.from(
        {length: options.totalPages.value},
        (_, index) => [
            index + 1,
            `${documentSignature.value}:${pageOverrideSignature(index + 1)}`,
        ] as const,
    )));

    function signature(pageNumber: number) {
        return signatureByPage.value.get(pageNumber) ?? `${documentSignature.value}:${pageOverrideSignature(pageNumber)}`;
    }

    function evidenceIsCurrent(evidenceSignatures: ReadonlyMap<number, string> = signatures) {
        if (evidenceSignatures.size !== options.totalPages.value) {
            return false;
        }
        for (let pageNumber = 1; pageNumber <= options.totalPages.value; pageNumber += 1) {
            if (evidenceSignatures.get(pageNumber) !== signature(pageNumber)) {
                return false;
            }
        }
        return true;
    }

    async function reconcileDetectionJobState(
        capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
        detectionJobId: string,
        owner: {
            ownerId: string;
            documentRevision: string
        },
    ) {
        for (let attempt = 0; attempt < DETECTION_SUBSCRIPTION_RECONCILIATION_ATTEMPTS; attempt += 1) {
            const state = await Promise.resolve()
                .then(() => capability.getDetectionJobState(detectionJobId, owner))
                .catch(() => null);
            if (state) {
                return state;
            }
            if (attempt + 1 < DETECTION_SUBSCRIPTION_RECONCILIATION_ATTEMPTS) {
                await yieldToDetectionReconciliation();
            }
        }
        return null;
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
        for (const result of state.results) detectionResultsByPage.set(result.pageNumber, result);
        for (const result of state.results) {
            if (result.pagePlanEvidence !== undefined) {
                pagePlanEvidenceByPage.set(result.pageNumber, result.pagePlanEvidence);
            }
        }
        const accumulatedState = {
            ...state,
            results: [...detectionResultsByPage.values()]
                .sort((left, right) => left.pageNumber - right.pageNumber),
        };
        jobState.value = accumulatedState;
        documentCanvasSignature.value = accumulatedState.documentCanvasSignature ?? '';
        for (const pageNumber of state.progress.completedPageNumbers ?? []) settledPages.add(pageNumber);
        const completedWithCurrentEvidence = state.status === 'completed' && evidenceIsCurrent();
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
            softAlphaForegroundRecommendationByPage,
        );
        if (accumulatedState.status === 'failed') {
            error.value = accumulatedState.error;
            errorCode.value = accumulatedState.errorCode;
        } else if (accumulatedState.status === 'completed') {
            error.value = '';
            errorCode.value = null;
        } else if (accumulatedState.status === 'canceled') {
            error.value = '';
            errorCode.value = null;
        }
        if (!disposed && jobDocumentKey && completedWithCurrentEvidence) {
            detectionSessionCache.set(jobDocumentKey, {
                ownerId: options.ownerId,
                results: accumulatedState.results.map(result => ({...result})),
                signatures: new Map(signatures),
                state: structuredClone(accumulatedState),
                totalPages: state.progress.totalUnits,
            });
        }
        if (!disposed && state.status === 'completed' && !completedWithCurrentEvidence) {
            jobState.value = null;
            documentCanvasSignature.value = '';
            scheduleAutoDetect();
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
        errorCode.value = null;
        if (!automatic && options.lifecycleDocumentKey.value) {
            autoDetectionCanceledDocuments.delete(options.lifecycleDocumentKey.value);
        }
        signatures.clear();
        for (let pageNumber = 1; pageNumber <= options.totalPages.value; pageNumber += 1) {
            signatures.set(pageNumber, signature(pageNumber));
        }
        const requestSourcePath = options.sourcePath.value;
        const requestDocumentRevision = options.documentRevision.value;
        const generation = ++requestGeneration;
        const isStale = () => disposed
            || generation !== requestGeneration
            || requestSourcePath !== options.sourcePath.value
            || requestDocumentRevision !== options.documentRevision.value;
        jobDocumentKey = options.lifecycleDocumentKey.value;
        jobDocumentRevision = requestDocumentRevision;
        jobId = null;
        jobState.value = null;
        documentCanvasSignature.value = '';
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
            if (isStale()) {
                scheduleAutoDetect();
            } else {
                error.value = caught instanceof Error ? caught.message : t('scanCleanup.detectAll.failed');
                errorCode.value = 'internal';
            }
            return;
        } finally {
            if (!disposed) starting.value = false;
        }
        if (isStale()) {
            if (result.started) {
                void enqueueDetectionRetirement(result.jobId, requestDocumentRevision);
            }
            // The lifecycle watcher may have tried to schedule the replacement
            // while `starting` still belonged to this request. Make the retry
            // explicit after the stale request releases that gate.
            scheduleAutoDetect();
            return;
        }
        if (!result.started) {
            error.value = result.error ?? t('scanCleanup.detectAll.failed');
            errorCode.value = result.errorCode;
            return;
        }
        detectedLayoutByPage.clear();
        confidenceByPage.clear();
        documentPriorByPage.clear();
        detectionResultsByPage.clear();
        settledPages.clear();
        textAxisByPage.clear();
        pagePlanEvidenceByPage.clear();
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
        const owner = {
            ownerId: options.ownerId,
            documentRevision: requestDocumentRevision,
        };
        let state: TScanCleanupDetectionJobState | null;
        try {
            state = await capability.subscribeDetectionJob(result.jobId, owner);
        } catch (caught) {
            const isCurrentJob = !isStale() && result.jobId === jobId;
            if (!isCurrentJob) {
                void Promise.resolve()
                    .then(() => capability.cancelDetection(result.jobId, owner))
                    .catch(() => undefined);
                return;
            }
            const reconciled = await reconcileDetectionJobState(capability, result.jobId, owner);
            const stillCurrentJob = !isStale() && result.jobId === jobId;
            if (!stillCurrentJob) {
                return;
            }
            if (reconciled) {
                applyState(reconciled);
                return;
            }
            // A job that cannot be observed is abandoned at the renderer
            // boundary. The main-process cancel is best effort, but the UI
            // must release its queued/running guard even when the bridge is
            // already gone.
            await Promise.resolve()
                .then(() => capability.cancelDetection(result.jobId, owner))
                .catch(() => false);
            if (!isStale() && result.jobId === jobId) {
                jobId = null;
                jobState.value = null;
                documentCanvasSignature.value = '';
                error.value = caught instanceof Error && caught.message
                    ? `Scan cleanup detection could not be observed after subscription failed (${caught.message})`
                    : 'Scan cleanup detection could not be observed after subscription failed';
                errorCode.value = 'internal';
            }
            return;
        }
        if (isStale() || result.jobId !== jobId) {
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

    async function settleCurrentDetection(cancelCurrent: boolean) {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let stopStarting: (() => void) | null = null;
            let targetJobId: string | null = null;
            let terminalWaiter: (() => void) | null = null;
            const timeout = cancelCurrent
                ? setTimeout(() => {
                    finish(new Error(t('scanCleanup.detectAll.cancelTimeout')));
                }, DETECTION_CANCELLATION_TIMEOUT_MS)
                : null;

            function cleanup() {
                if (timeout !== null) clearTimeout(timeout);
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
                if (cancelCurrent && !cancelRequested.value) {
                    await capability.cancelDetection(targetJobId, {
                        ownerId: options.ownerId,
                        documentRevision: targetJobRevision,
                    });
                    if (settled) {
                        return;
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
                    // A subscribed job can briefly be absent from a direct
                    // reconciliation read while its start is publishing. A
                    // run waiting for evidence must keep its event waiter in
                    // place; cancellation, conversely, may treat absence as
                    // terminal because there is no remaining work to stop.
                    if (cancelCurrent) finish();
                    return;
                }
                applyState(latest);
            })().catch(finish);
        });
    }

    async function cancelAndWaitForTerminal() {
        await settleCurrentDetection(true);
    }

    async function waitForTerminal() {
        // Evidence invalidation clears the completed snapshot before its
        // zero-delay replacement is started. A cleanup click can land in that
        // turn: make the click own the replacement rather than returning from
        // an empty session and misclassifying the transient gap as missing
        // evidence. Acquiring an authoritative source hash can retire that
        // run-owned start in flight, so follow only the replacement explicitly
        // scheduled by the current lifecycle. Terminal failed/canceled states
        // and real start failures remain authoritative and are not retried.
        const waitSourcePath = options.sourcePath.value;
        const waitDocumentRevision = options.documentRevision.value;
        let mayStartMissingDetection = jobState.value === null;
        const belongsToWaitedDocument = () => waitSourcePath === options.sourcePath.value
            && waitDocumentRevision === options.documentRevision.value;
        while (!disposed && options.active() && belongsToWaitedDocument()) {
            if (terminalStatus.value !== null) {
                return;
            }
            if (
                jobState.value !== null
                && (
                    !jobBelongsToCurrentDocument()
                    || detectionIsTerminal(jobState.value)
                )
            ) {
                // Computed identity changes synchronously, while the watcher
                // that retires the old maps and schedules their replacement
                // runs in Vue's next flush. Do not let the raw prior terminal
                // snapshot escape through that one-turn gap.
                mayStartMissingDetection = true;
                await nextTick();
                if (!belongsToWaitedDocument() || terminalStatus.value !== null) {
                    return;
                }
            }
            if (jobState.value === null && !starting.value) {
                if (
                    !mayStartMissingDetection
                    || error.value
                    || getScanCleanupCapability() === null
                ) {
                    return;
                }
                if (scheduledAutoDetection !== null) {
                    clearTimeout(scheduledAutoDetection);
                    scheduledAutoDetection = null;
                    autoPending.value = false;
                }
                await waitForDetectionRetirements();
                if (!belongsToWaitedDocument() || disposed || !options.active()) {
                    return;
                }
                const generation = requestGeneration;
                mayStartMissingDetection = false;
                await detectAllPages(false);
                if (!belongsToWaitedDocument() || terminalStatus.value !== null) {
                    return;
                }
                if (jobState.value === null) {
                    const replacementScheduled = scheduledAutoDetection !== null
                        || generation !== requestGeneration;
                    if (!replacementScheduled || error.value) {
                        return;
                    }
                    mayStartMissingDetection = true;
                    continue;
                }
            }
            await settleCurrentDetection(false);
            if (!belongsToWaitedDocument() || terminalStatus.value !== null) {
                return;
            }
            if (jobState.value === null && scheduledAutoDetection !== null && !error.value) {
                mayStartMissingDetection = true;
                continue;
            }
            return;
        }
    }

    function cacheIsFresh(entry: IDetectionSessionCacheEntry, lifecycleDocumentKey: string) {
        const documentIdentity = lifecycleDocumentKey?.split('\u0000', 1)[0] ?? '';
        const authoritativeIdentity = isScanCleanupSourceSha256(options.sourceSha256.value)
            && documentIdentity === options.sourceSha256.value.toLowerCase();
        if (
            (!authoritativeIdentity && entry.ownerId !== options.ownerId)
            || entry.totalPages !== options.totalPages.value
            || entry.signatures.size !== options.totalPages.value
        ) {
            return false;
        }
        if (!evidenceIsCurrent(entry.signatures)) {
            return false;
        }
        return entry.state.status === 'completed' && entry.results.length === options.totalPages.value;
    }

    function restoreSession(key: string | null) {
        if (key === null) {
            return false;
        }
        const cached = detectionSessionCache.get(key);
        if (!cached || !cacheIsFresh(cached, key)) {
            return false;
        }
        jobDocumentKey = key;
        jobDocumentRevision = options.documentRevision.value;
        jobState.value = structuredClone(cached.state);
        documentCanvasSignature.value = cached.state.documentCanvasSignature ?? '';
        detectionResultsByPage.clear();
        for (const result of cached.results) detectionResultsByPage.set(result.pageNumber, result);
        signatures.clear();
        for (const [
            pageNumber,
            value,
        ] of cached.signatures) signatures.set(pageNumber, value);
        settledPages.clear();
        for (const result of cached.results) settledPages.add(result.pageNumber);
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
            softAlphaForegroundRecommendationByPage,
        );
        pagePlanEvidenceByPage.clear();
        for (const result of cached.results) {
            if (result.pagePlanEvidence !== undefined) {
                pagePlanEvidenceByPage.set(result.pageNumber, result.pagePlanEvidence);
            }
        }
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

    function scheduleAutoDetect() {
        if (disposed || scheduledAutoDetection !== null) {
            return;
        }
        const generation = requestGeneration;
        const scheduled = setTimeout(async () => {
            await waitForDetectionRetirements();
            if (scheduledAutoDetection !== scheduled) {
                return;
            }
            scheduledAutoDetection = null;
            if (generation !== requestGeneration) {
                scheduleAutoDetect();
                return;
            }
            void maybeAutoDetect();
        }, 0);
        scheduledAutoDetection = scheduled;
    }

    onMounted(() => {
        stopSubscription = getScanCleanupCapability()?.onDetectionJobState(applyState) ?? null;
        void maybeAutoDetect();
    });
    watch(options.lifecycleDocumentKey, (key, previousKey) => {
        const promoted = previousKey !== undefined
            && isScanCleanupLifecycleIdentityPromotion(
                previousKey,
                key,
                options.sourcePath.value,
                options.sourceSha256.value,
                options.documentRevision.value,
            );
        if (options.sourcePath.value && options.sourcePath.value !== rememberedSourcePath && !promoted) {
            documentAliases.clear();
        }
        rememberedSourcePath = options.sourcePath.value;
        rememberDocumentAliases(previousKey);
        rememberDocumentAliases(key);
        if (promoted) {
            promoteScanCleanupDetectionState({
                provisionalLifecycleKey: previousKey,
                authoritativeLifecycleKey: key,
                sourcePath: options.sourcePath.value,
                sourceSha256: options.sourceSha256.value,
                documentRevision: options.documentRevision.value,
            });
            // Identity publication does not replace the source or revision.
            // Keep the native job, accumulated evidence, and renderer state;
            // only its cache key changes.
            jobDocumentKey = key;
            jobDocumentRevision = options.documentRevision.value;
            if (jobState.value === null && !isDetecting.value) {
                autoPending.value = Boolean(options.active() && options.sourcePath.value);
                if (previousKey !== undefined) scheduleAutoDetect();
            }
            return;
        }
        if (key === null) {
            // The workspace can stay mounted while its document is closed.
            // This is the actual lifecycle boundary for detection state; a
            // panel/session unmount alone must leave an authoritative entry
            // available for a later reopen.
            discardScanCleanupDetectionStateForAliases([...documentAliases]);
            documentAliases.clear();
        }
        retireSupersededScanCleanupDetectionState(key);
        requestGeneration += 1;
        if (jobId && isDetecting.value) {
            void enqueueDetectionRetirement(
                jobId,
                jobDocumentRevision ?? options.documentRevision.value,
            );
        }
        jobId = null;
        jobDocumentRevision = null;
        jobDocumentKey = options.lifecycleDocumentKey.value;
        jobState.value = null;
        documentCanvasSignature.value = '';
        error.value = '';
        errorCode.value = null;
        signatures.clear();
        detectionResultsByPage.clear();
        detectedLayoutByPage.clear();
        confidenceByPage.clear();
        documentPriorByPage.clear();
        settledPages.clear();
        textAxisByPage.clear();
        pagePlanEvidenceByPage.clear();
        clearOutputModeRecommendations();
        autoPending.value = Boolean(options.active() && options.sourcePath.value);
        // The mounted hook owns the initial auto-detect; scheduling it here too
        // would race a just-started or just-completed job on the same document.
        if (previousKey !== undefined) {
            scheduleAutoDetect();
        }
    }, {immediate: true});
    watch(options.sourcePath, sourcePath => {
        if (sourcePath !== null) {
            return;
        }
        // Some document-close flows clear the acquired path before clearing
        // their legacy key, so the lifecycle key watcher is not guaranteed to
        // observe a null transition of its own.
        discardScanCleanupDetectionStateForAliases([...documentAliases]);
        documentAliases.clear();
    });
    watch(options.active, active => {
        if (active) scheduleAutoDetect();
    });
    // Recommendations are page diagnostics and survive output-mode changes.
    // Switching back to automatic mode must have usable recommendations, so a
    // previously canceled or stranded detection is rescheduled here.
    watch(
        () => options.settings.outputMode === 'auto'
            && options.settings.preserveOriginalQuality !== true,
        automaticMode => {
            if (!automaticMode) {
                return;
            }
            const key = options.lifecycleDocumentKey.value;
            if (key !== null) autoDetectionCanceledDocuments.delete(key);
            scheduleAutoDetect();
        },
    );
    watch(
        () => Array.from(
            {length: options.totalPages.value},
            (_, index) => signature(index + 1),
        ),
        (currentSignatures, previousSignatures) => {
            if (
                currentSignatures.length === previousSignatures.length
                && currentSignatures.every((value, index) => value === previousSignatures[index])
            ) {
                return;
            }
            const key = options.lifecycleDocumentKey.value;
            if (key !== null) detectionSessionCache.delete(key);
            for (let index = 0; index < currentSignatures.length; index += 1) {
                if (currentSignatures[index] === previousSignatures[index]) {
                    continue;
                }
                const pageNumber = index + 1;
                detectedLayoutByPage.delete(pageNumber);
                settledPages.delete(pageNumber);
                confidenceByPage.delete(pageNumber);
                documentPriorByPage.delete(pageNumber);
                detectionResultsByPage.delete(pageNumber);
                textAxisByPage.delete(pageNumber);
                pagePlanEvidenceByPage.delete(pageNumber);
                recommendedOutputModeByPage.delete(pageNumber);
                recommendedOutputModeConfidenceByPage.delete(pageNumber);
                recommendedOutputModeReasonByPage.delete(pageNumber);
                softAlphaForegroundRecommendationByPage.delete(pageNumber);
            }
            if (!isDetecting.value) {
                jobState.value = null;
                documentCanvasSignature.value = '';
                scheduleAutoDetect();
            }
        },
    );
    onBeforeUnmount(() => {
        disposed = true;
        if (scheduledAutoDetection !== null) {
            clearTimeout(scheduledAutoDetection);
            scheduledAutoDetection = null;
        }
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
        documentCanvasSignature,
        documentPriorByPage,
        error,
        errorCode,
        isDetecting,
        layoutDetectionComplete,
        maybeAutoDetect,
        outputEstimate,
        pagePlanEvidenceByPage,
        pending,
        progress,
        progressCountText,
        progressEtaText,
        progressEtaWidestText,
        progressPercent,
        progressPhaseText,
        progressText,
        progressWidestText,
        recommendedOutputModeByPage,
        recommendedOutputModeConfidenceByPage,
        recommendedOutputModeReasonByPage,
        softAlphaForegroundRecommendationByPage,
        settledPages,
        sourcePageMetadataByPage,
        textAxisByPage,
        terminalStatus,
        waitForTerminal,
    };
};
