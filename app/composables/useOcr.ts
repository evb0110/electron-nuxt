import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useTimeoutFn } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import type { IOcrLanguage } from '@contracts/shared';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IOcrCapability } from '@contracts/electronApiOcr';
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
import { useOcrErrorLocalizer } from '@app/composables/useOcrErrorLocalizer';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { getErrorMessage } from '@app/utils/error';
import { exportTextAsDocx } from '@app/utils/exportTextAsDocx';

class OcrCanceledError extends Error {
    constructor() {
        super('OCR canceled');
        this.name = 'OcrCanceledError';
    }
}

type TOcrCompleteResult = Parameters<IOcrCapability['onComplete']>[0] extends (
    result: infer TResult,
) => void ? TResult : never;
type TOcrPageRequest = Parameters<IOcrCapability['createSearchablePdf']>[1][number];
type TRunGuard = () => void;

interface IOcrRunContext {
    runToken: symbol;
    runGeneration: number;
    ensureRunActive: TRunGuard;
}

export const useOcr = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { localizeOcrError } = useOcrErrorLocalizer();

    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>({
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
    });
    const progress = ref<IOcrUiProgress>({
        isRunning: false,
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

    const activeRequestId = ref<string | null>(null);
    const activeRunSettings = ref<IOcrSettings | null>(null);
    const lastCompletedRunSettings = ref<IOcrSettings | null>(null);

    let progressCleanup: (() => void) | null = null;
    let completeCleanup: (() => void) | null = null;
    let timeoutRunToken: symbol | null = null;
    let pendingOcrReject: ((reason?: unknown) => void) | null = null;
    let cancelGeneration = 0;
    let activeRunToken: symbol | null = null;

    function cleanupRunState() {
        activeRequestId.value = null;
        progress.value.isRunning = false;
        activeRunSettings.value = null;
        progressCleanup?.();
        progressCleanup = null;
        completeCleanup?.();
        completeCleanup = null;
        clearOcrTimeout();
        pendingOcrReject = null;
    }

    function clearOcrTimeout() {
        stopOcrTimeout();
        timeoutRunToken = null;
    }

    function cancelActiveBackendRequest(reason: 'manual' | 'timeout') {
        const requestIdToCancel = activeRequestId.value;
        if (!requestIdToCancel) {
            return;
        }

        BrowserLogger.info('ocr', reason === 'timeout' ? 'Cancelling timed-out OCR' : 'Cancelling OCR', { requestId: requestIdToCancel });
        void getOcrCapability().cancel(requestIdToCancel).catch((cancelError) => {
            const normalizedCancelError: unknown = cancelError;
            BrowserLogger.debug('ocr', 'OCR cancel request failed', {
                requestId: requestIdToCancel,
                error: normalizedCancelError,
            });
        });
    }

    const {
        start: startOcrTimeout,
        stop: stopOcrTimeout,
    } = useTimeoutFn(() => {
        const runToken = timeoutRunToken;
        if (activeRunToken !== runToken) {
            return;
        }
        const rejectPending = pendingOcrReject;
        pendingOcrReject = null;
        timeoutRunToken = null;
        cancelActiveBackendRequest('timeout');
        rejectPending?.(new Error(t('errors.ocr.timeout')));
    }, OCR_TIMEOUT_MS, { immediate: false });

    async function loadLanguages() {
        try {
            availableLanguages.value = await getOcrCapability().getLanguages();
        } catch (e) {
            error.value = localizeOcrError(e, 'errors.ocr.loadLanguages');
        }
    }

    function isRunActive(runToken: symbol, runGeneration: number) {
        return activeRunToken === runToken && runGeneration === cancelGeneration;
    }

    function createRunGuard(runToken: symbol, runGeneration: number): TRunGuard {
        return () => {
            if (!isRunActive(runToken, runGeneration)) {
                throw new OcrCanceledError();
            }
        };
    }

    function createOcrRunContext(): IOcrRunContext {
        const runToken = Symbol('ocr-run');
        activeRunToken = runToken;
        const runGeneration = cancelGeneration;
        return {
            runToken,
            runGeneration,
            ensureRunActive: createRunGuard(runToken, runGeneration),
        };
    }

    function cloneOcrSettings(source: IOcrSettings): IOcrSettings {
        return {
            pageRange: source.pageRange,
            customRange: source.customRange,
            selectedLanguages: [...source.selectedLanguages],
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
        };
    }

    function getDocxExportLanguages() {
        const sourceSettings = activeRunSettings.value
            ?? lastCompletedRunSettings.value
            ?? settings.value;
        return [...sourceSettings.selectedLanguages];
    }

    function beginRunProgress(pages: number[], runSettings: IOcrSettings) {
        activeRunSettings.value = cloneOcrSettings(runSettings);
        progress.value = {
            isRunning: true,
            phase: 'preparing',
            currentPage: pages[0] ?? 1,
            totalPages: pages.length,
            processedCount: 0,
            phaseProgress: null,
        };
    }

    async function waitForRunUiReady(runToken: symbol, runGeneration: number) {
        await nextTick();
        if (!isRunActive(runToken, runGeneration)) {
            return false;
        }

        await waitForVisualFrames({ frames: 2 });
        return isRunActive(runToken, runGeneration);
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
            if (activeRunToken !== runToken) {
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
                if (result.requestId === requestId && activeRunToken === runToken) {
                    if (didResolve) {
                        BrowserLogger.debug('ocr', 'Ignoring duplicate completion', { requestId });
                        return;
                    }
                    didResolve = true;
                    pendingOcrReject = null;
                    clearOcrTimeout();
                    resolve(result);
                }
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

    function applyOcrResponseErrors(response: TOcrCompleteResult, requestId: string) {
        if (response.errors.length === 0) {
            return;
        }

        BrowserLogger.error('ocr', 'OCR backend reported page failures', {
            requestId,
            success: response.success,
            errors: response.errors,
        });
        const localizedErrors = response.errors.map(err =>
            localizeOcrError(err, 'errors.ocr.createSearchablePdf'),
        );
        error.value = uniq(localizedErrors).join('; ');
    }

    function storeOcrPdfResult(
        requestId: string,
        response: TOcrCompleteResult,
        runSettings: IOcrSettings,
    ) {
        if (!response.pdfPath) {
            throw new Error(t('errors.ocr.noPdfData'));
        }

        BrowserLogger.debug('ocr', 'Storing OCR PDF result path', {
            requestId,
            path: response.pdfPath,
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
        activeRequestId.value = requestId;
        BrowserLogger.info('ocr', 'Request created', {
            requestId,
            pages: pages.length,
        });
        return requestId;
    }

    function handleOcrResponse(
        requestId: string,
        response: TOcrCompleteResult,
        ensureRunActive: TRunGuard,
        runSettings: IOcrSettings,
    ) {
        applyOcrResponseErrors(response, requestId);

        if (response.success && response.pdfPath) {
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
        ensureRunActive: TRunGuard,
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
            undefined,
        );
        ensureRunActive();

        BrowserLogger.debug('ocr', 'Job started', {
            requestId,
            ...startResult,
        });

        if (!startResult.started) {
            throw new Error(localizeOcrError(startResult.error, 'errors.ocr.start'));
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

        if (progress.value.isRunning) {
            BrowserLogger.debug('ocr', 'runOcr ignored; already running');
            return;
        }

        error.value = null;
        const runSettings = createRunSettingsSnapshot(settings.value);
        const pages = getSelectedOcrPages(currentPage, totalPages, runSettings);

        if (!validateOcrRunRequest(pages, workingCopyPath, runSettings)) {
            return;
        }

        clearResults();

        const {
            runToken,
            runGeneration,
            ensureRunActive,
        } = createOcrRunContext();

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
            if (e instanceof OcrCanceledError) {
                return;
            }
            logOcrRunFailure(requestId, e);
            error.value = localizeOcrError(e, 'errors.ocr.createSearchablePdf');
        } finally {
            if (activeRunToken === runToken) {
                activeRunToken = null;
                cleanupRunState();
            }
        }
    }

    function cancelOcr() {
        cancelGeneration += 1;
        activeRunToken = null;

        const rejectPending = pendingOcrReject;
        pendingOcrReject = null;
        rejectPending?.(new OcrCanceledError());

        cancelActiveBackendRequest('manual');
        cleanupRunState();
    }

    onScopeDispose(() => {
        cancelOcr();
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
            return await exportTextAsDocx({
                workingCopyPath,
                pdfDocument,
                hasRtl: hasRtlOcrLanguage(selectedLanguages),
                buildDocx: createDocxFromText,
                t,
                toast,
                setError: message => {
                    error.value = message;
                },
                localizeError: e => localizeOcrError(e, 'errors.ocr.exportDocx'),
            });
        } finally {
            isExporting.value = false;
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
