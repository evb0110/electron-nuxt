import type {
    IScanCleanupOptions,
    IScanCleanupDetectionResult,
    TScanCleanupDetectionJobState,
    IScanCleanupPageOverride,
    IScanCleanupPreviewRect,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPageAlignment,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupOutputPlacement,
    shouldShowScanCleanupOutputEstimate,
} from '@contracts/scanCleanupPageOverrides';
import {
    cancelScanCleanup,
    isScanCleanupRunning,
    resolveScanCleanupProcessedPages,
    scanCleanupRun,
    startScanCleanup,
} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {
    loadScanCleanupDocumentOverrides,
    loadScanCleanupPreferences,
    resetScanCleanupDocumentOverrides,
    saveScanCleanupDocumentOverrides,
    saveScanCleanupPreferences,
    toPlainScanCleanupOptions,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferences';
import { createScanCleanupPreviewPrefetcher } from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPrefetcher';
import { getScanCleanupCapability } from '@app/utils/getScanCleanupCapability';
import {
    resolveScanCleanupSelection,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import {
    resolveScanCleanupApplyScope,
    type TScanCleanupApplyScope,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrides,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {applyScanCleanupDetectionResults} from '@app/modules/scan-cleanup/runtime/applyScanCleanupDetectionResults';

interface IUseScanCleanupWorkspaceSessionOptions {
    active: () => boolean;
    sourcePath: () => TDocumentRef | null;
    documentKey: () => string | null;
    currentPage: () => number;
    totalPages: () => number;
    initialPreviewPage?: () => number | undefined;
    initialPreviewViewMode?: () => 'original' | 'cleaned' | undefined;
    initialPreviewZoomMode?: () => 'fit' | 'actual' | undefined;
}

interface IDetectionSessionCacheEntry {
    results: IScanCleanupDetectionResult[];
    signatures: Map<number, string>;
    state: TScanCleanupDetectionJobState;
    totalPages: number;
}

const detectionSessionCache = new Map<string, IDetectionSessionCacheEntry>();
const autoDetectionCanceledDocuments = new Set<string>();

export const useScanCleanupWorkspaceSession = (options: IUseScanCleanupWorkspaceSessionOptions) => {
    const { t } = useTypedI18n();
    const initialPreviewPage = Math.max(1, Math.trunc(options.initialPreviewPage?.() ?? options.currentPage()));
    const selectionLeader = ref(initialPreviewPage);
    const selectionAnchor = ref(initialPreviewPage);
    const selectedPages = shallowRef<ReadonlySet<number>>(new Set([initialPreviewPage]));
    const previewPage = selectionLeader;
    const previewResult = shallowRef<IScanCleanupPreviewResult | null>(null);
    const previewLoading = ref(false);
    const previewError = ref('');
    const previewViewMode = ref<'original' | 'cleaned'>(options.initialPreviewViewMode?.() ?? 'cleaned');
    const previewZoomMode = ref<'fit' | 'actual'>(options.initialPreviewZoomMode?.() ?? 'fit');
    const persistedPreferences = loadScanCleanupPreferences();
    const {
        firstRunGuidanceDismissed: persistedFirstRunGuidanceDismissed,
        runOcrAfterCleanup: persistedRunOcrAfterCleanup,
        ...persistedSettings
    } = persistedPreferences;
    const firstRunGuidanceDismissed = ref(persistedFirstRunGuidanceDismissed);
    const runOcrAfterCleanup = ref(persistedRunOcrAfterCleanup);
    const cancelRequested = ref(false);
    const detectionCancelRequested = ref(false);
    const detectionStarting = ref(false);
    const autoDetectionPending = ref(false);
    const detectionJobState = shallowRef<TScanCleanupDetectionJobState | null>(null);
    const detectionError = ref('');
    const detectionSignatures = new Map<number, string>();
    let detectionJobId: string | null = null;
    let detectionDocumentKey: string | null = null;
    let stopDetectionSubscription: (() => void) | null = null;
    let disposed = false;
    const previewCache = new Map<string, IScanCleanupPreviewResult>();
    const previewClassifications = reactive(new Map<number, IScanCleanupPreviewResult['pageMetadata']['layoutClassification']>());
    const previewConfidences = reactive(new Map<number, number>());
    const sourcePath = computed(options.sourcePath);
    const totalPages = computed(options.totalPages);
    const preferenceDocumentKey = computed(() => options.documentKey() ?? sourcePath.value);
    const settings = reactive<IScanCleanupOptions>({
        ...persistedSettings,
        pageOverrides: {},
    });
    const previewPrefetcher = createScanCleanupPreviewPrefetcher<IScanCleanupPreviewRequest, IScanCleanupPreviewResult>({
        isCached: key => previewCache.has(key),
        preview: request => {
            const capability = getScanCleanupCapability();
            if (!capability) {
                return Promise.reject(new Error('Scan cleanup preview is unavailable'));
            }
            return capability.preview(request);
        },
        store: cachePreview,
    });
    let previewSequence = 0;
    let previewTimer: ReturnType<typeof setTimeout> | null = null;

    const layoutItems = computed(() => [
        {
            value: 'auto' as const,
            label: t('scanCleanup.layout.auto'),
        },
        {
            value: 'force-single' as const,
            label: t('scanCleanup.layout.single'),
        },
        {
            value: 'force-two-page' as const,
            label: t('scanCleanup.layout.twoPage'),
        },
    ]);
    const readingOrderItems = computed(() => [
        {
            value: 'ltr' as const,
            label: t('scanCleanup.layout.leftToRight'),
        },
        {
            value: 'rtl' as const,
            label: t('scanCleanup.layout.rightToLeft'),
        },
    ]);
    const outputItems = computed(() => [
        {
            value: 'bw' as const,
            label: t('scanCleanup.output.bwShort'),
            fullLabel: t('scanCleanup.output.bw'),
        },
        {
            value: 'grayscale' as const,
            label: t('scanCleanup.output.grayscaleShort'),
            fullLabel: t('scanCleanup.output.grayscale'),
        },
        {
            value: 'color' as const,
            label: t('scanCleanup.output.colorShort'),
            fullLabel: t('scanCleanup.output.color'),
        },
    ]);
    const alignmentIcons: Array<{
        value: TScanCleanupPageAlignment;
        icon: string;
    }> = [
        {
            value: 'top-left',
            icon: 'i-ph-arrow-up-left',
        },
        {
            value: 'top-center',
            icon: 'i-ph-arrow-up',
        },
        {
            value: 'top-right',
            icon: 'i-ph-arrow-up-right',
        },
        {
            value: 'center-left',
            icon: 'i-ph-arrow-left',
        },
        {
            value: 'center',
            icon: 'i-ph-dot-outline',
        },
        {
            value: 'center-right',
            icon: 'i-ph-arrow-right',
        },
        {
            value: 'bottom-left',
            icon: 'i-ph-arrow-down-left',
        },
        {
            value: 'bottom-center',
            icon: 'i-ph-arrow-down',
        },
        {
            value: 'bottom-right',
            icon: 'i-ph-arrow-down-right',
        },
    ];
    const alignmentItems = computed(() => alignmentIcons.map(item => ({
        ...item,
        label: t(`scanCleanup.pageSize.${({
            'top-left': 'topLeft',
            'top-center': 'topCenter',
            'top-right': 'topRight',
            'center-left': 'centerLeft',
            'center': 'center',
            'center-right': 'centerRight',
            'bottom-left': 'bottomLeft',
            'bottom-center': 'bottomCenter',
            'bottom-right': 'bottomRight',
        } as const)[item.value]}`),
    })));

    const isRunning = isScanCleanupRunning;
    const inlineError = computed(() => options.active() ? scanCleanupRun.lastError : '');
    const hasIncludedPage = computed(() => Array.from({length: Math.max(1, totalPages.value)}, (_, index) => index + 1)
        .some(page => !getScanCleanupPageOverride(settings.pageOverrides, page).excluded));
    const jobProgress = computed(() => scanCleanupRun.jobState?.progress ?? {
        phase: 'queued' as const,
        processedCount: 0,
        totalPages: Math.max(1, totalPages.value),
        percent: 0,
    });
    const isDetecting = computed(() => detectionJobState.value?.status === 'queued'
        || detectionJobState.value?.status === 'running');
    const detectionPending = computed(() => autoDetectionPending.value
        || detectionStarting.value
        || isDetecting.value);
    const canRun = computed(() => Boolean(sourcePath.value)
        && !isRunning.value
        && !detectionPending.value
        && hasIncludedPage.value
        && settings.marginsMm >= 0
        && settings.marginsMm <= 25
        && getScanCleanupCapability() !== null);
    const canStartDetection = computed(() => Boolean(sourcePath.value)
        && !isRunning.value
        && !isDetecting.value
        && !detectionStarting.value
        && getScanCleanupCapability() !== null);
    const canDetectAll = computed(() => canStartDetection.value && !autoDetectionPending.value);
    const detectionProgress = computed(() => detectionJobState.value?.progress ?? {
        detectedCount: 0,
        totalPages: Math.max(1, totalPages.value),
    });
    const previewTotalPages = computed(() => previewResult.value?.totalPages ?? Math.max(1, totalPages.value));
    const processedPages = computed(() => resolveScanCleanupProcessedPages(
        scanCleanupRun.jobState,
        scanCleanupRun.ownerDocumentRef,
        sourcePath.value,
        previewTotalPages.value,
    ));
    const currentPageOverride = computed(() => getScanCleanupPageOverride(settings.pageOverrides, previewPage.value));
    const selectedPageNumbers = computed(() => [...selectedPages.value].sort((left, right) => left - right));
    const selectedPageOverrides = computed(() => selectedPageNumbers.value
        .map(page => getScanCleanupPageOverride(settings.pageOverrides, page)));
    const selectionLayoutOverride = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.layoutOverride),
    ));
    const selectionRotation = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.rotation),
    ));
    const selectionExcluded = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.excluded),
    ));
    const selectionManualSplit = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.manualSplitX),
    ));
    const selectionContentBoxes = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.manualContentBoxes ?? {}),
    ));
    const selectionPlacementAlignment = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.flatMap(override => ([
            'full',
            'left',
            'right',
        ] as const).map(half => resolveScanCleanupOutputPlacement(settings.pageAlignment, override, half))),
    ));
    const currentOutputHalves = computed<TScanCleanupOutputHalf[]>(() => {
        const halves = previewResult.value?.pageNumber === previewPage.value
            ? previewResult.value.outputs.map(output => output.metadata.half)
            : [];
        return halves.length > 0 ? halves : ['full'];
    });
    const currentPlacementAlignment = computed(() => {
        const alignments = currentOutputHalves.value.map(half => resolveScanCleanupOutputPlacement(
            settings.pageAlignment,
            currentPageOverride.value,
            half,
        ));
        return alignments.every(alignment => alignment === alignments[0])
            ? alignments[0] ?? settings.pageAlignment
            : null;
    });
    const thicknessLabel = computed(() => settings.thickness > 0 ? `+${settings.thickness}` : String(settings.thickness));
    const progressText = computed(() => t('scanCleanup.progress', {
        processed: jobProgress.value.processedCount,
        total: Math.max(jobProgress.value.totalPages, previewTotalPages.value),
    }));
    const outputEstimate = computed(() => {
        const estimate = estimateScanCleanupOutputPages(totalPages.value, settings, previewClassifications);
        if (!shouldShowScanCleanupOutputEstimate(totalPages.value, settings, previewClassifications)) {
            return '';
        }
        return t(estimate.exact ? 'scanCleanup.estimateExact' : 'scanCleanup.estimateAbout', {
            input: totalPages.value,
            output: estimate.outputPages,
        });
    });

    function updateOverrides(
        pages: Iterable<number>,
        update: Parameters<typeof updateScanCleanupPageOverrides>[2],
    ) {
        updateScanCleanupPageOverrides(settings.pageOverrides, pages, (previous, page) => {
            const value = update(previous, page);
            if (
                previous.rotation !== value.rotation
                || previous.layoutOverride !== value.layoutOverride
                || previous.manualSplitX !== value.manualSplitX
            ) {
                previewClassifications.delete(page);
                previewConfidences.delete(page);
            }
            return value;
        });
    }

    function detectionSignature(pageNumber: number) {
        const pageOverride = getScanCleanupPageOverride(settings.pageOverrides, pageNumber);
        return JSON.stringify({
            layoutMode: settings.layoutMode,
            layoutOverride: pageOverride.layoutOverride,
            rotation: pageOverride.rotation,
            manualSplitX: pageOverride.manualSplitX,
        });
    }

    function applyDetectionState(state: TScanCleanupDetectionJobState) {
        if (state.jobId !== detectionJobId) {
            return;
        }
        detectionJobState.value = state;
        applyScanCleanupDetectionResults(
            state.results,
            previewClassifications,
            previewConfidences,
            pageNumber => detectionSignatures.get(pageNumber) === detectionSignature(pageNumber),
        );
        if (state.status === 'failed') {
            detectionError.value = state.error;
        }
        if (state.status === 'completed' || state.status === 'canceled' || state.status === 'failed') {
            detectionCancelRequested.value = false;
            if (detectionDocumentKey && state.status !== 'failed') {
                detectionSessionCache.set(detectionDocumentKey, {
                    results: state.results.map(result => ({...result})),
                    signatures: new Map(detectionSignatures),
                    state: structuredClone(state),
                    totalPages: state.progress.totalPages,
                });
            }
        }
    }

    async function detectAllPages(automatic = false) {
        if (!sourcePath.value || !canStartDetection.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        detectionError.value = '';
        detectionCancelRequested.value = false;
        if (!automatic && preferenceDocumentKey.value) {
            autoDetectionCanceledDocuments.delete(preferenceDocumentKey.value);
        }
        detectionSignatures.clear();
        for (let pageNumber = 1; pageNumber <= totalPages.value; pageNumber += 1) {
            detectionSignatures.set(pageNumber, detectionSignature(pageNumber));
        }
        const requestSourcePath = sourcePath.value;
        detectionDocumentKey = preferenceDocumentKey.value;
        detectionStarting.value = true;
        let result;
        try {
            result = await capability.detectAll({
                sourcePdfPath: requestSourcePath,
                options: toPlainScanCleanupOptions(settings),
            });
        } catch (error) {
            detectionError.value = error instanceof Error ? error.message : t('scanCleanup.detectAll.failed');
            return;
        } finally {
            detectionStarting.value = false;
        }
        if (!result.started) {
            detectionError.value = result.error ?? t('scanCleanup.detectAll.failed');
            return;
        }
        if (disposed || requestSourcePath !== sourcePath.value) {
            void capability.cancelDetection(result.jobId).catch(() => undefined);
            return;
        }
        detectionJobId = result.jobId;
        detectionJobState.value = {
            jobId: result.jobId,
            status: 'queued',
            progress: {
                detectedCount: 0,
                totalPages: totalPages.value,
            },
            results: [],
            updatedAtMs: Date.now(),
        };
        const state = await capability.subscribeDetectionJob(result.jobId);
        if (state) {
            applyDetectionState(state);
        }
    }

    async function cancelDetection() {
        if (!detectionJobId || detectionCancelRequested.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        detectionCancelRequested.value = true;
        if (!await capability.cancelDetection(detectionJobId)) {
            detectionCancelRequested.value = false;
        } else if (detectionDocumentKey) {
            autoDetectionCanceledDocuments.add(detectionDocumentKey);
        }
    }

    function detectionCacheIsFresh(entry: IDetectionSessionCacheEntry) {
        if (entry.totalPages !== totalPages.value || entry.signatures.size !== totalPages.value) {
            return false;
        }
        for (let pageNumber = 1; pageNumber <= totalPages.value; pageNumber += 1) {
            if (entry.signatures.get(pageNumber) !== detectionSignature(pageNumber)) {
                return false;
            }
        }
        return entry.state.status === 'canceled'
            || (entry.state.status === 'completed' && entry.results.length === totalPages.value);
    }

    function restoreDetectionSession(key: string | null) {
        const cached = key ? detectionSessionCache.get(key) : undefined;
        if (!cached || !detectionCacheIsFresh(cached)) {
            return false;
        }
        detectionJobState.value = structuredClone(cached.state);
        detectionSignatures.clear();
        for (const [
            pageNumber,
            signature,
        ] of cached.signatures) {
            detectionSignatures.set(pageNumber, signature);
        }
        applyScanCleanupDetectionResults(
            cached.results,
            previewClassifications,
            previewConfidences,
        );
        return true;
    }

    async function maybeAutoDetect() {
        const key = preferenceDocumentKey.value;
        if (
            disposed
            || !options.active()
            || !sourcePath.value
            || !canStartDetection.value
            || restoreDetectionSession(key)
            || (key !== null && autoDetectionCanceledDocuments.has(key))
        ) {
            autoDetectionPending.value = false;
            return;
        }
        autoDetectionPending.value = true;
        try {
            await detectAllPages(true);
        } finally {
            autoDetectionPending.value = false;
        }
    }

    function dismissFirstRunGuidance() {
        firstRunGuidanceDismissed.value = true;
    }

    function updatePageOverride(page: number, value: IScanCleanupPageOverride) {
        updateOverrides([page], () => value);
    }

    function updateSelectionLayoutOverride(value: TScanCleanupPageLayoutOverride) {
        updateOverrides(selectedPages.value, current => ({
            ...current,
            layoutOverride: value,
        }));
    }

    function updateSelectionRotation(value: TScanCleanupPageRotation) {
        updateOverrides(selectedPages.value, current => ({
            ...current,
            rotation: value,
        }));
    }

    function updateSelectionExcluded(value: boolean) {
        updateOverrides(selectedPages.value, current => ({
            ...current,
            excluded: value,
        }));
    }

    function resetSelectionManualSplit() {
        updateOverrides(selectedPages.value, current => ({
            ...current,
            manualSplitX: null,
        }));
    }

    function resetSelectionContentBoxes() {
        updateOverrides(selectedPages.value, current => ({
            ...current,
            manualContentBoxes: {},
        }));
    }

    function updateSelectionPlacement(value: TScanCleanupPageAlignment) {
        updateOverrides(selectedPages.value, current => ({
            ...current,
            placementOverrides: {
                ...current.placementOverrides,
                full: value,
                left: value,
                right: value,
            },
        }));
    }

    function applyLeaderOverrides(scope: TScanCleanupApplyScope) {
        const leaderOverride = currentPageOverride.value;
        const pages = resolveScanCleanupApplyScope({
            leader: selectionLeader.value,
            pageCount: previewTotalPages.value,
            selectedPages: selectedPages.value,
        }, scope);
        updateOverrides(pages, () => leaderOverride);
    }

    function updateCurrentManualSplit(value: number | null) {
        updatePageOverride(previewPage.value, {
            ...currentPageOverride.value,
            manualSplitX: value,
        });
    }

    function updateCurrentManualContentBox(
        half: TScanCleanupOutputHalf,
        value: IScanCleanupPreviewRect | null,
    ) {
        const manualContentBoxes = {...currentPageOverride.value.manualContentBoxes};
        if (value) manualContentBoxes[half] = value;
        else Reflect.deleteProperty(manualContentBoxes, half);
        updatePageOverride(previewPage.value, {
            ...currentPageOverride.value,
            manualContentBoxes,
        });
    }

    function updateCurrentPlacement(
        half: TScanCleanupOutputHalf,
        value: TScanCleanupPageAlignment | null,
    ) {
        const placementOverrides = {...currentPageOverride.value.placementOverrides};
        if (value) placementOverrides[half] = value;
        else Reflect.deleteProperty(placementOverrides, half);
        updatePageOverride(previewPage.value, {
            ...currentPageOverride.value,
            placementOverrides,
        });
    }

    function updateCurrentPlacementAll(value: TScanCleanupPageAlignment) {
        settings.pageAlignment = value;
    }

    function resetPageOverrides() {
        settings.pageOverrides = {};
        previewClassifications.clear();
        previewConfidences.clear();
        resetScanCleanupDocumentOverrides(preferenceDocumentKey.value);
    }

    function handleThicknessInput(value: number | number[]) {
        settings.thickness = Array.isArray(value) ? (value[0] ?? 0) : value;
    }

    function previewCacheKey(
        pageNumber = previewPage.value,
        previewOptions = toPlainScanCleanupOptions(settings),
        previewSourcePath = sourcePath.value,
    ) {
        return JSON.stringify({
            sourcePath: previewSourcePath,
            page: pageNumber,
            options: previewOptions,
        });
    }

    function cachePreview(key: string, result: IScanCleanupPreviewResult) {
        previewCache.set(key, result);
        previewClassifications.set(result.pageNumber, result.pageMetadata.layoutClassification);
        const confidence = result.outputs[0]?.metadata.layoutConfidence;
        if (confidence !== undefined) previewConfidences.set(result.pageNumber, confidence);
    }

    function clearPreviewTimer() {
        if (previewTimer !== null) {
            clearTimeout(previewTimer);
        }
        previewTimer = null;
    }

    function queuePreviewTask(task: () => Promise<void>, immediate: boolean) {
        previewTimer = setTimeout(() => { void task(); }, immediate ? 0 : 250);
    }

    function cancelPreview(invalidateRawCache = true) {
        previewSequence += 1;
        previewPrefetcher.supersede();
        clearPreviewTimer();
        previewLoading.value = false;
        if (!sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            return;
        }
        const cancellation = invalidateRawCache
            ? capability.cancelPreview(sourcePath.value)
            : capability.cancelPreview(sourcePath.value, false);
        void cancellation.catch(() => undefined);
    }

    function scheduleAdjacentPrefetch(
        result: IScanCleanupPreviewResult,
        previewOptions: IScanCleanupOptions,
        previewSourcePath: string,
    ) {
        const adjacentPages = [
            result.pageNumber + 1,
            result.pageNumber - 1,
        ].filter(pageNumber => pageNumber >= 1 && pageNumber <= result.totalPages);
        previewPrefetcher.schedule(adjacentPages.map(pageNumber => ({
            key: previewCacheKey(pageNumber, previewOptions, previewSourcePath),
            request: {
                sourcePdfPath: previewSourcePath,
                pageNumber,
                options: previewOptions,
            },
        })));
    }

    function schedulePreview() {
        if (!options.active() || !sourcePath.value) {
            return;
        }
        const capability = getScanCleanupCapability();
        if (!capability) {
            previewError.value = t('scanCleanup.preview.unavailable');
            return;
        }
        previewPrefetcher.supersede();
        void capability.cancelPreview(sourcePath.value, false).catch(() => undefined);
        const sequence = ++previewSequence;
        clearPreviewTimer();
        const requestPage = previewPage.value;
        const requestOptions = toPlainScanCleanupOptions(settings);
        const requestSourcePath = sourcePath.value;
        const key = previewCacheKey(requestPage, requestOptions, requestSourcePath);
        const cached = previewCache.get(key);
        if (cached) {
            previewResult.value = cached;
            previewLoading.value = false;
            previewError.value = '';
            scheduleAdjacentPrefetch(cached, requestOptions, requestSourcePath);
            return;
        }
        previewLoading.value = true;
        previewError.value = '';
        const runPreview = async () => {
            previewTimer = null;
            try {
                const result = await capability.preview({
                    sourcePdfPath: requestSourcePath,
                    pageNumber: requestPage,
                    options: requestOptions,
                });
                if (sequence !== previewSequence) {
                    return;
                }
                cachePreview(key, result);
                previewResult.value = result;
                scheduleAdjacentPrefetch(result, requestOptions, requestSourcePath);
            } catch (error) {
                if (sequence !== previewSequence || (error instanceof Error && error.name === 'AbortError')) {
                    return;
                }
                previewError.value = error instanceof Error ? error.message : t('scanCleanup.preview.unavailable');
            } finally {
                if (sequence === previewSequence) {
                    previewLoading.value = false;
                }
            }
        };
        queuePreviewTask(runPreview, Boolean(previewResult.value && previewResult.value.pageNumber !== requestPage));
    }

    function retryPreview() {
        previewCache.delete(previewCacheKey(previewPage.value));
        schedulePreview();
    }

    function navigatePreview(delta: number) {
        const page = Math.min(previewTotalPages.value, Math.max(1, previewPage.value + delta));
        selectPage(page, 'single', Array.from({length: previewTotalPages.value}, (_, index) => index + 1));
    }

    function selectPage(
        page: number,
        intent: TScanCleanupSelectionIntent,
        orderedPages: readonly number[],
    ) {
        const selection = resolveScanCleanupSelection({
            anchor: selectionAnchor.value,
            leader: selectionLeader.value,
            selectedPages: selectedPages.value,
        }, page, intent, orderedPages);
        selectionAnchor.value = selection.anchor;
        selectionLeader.value = selection.leader;
        selectedPages.value = selection.selectedPages;
    }

    async function run() {
        if (!sourcePath.value || !canRun.value) {
            return;
        }
        cancelPreview(false);
        cancelRequested.value = false;
        scanCleanupRun.lastError = '';
        const result = await startScanCleanup({
            sourcePdfPath: sourcePath.value,
            options: toPlainScanCleanupOptions(settings),
            runOcrAfterCleanup: runOcrAfterCleanup.value,
        });
        if (!result.started) {
            scanCleanupRun.lastError = result.error ?? t('scanCleanup.failed');
        }
    }

    async function cancel() {
        if (cancelRequested.value) {
            return;
        }
        cancelRequested.value = true;
        const requested = await cancelScanCleanup();
        if (!requested) {
            cancelRequested.value = false;
        }
    }

    watch(options.active, (active) => {
        scanCleanupRun.workspaceOpen = active;
        if (active) {
            const page = Math.min(Math.max(1, selectionLeader.value), previewTotalPages.value);
            selectionAnchor.value = page;
            selectionLeader.value = page;
            selectedPages.value = new Set([page]);
            schedulePreview();
            void nextTick(maybeAutoDetect);
        } else {
            cancelPreview();
        }
    }, {immediate: true});
    onMounted(() => {
        const capability = getScanCleanupCapability();
        stopDetectionSubscription = capability?.onDetectionJobState(applyDetectionState) ?? null;
        void maybeAutoDetect();
    });
    watch(preferenceDocumentKey, (key) => {
        if (detectionJobId && isDetecting.value) {
            void getScanCleanupCapability()?.cancelDetection(detectionJobId).catch(() => undefined);
        }
        detectionJobId = null;
        detectionDocumentKey = key;
        detectionJobState.value = null;
        detectionCancelRequested.value = false;
        detectionError.value = '';
        detectionSignatures.clear();
        previewCache.clear();
        previewClassifications.clear();
        previewConfidences.clear();
        previewResult.value = null;
        settings.pageOverrides = loadScanCleanupDocumentOverrides(key);
        autoDetectionPending.value = Boolean(options.active() && sourcePath.value);
        void nextTick(maybeAutoDetect);
    }, {immediate: true});
    watch(() => ({
        preserveOriginalQuality: settings.preserveOriginalQuality === true,
        layoutMode: settings.layoutMode,
        outputMode: settings.outputMode,
        readingOrder: settings.readingOrder,
        thickness: settings.thickness,
        crop: settings.crop,
        matchPageSize: settings.matchPageSize,
        pageAlignment: settings.pageAlignment,
        marginsMm: settings.marginsMm,
        despeckle: settings.despeckle,
        skipBlankPages: settings.skipBlankPages,
        straightenCurvedLines: settings.straightenCurvedLines,
        firstRunGuidanceDismissed: firstRunGuidanceDismissed.value,
        runOcrAfterCleanup: runOcrAfterCleanup.value,
    }), preferences => saveScanCleanupPreferences(preferences), {deep: true});
    watch(() => settings.pageOverrides, (overrides) => {
        saveScanCleanupDocumentOverrides(preferenceDocumentKey.value, overrides);
    }, {deep: true});
    watch(() => settings.layoutMode, () => {
        previewClassifications.clear();
        previewConfidences.clear();
    });
    watch(() => [
        sourcePath.value,
        previewPage.value,
        {...settings},
    ] as const, schedulePreview, {deep: true});
    watch(isRunning, (running) => {
        if (!running) {
            cancelRequested.value = false;
            if (scanCleanupRun.jobState?.status === 'completed') {
                firstRunGuidanceDismissed.value = true;
            }
            if (options.active()) {
                schedulePreview();
                void maybeAutoDetect();
            }
        }
    });
    onBeforeUnmount(() => {
        disposed = true;
        stopDetectionSubscription?.();
        stopDetectionSubscription = null;
        if (detectionJobId && isDetecting.value) {
            void getScanCleanupCapability()?.cancelDetection(detectionJobId).catch(() => undefined);
        }
        cancelPreview();
        if (options.active()) {
            scanCleanupRun.workspaceOpen = false;
        }
    });

    return {
        alignmentItems,
        applyLeaderOverrides,
        cancel,
        cancelRequested,
        cancelDetection,
        canDetectAll,
        canRun,
        currentPageOverride,
        currentPlacementAlignment,
        handleThicknessInput,
        inlineError,
        detectAllPages,
        detectionCancelRequested,
        detectionError,
        detectionPending,
        detectionProgress,
        isDetecting,
        isRunning,
        jobProgress,
        layoutItems,
        navigatePreview,
        outputEstimate,
        outputItems,
        previewClassifications,
        previewConfidences,
        previewError,
        previewLoading,
        previewPage,
        processedPages,
        previewResult,
        previewTotalPages,
        previewViewMode,
        previewZoomMode,
        progressText,
        readingOrderItems,
        resetPageOverrides,
        retryPreview,
        run,
        runOcrAfterCleanup,
        showFirstRunGuidance: computed(() => !firstRunGuidanceDismissed.value),
        dismissFirstRunGuidance,
        selectedPages,
        selectionLeader,
        selectionContentBoxes,
        selectionExcluded,
        selectionLayoutOverride,
        selectionManualSplit,
        selectionPlacementAlignment,
        selectionRotation,
        selectPage,
        settings,
        thicknessLabel,
        resetSelectionContentBoxes,
        resetSelectionManualSplit,
        updateCurrentManualSplit,
        updateCurrentManualContentBox,
        updateCurrentPlacement,
        updateCurrentPlacementAll,
        updatePageOverride,
        updateSelectionExcluded,
        updateSelectionLayoutOverride,
        updateSelectionPlacement,
        updateSelectionRotation,
    };
};
