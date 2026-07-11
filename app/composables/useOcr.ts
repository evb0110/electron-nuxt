import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useTimeoutFn } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import type { IOcrLanguage } from '@contracts/shared';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IOcrCapability,
    IOcrCancelResult,
    IOcrErrorEnvelope,
    IOcrSearchablePdfOptions,
    IOcrDiagnostic,
} from '@contracts/electronApiOcr';
import { createDocxFromText } from '@app/utils/docx';
import { OCR_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import type {
    IOcrUiProgress,
    IOcrResults,
    IOcrSettings,
} from '@app/utils/ocr/ocrTypes';
import { parsePageRange } from '@app/utils/ocr/parsePageRange';
import { hasRtlOcrLanguage } from '@app/utils/ocr/hasRtlOcrLanguage';
import { resolveOcrExportLanguages } from '@app/utils/ocr/resolveOcrExportLanguages';
import {
    createOcrRunLifecycle,
    OcrRunCanceledError,
    type TOcrRunGuard,
} from '@app/utils/ocr/ocrRunLifecycle';
import { useOcrErrorLocalizer } from '@app/composables/useOcrErrorLocalizer';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { getErrorMessage } from '@app/utils/error';
import { exportTextAsDocx } from '@app/utils/exportTextAsDocx';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';

class OcrJobStartError extends Error {
    readonly errorEnvelope: IOcrErrorEnvelope | undefined;

    constructor(message: string, errorEnvelope?: IOcrErrorEnvelope) {
        super(message);
        this.name = 'OcrJobStartError';
        this.errorEnvelope = errorEnvelope;
    }
}

type TOcrCompleteResult = Parameters<IOcrCapability['onComplete']>[0] extends (
    result: infer TResult,
) => void ? TResult : never;
type TOcrPageRequest = Parameters<IOcrCapability['createSearchablePdf']>[1][number];
const OCR_CANCEL_COMPLETION_GRACE_MS = 5_000;

export const useOcr = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { localizeOcrError } = useOcrErrorLocalizer();

    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>({
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
        qualityProfile: 'balanced',
        preprocessingMode: 'off',
        pageSegmentationMode: null,
        supersessionPolicy: 'missing-only',
        replaceAllAcknowledged: false,
    });
    const progress = ref<IOcrUiProgress>({
        isRunning: false,
        status: 'idle',
        phase: 'preparing',
        currentPage: 0,
        totalPages: 0,
        processedCount: 0,
        phaseProgress: null,
    });
    const results = ref<IOcrResults>({
        pages: new Map(),
        languages: [],
        completedAt: null,
        searchablePdfResult: null,
    });
    const error = ref<string | null>(null);
    const isExporting = ref(false);

    const activeRunSettings = ref<IOcrSettings | null>(null);
    const lastCompletedRunSettings = ref<IOcrSettings | null>(null);
    const ocrRunLifecycle = createOcrRunLifecycle();

    let progressCleanup: (() => void) | null = null;
    let completeCleanup: (() => void) | null = null;
    let timeoutRunToken: symbol | null = null;
    let pendingOcrReject: ((reason?: unknown) => void) | null = null;
    let cancelCleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function clearCancelCleanupTimer() {
        if (cancelCleanupTimer !== null) {
            clearTimeout(cancelCleanupTimer);
            cancelCleanupTimer = null;
        }
    }

    function finishCancelCompletionWatch(requestId: string) {
        if (!ocrRunLifecycle.finishCancelingRequest(requestId)) {
            return;
        }
        clearCancelCleanupTimer();
        completeCleanup?.();
        completeCleanup = null;
        progress.value.isRunning = false;
        progress.value.status = 'cancelled';
    }

    function cleanupRunState(options: {
        keepCompleteListener?: boolean;
        keepActiveRequestId?: boolean
    } = {}) {
        if (options.keepActiveRequestId !== true) {
            ocrRunLifecycle.clearActiveRequest();
        }
        progress.value.isRunning = false;
        progress.value.status = 'idle';
        activeRunSettings.value = null;
        progressCleanup?.();
        progressCleanup = null;
        if (options.keepCompleteListener !== true) {
            completeCleanup?.();
            completeCleanup = null;
        }
        clearOcrTimeout();
        pendingOcrReject = null;
    }

    function clearOcrTimeout() {
        stopOcrTimeout();
        timeoutRunToken = null;
    }

    async function cancelBackendRequest(
        requestIdToCancel: string,
        reason: 'manual' | 'timeout',
    ): Promise<IOcrCancelResult> {
        if (!requestIdToCancel) {
            return {
                canceled: false,
                reason: 'not-found',
            };
        }

        BrowserLogger.info('ocr', reason === 'timeout' ? 'Cancelling timed-out OCR' : 'Cancelling OCR', { requestId: requestIdToCancel });
        try {
            return await getOcrCapability().cancel(requestIdToCancel);
        } catch (cancelError) {
            const normalizedCancelError: unknown = cancelError;
            BrowserLogger.debug('ocr', 'OCR cancel request failed', {
                requestId: requestIdToCancel,
                error: normalizedCancelError,
            });
            return {
                canceled: false,
                reason: 'failed',
                error: getErrorMessage(cancelError),
            };
        }
    }

    function scheduleCancelCompletionWatch(requestId: string) {
        clearCancelCleanupTimer();
        cancelCleanupTimer = setTimeout(() => {
            BrowserLogger.debug('ocr', 'OCR cancel completion watch timed out', { requestId });
            finishCancelCompletionWatch(requestId);
        }, OCR_CANCEL_COMPLETION_GRACE_MS);
    }

    function cleanupLateCanceledResult(result: TOcrCompleteResult) {
        if (!ocrRunLifecycle.shouldHandleLateCanceledResult(result.requestId)) {
            return;
        }

        BrowserLogger.debug('ocr', 'Terminal OCR result arrived after cancellation', {
            requestId: result.requestId,
            success: result.success,
            requiresCleanupAck: result.requiresCleanupAck === true,
        });
        if (result.requiresCleanupAck === true && result.pdfPath) {
            void getOcrCapability().acknowledgeResultFile(result.requestId, result.pdfPath)
                .catch((ackError) => {
                    BrowserLogger.debug('ocr', 'Late canceled OCR cleanup acknowledgement failed', {
                        requestId: result.requestId,
                        error: getErrorMessage(ackError),
                    });
                });
        }
        finishCancelCompletionWatch(result.requestId);
    }

    function beginCancelingRequest(requestId: string) {
        ocrRunLifecycle.beginCancelingRequest(requestId);
        scheduleCancelCompletionWatch(requestId);
        cleanupRunState({
            keepCompleteListener: true,
            keepActiveRequestId: true,
        });
        progress.value.isRunning = true;
        progress.value.status = 'cancel-requested';
    }

    const {
        start: startOcrTimeout,
        stop: stopOcrTimeout,
    } = useTimeoutFn(() => {
        const runToken = timeoutRunToken;
        if (runToken === null || !ocrRunLifecycle.isRunTokenActive(runToken)) {
            return;
        }
        const rejectPending = pendingOcrReject;
        pendingOcrReject = null;
        timeoutRunToken = null;
        const requestIdToCancel = ocrRunLifecycle.getActiveRequestId();
        if (requestIdToCancel) {
            ocrRunLifecycle.cancelActiveRun();
            beginCancelingRequest(requestIdToCancel);
            void cancelBackendRequest(requestIdToCancel, 'timeout');
        }
        rejectPending?.(new Error(t('errors.ocr.timeout')));
    }, OCR_TIMEOUT_MS, { immediate: false });

    async function loadLanguages() {
        try {
            const languages = await getOcrCapability().getLanguages();
            if (!disposed) {
                availableLanguages.value = languages;
            }
        } catch (e) {
            if (!disposed) {
                error.value = localizeOcrError(e, 'errors.ocr.loadLanguages');
            }
        }
    }

    function cloneOcrSettings(source: IOcrSettings): IOcrSettings {
        return {
            pageRange: source.pageRange,
            customRange: source.customRange,
            selectedLanguages: [...source.selectedLanguages],
            qualityProfile: source.qualityProfile,
            preprocessingMode: source.preprocessingMode,
            pageSegmentationMode: source.pageSegmentationMode,
            supersessionPolicy: source.supersessionPolicy,
            replaceAllAcknowledged: source.replaceAllAcknowledged,
        };
    }

    function createRunSettingsSnapshot(source: IOcrSettings): IOcrSettings {
        return {
            pageRange: source.pageRange,
            customRange: source.customRange,
            selectedLanguages: uniq(
                source.selectedLanguages
                    .map(language => language.trim())
                    .filter(Boolean),
            ),
            qualityProfile: source.qualityProfile,
            preprocessingMode: source.preprocessingMode,
            pageSegmentationMode: source.pageSegmentationMode,
            supersessionPolicy: source.supersessionPolicy,
            replaceAllAcknowledged: source.replaceAllAcknowledged,
        };
    }

    function getDocxExportLanguages() {
        return resolveOcrExportLanguages(
            lastCompletedRunSettings.value,
            activeRunSettings.value,
            settings.value,
        );
    }

    function beginRunProgress(pages: number[], runSettings: IOcrSettings) {
        activeRunSettings.value = cloneOcrSettings(runSettings);
        progress.value = {
            isRunning: true,
            status: 'running',
            phase: 'preparing',
            currentPage: pages[0] ?? 1,
            totalPages: pages.length,
            processedCount: 0,
            phaseProgress: null,
        };
    }

    async function waitForRunUiReady(runToken: symbol, runGeneration: number) {
        await nextTick();
        if (!ocrRunLifecycle.isRunActive(runToken, runGeneration)) {
            return false;
        }

        await waitForVisualFrames({ frames: 2 });
        return ocrRunLifecycle.isRunActive(runToken, runGeneration);
    }

    function resetOcrTimeout(runToken: symbol) {
        timeoutRunToken = runToken;
        startOcrTimeout();
    }

    function registerProgressListener(
        ocr: IOcrCapability,
        requestId: string,
        runToken: symbol,
    ) {
        progressCleanup = ocr.onProgress((p) => {
            if (!ocrRunLifecycle.isRunTokenActive(runToken)) {
                return;
            }
            BrowserLogger.debug('ocr', 'Progress update', {
                ...p,
                requestId,
            });
            if (p.requestId === requestId) {
                resetOcrTimeout(runToken);
                progress.value.phase = p.phase ?? 'processing';
                progress.value.currentPage = p.currentPage;
                progress.value.processedCount = p.processedCount;
                progress.value.phaseProgress = typeof p.phaseProgress === 'number'
                    ? p.phaseProgress
                    : null;
            }
        });
    }

    function waitForOcrCompletion(
        ocr: IOcrCapability,
        requestId: string,
        runToken: symbol,
    ) {
        return new Promise<TOcrCompleteResult>((resolve, reject) => {
            let didResolve = false;
            pendingOcrReject = reject;

            completeCleanup = ocr.onComplete((result) => {
                BrowserLogger.debug('ocr', 'Complete event received', {
                    requestId,
                    resultRequestId: result.requestId,
                    success: result.success,
                    didResolve,
                });
                if (result.requestId !== requestId) {
                    return;
                }
                if (!ocrRunLifecycle.isRunTokenActive(runToken)) {
                    cleanupLateCanceledResult(result);
                    return;
                }
                if (didResolve) {
                    BrowserLogger.debug('ocr', 'Ignoring duplicate completion', { requestId });
                    return;
                }
                didResolve = true;
                pendingOcrReject = null;
                clearOcrTimeout();
                resolve(result);
            });

            resetOcrTimeout(runToken);
        });
    }

    function buildPageRequests(pages: number[], runSettings: IOcrSettings): TOcrPageRequest[] {
        const languages = [...runSettings.selectedLanguages];
        return pages.map(pageNum => ({
            pageNumber: pageNum,
            languages,
        }));
    }

    function buildSearchablePdfOptions(runSettings: IOcrSettings): IOcrSearchablePdfOptions {
        const options: IOcrSearchablePdfOptions = {
            qualityProfile: runSettings.qualityProfile,
            preprocessingMode: runSettings.preprocessingMode,
            supersessionPolicy: runSettings.supersessionPolicy,
            ...(runSettings.supersessionPolicy === 'replace-all'
                ? {replaceAllAcknowledged: runSettings.replaceAllAcknowledged}
                : {}),
        };
        if (runSettings.pageSegmentationMode !== null) {
            options.pageSegmentationMode = runSettings.pageSegmentationMode;
        }
        return options;
    }

    function applyOcrResponseErrors(response: TOcrCompleteResult, requestId: string) {
        const diagnosticWarnings = response.diagnostics?.filter(diagnostic => diagnostic.severity === 'warning') ?? [];
        if (response.errors.length === 0 && response.errorEnvelope === undefined && diagnosticWarnings.length === 0) {
            return;
        }

        BrowserLogger.error('ocr', 'OCR backend reported page failures', {
            requestId,
            success: response.success,
            errors: response.errors,
            errorCode: response.errorEnvelope?.code,
        });
        if (response.errorEnvelope !== undefined) {
            error.value = localizeOcrError(response.errorEnvelope, 'errors.ocr.createSearchablePdf');
            return;
        }

        if (response.errors.length === 0 && diagnosticWarnings.length > 0) {
            error.value = uniq(diagnosticWarnings.map(localizeOcrDiagnostic)).join('; ');
            return;
        }

        const localizedErrors = response.errors.map(err =>
            localizeOcrError(err, 'errors.ocr.createSearchablePdf'),
        );
        error.value = uniq(localizedErrors).join('; ');
    }

    function localizeOcrDiagnostic(diagnostic: IOcrDiagnostic) {
        const params = {page: diagnostic.pageNumber ?? 0};
        switch (diagnostic.code) {
            case 'OCR_PREPROCESSING_UNAVAILABLE':
                return t('ocr.diagnostic.preprocessingUnavailable', params);
            case 'OCR_PREPROCESSING_FAILED':
                return t('ocr.diagnostic.preprocessingFailed', params);
            case 'OCR_PREPROCESSING_GEOMETRY_CHANGED':
                return t('ocr.diagnostic.preprocessingGeometryChanged', params);
            case 'OCR_SOURCE_DPI_LIMITED':
                return t('ocr.diagnostic.sourceDpiLimited', params);
            case 'OCR_EXISTING_TEXT_SKIPPED':
                return t('ocr.diagnostic.existingTextSkipped', params);
        }
    }

    function storeOcrPdfResult(
        requestId: string,
        response: TOcrCompleteResult,
        runSettings: IOcrSettings,
    ) {
        if (!response.pdfPath) {
            throw new Error(t('errors.ocr.noPdfData'));
        }
        if (!response.sourceDocumentRevisionToken) {
            throw new Error(t('errors.ocr.noPdfData'));
        }

        BrowserLogger.debug('ocr', 'Storing OCR PDF result path', {
            requestId,
            path: response.pdfPath,
            sourceDocumentRevisionToken: response.sourceDocumentRevisionToken,
            requiresCleanupAck: response.requiresCleanupAck === true,
        });

        lastCompletedRunSettings.value = cloneOcrSettings(runSettings);
        results.value = {
            pages: new Map(),
            languages: [...runSettings.selectedLanguages],
            completedAt: Date.now(),
            searchablePdfResult: {
                requestId,
                pdfPath: response.pdfPath,
                sourceDocumentRevisionToken: response.sourceDocumentRevisionToken,
                requiresCleanupAck: response.requiresCleanupAck === true,
            },
        };
    }

    function logOcrRunFailure(requestId: string, caughtError: unknown) {
        const errMsg = getErrorMessage(caughtError);
        const errStack = caughtError instanceof Error ? caughtError.stack : undefined;
        BrowserLogger.error('ocr', 'OCR run failed', {
            requestId,
            error: errMsg,
        });
        if (errStack) {
            BrowserLogger.error('ocr', 'OCR stack trace', {
                requestId,
                stack: errStack,
            });
        }
    }

    function validateOcrRunRequest(
        pages: number[],
        workingCopyPath: TDocumentRef | null,
        runSettings: IOcrSettings,
    ): workingCopyPath is TDocumentRef {
        if (runSettings.selectedLanguages.length === 0) {
            error.value = t('errors.ocr.noLanguages');
            return false;
        }
        if (pages.length === 0) {
            error.value = t('errors.ocr.noValidPages');
            return false;
        }
        if (!workingCopyPath) {
            error.value = t('errors.file.invalid');
            return false;
        }
        return true;
    }

    function getSelectedOcrPages(
        currentPage: number,
        totalPages: number,
        runSettings: IOcrSettings,
    ) {
        const pages = parsePageRange(
            runSettings.pageRange,
            runSettings.customRange,
            currentPage,
            totalPages,
        );

        BrowserLogger.debug('ocr', 'Pages selected', pages);
        return pages;
    }

    function createOcrRequestId(pages: number[]) {
        const requestId = `ocr-${crypto.randomUUID()}`;
        BrowserLogger.info('ocr', 'Request created', {
            requestId,
            pages: pages.length,
        });
        ocrRunLifecycle.markRequestActive(requestId);
        return requestId;
    }

    function handleOcrResponse(
        requestId: string,
        response: TOcrCompleteResult,
        ensureRunActive: TOcrRunGuard,
        runSettings: IOcrSettings,
    ) {
        applyOcrResponseErrors(response, requestId);

        if (response.pdfPath) {
            ensureRunActive();
            storeOcrPdfResult(requestId, response, runSettings);
        } else if (response.success) {
            throw new Error(t('errors.ocr.noPdfData'));
        } else if (!response.success) {
            if (error.value === null || error.value.length === 0) {
                error.value = t('errors.ocr.createSearchablePdf');
            }
        }
    }

    async function executeOcrRun(
        requestId: string,
        pages: number[],
        workingCopyPath: TDocumentRef,
        runSettings: IOcrSettings,
        runToken: symbol,
        ensureRunActive: TOcrRunGuard,
    ) {
        const ocr = getOcrCapability();
        registerProgressListener(ocr, requestId, runToken);
        const pageRequests = buildPageRequests(pages, runSettings);

        BrowserLogger.debug('ocr', 'Starting backend job', {
            requestId,
            pages,
            workingCopyPath,
        });

        ensureRunActive();
        const ocrPromise = waitForOcrCompletion(ocr, requestId, runToken);

        ensureRunActive();
        const startResult = await ocr.createSearchablePdf(
            workingCopyPath,
            pageRequests,
            requestId,
            buildSearchablePdfOptions(runSettings),
        );
        ensureRunActive();

        BrowserLogger.debug('ocr', 'Job started', {
            requestId,
            ...startResult,
        });

        if (!startResult.started) {
            throw new OcrJobStartError(
                localizeOcrError(startResult.errorEnvelope ?? startResult.error, 'errors.ocr.start'),
                startResult.errorEnvelope,
            );
        }

        ensureRunActive();
        const response = await ocrPromise;
        ensureRunActive();

        BrowserLogger.debug('ocr', 'Backend response', {
            requestId,
            success: response.success,
            errors: response.errors,
        });

        handleOcrResponse(requestId, response, ensureRunActive, runSettings);
    }

    async function runOcr(
        currentPage: number,
        totalPages: number,
        workingCopyPath: TDocumentRef | null = null,
    ) {
        BrowserLogger.debug('ocr', 'runOcr called', {
            currentPage,
            totalPages,
            workingCopyPath,
        });

        if (progress.value.isRunning || ocrRunLifecycle.getCancelingRequestId() !== null) {
            BrowserLogger.debug('ocr', 'runOcr ignored; already running');
            return;
        }

        error.value = null;
        const runSettings = createRunSettingsSnapshot(settings.value);
        const pages = getSelectedOcrPages(currentPage, totalPages, runSettings);
        clearResults();

        if (!validateOcrRunRequest(pages, workingCopyPath, runSettings)) {
            return;
        }

        const {
            runToken,
            runGeneration,
            ensureRunActive,
        } = ocrRunLifecycle.beginRun();

        beginRunProgress(pages, runSettings);
        if (!await waitForRunUiReady(runToken, runGeneration)) {
            return;
        }

        const requestId = createOcrRequestId(pages);

        try {
            await executeOcrRun(
                requestId,
                pages,
                workingCopyPath,
                runSettings,
                runToken,
                ensureRunActive,
            );
        } catch (e) {
            if (disposed || e instanceof OcrRunCanceledError) {
                return;
            }
            logOcrRunFailure(requestId, e);
            if (e instanceof OcrJobStartError) {
                error.value = e.message;
                return;
            }
            error.value = localizeOcrError(e, 'errors.ocr.createSearchablePdf');
        } finally {
            if (ocrRunLifecycle.clearRunIfActive(runToken)) {
                cleanupRunState();
            }
        }
    }

    async function cancelOcr(): Promise<IOcrCancelResult> {
        const requestIdToCancel = ocrRunLifecycle.cancelActiveRun();

        const rejectPending = pendingOcrReject;
        pendingOcrReject = null;
        rejectPending?.(new OcrRunCanceledError());

        if (!requestIdToCancel) {
            cleanupRunState();
            return {
                canceled: false,
                reason: 'not-found',
            };
        }

        beginCancelingRequest(requestIdToCancel);
        return cancelBackendRequest(requestIdToCancel, 'manual');
    }

    onScopeDispose(() => {
        disposed = true;
        void cancelOcr();
    });

    function clearResults() {
        results.value = {
            pages: new Map(),
            languages: [],
            completedAt: null,
            searchablePdfResult: null,
        };
    }

    function clearRunSettingsHistory() {
        activeRunSettings.value = null;
        lastCompletedRunSettings.value = null;
    }

    function toggleLanguage(code: string, selected: boolean) {
        const selectedLanguages = selected
            ? Array.from(new Set([
                ...settings.value.selectedLanguages,
                code,
            ]))
            : settings.value.selectedLanguages.filter(languageCode => languageCode !== code);

        settings.value = {
            ...settings.value,
            selectedLanguages,
        };
    }

    const hasResults = computed(() => results.value.searchablePdfResult !== null);

    const progressPercent = computed(() => {
        if (progress.value.phase !== 'processing') {
            return progress.value.phaseProgress;
        }
        if (progress.value.totalPages === 0) {
            return 0;
        }
        return Math.round(
            (progress.value.processedCount / progress.value.totalPages) * 100,
        );
    });

    const latinCyrillicLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script === 'latin' || l.script === 'cyrillic'),
    );

    const greekLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script === 'greek'),
    );

    const rtlLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script === 'rtl'),
    );

    /**
     * @deprecated OCR popup exports are routed through the workspace-level DOCX export path.
     */
    async function exportDocx(
        workingCopyPath: TDocumentRef | null,
        pdfDocument: PDFDocumentProxy | null = null,
    ) {
        if (isExporting.value) {
            return false;
        }

        isExporting.value = true;
        error.value = null;

        try {
            const selectedLanguages = getDocxExportLanguages();
            const documentRevisionToken = workingCopyPath
                ? (await getDocumentFilesCapability().getDocumentRevision(workingCopyPath).catch(() => null))?.token ?? null
                : null;
            return await exportTextAsDocx({
                workingCopyPath,
                documentRevisionToken,
                pdfDocument,
                hasRtl: hasRtlOcrLanguage(selectedLanguages),
                buildDocx: createDocxFromText,
                t,
                toast,
                setError: message => {
                    if (!disposed) {
                        error.value = message;
                    }
                },
                localizeError: e => localizeOcrError(e, 'errors.ocr.exportDocx'),
            });
        } finally {
            if (!disposed) {
                isExporting.value = false;
            }
        }
    }

    return {
        availableLanguages,
        settings,
        activeRunSettings,
        lastCompletedRunSettings,
        progress,
        results,
        error,
        isExporting,
        hasResults,
        progressPercent,
        latinCyrillicLanguages,
        greekLanguages,
        rtlLanguages,
        loadLanguages,
        runOcr,
        cancelOcr,
        clearResults,
        clearRunSettingsHistory,
        toggleLanguage,
        exportDocx,
    };
};
