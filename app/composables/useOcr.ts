
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useTimeoutFn } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import type { IOcrLanguage } from '@contracts/shared';
import type {
    IDocumentsCapability,
    IOcrCapability,
    TDocumentRef,
} from '@contracts/platformApi';
import { createDocxFromText } from '@app/utils/docx';
import { OCR_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import {
    parsePageRange,
    type IOcrSettings,
    type IOcrProgress,
    type IOcrResults,
} from '@app/utils/ocr/languages';
import { hasRtlOcrLanguage } from '@app/utils/ocr/textDirection';
import { useOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { getOcrCapability } from '@app/utils/platformOcr';
import { isBrowserPlatformActive } from '@app/utils/platform';
import {
    getDefaultBrowserOcrSettings,
    readBrowserOcrPreferences,
    saveBrowserOcrPreferences,
} from '@app/platform/browser-api/browserOcrPreferences';
import { getErrorMessage } from '@app/utils/error';
import { exportTextAsDocx } from '@app/utils/docxExport';
import { configureBrowserOcrLanguageBaseUrl } from '@app/utils/browserOcrConfig';

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

function getConfiguredBrowserOcrLanguageBaseUrl(value: unknown) {
    return typeof value === 'string' ? value : undefined;
}

export const useOcr = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const runtimeConfig = useRuntimeConfig();
    const { localizeOcrError } = useOcrErrorLocalizer();

    configureBrowserOcrLanguageBaseUrl(
        getConfiguredBrowserOcrLanguageBaseUrl(runtimeConfig.public?.browserOcrLanguageBaseUrl),
    );

    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>(isBrowserPlatformActive()
        ? readBrowserOcrPreferences() ?? getDefaultBrowserOcrSettings()
        : {
            pageRange: 'current',
            customRange: '',
            selectedLanguages: ['eng'],
        });
    const progress = ref<IOcrProgress>({
        isRunning: false,
        phase: 'preparing',
        currentPage: 0,
        totalPages: 0,
        processedCount: 0,
    });
    const results = ref<IOcrResults>({
        pages: new Map(),
        languages: [],
        completedAt: null,
        searchablePdfData: null,
    });
    const error = ref<string | null>(null);
    const isExporting = ref(false);

    const activeRequestId = ref<string | null>(null);

    let progressCleanup: (() => void) | null = null;
    let completeCleanup: (() => void) | null = null;
    let timeoutRunToken: symbol | null = null;
    let pendingOcrReject: ((reason?: unknown) => void) | null = null;
    let cancelGeneration = 0;
    let activeRunToken: symbol | null = null;

    function cleanupRunState() {
        activeRequestId.value = null;
        progress.value.isRunning = false;
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

    function beginRunProgress(pages: number[]) {
        progress.value = {
            isRunning: true,
            phase: 'preparing',
            currentPage: pages[0] ?? 1,
            totalPages: pages.length,
            processedCount: 0,
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
                progress.value.phase = 'processing';
                progress.value.currentPage = p.currentPage;
                progress.value.processedCount = p.processedCount;
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

    function buildPageRequests(pages: number[]): TOcrPageRequest[] {
        const languages = [...settings.value.selectedLanguages];
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

    async function acknowledgeOrCleanupOcrResult(
        ocr: IOcrCapability,
        documents: IDocumentsCapability,
        requestId: string,
        response: TOcrCompleteResult,
    ) {
        if (!response.pdfPath) {
            return;
        }

        let didCleanupViaAck = false;
        if (response.requiresCleanupAck) {
            try {
                const ackResult = await ocr.acknowledgeResultFile(requestId, response.pdfPath);
                didCleanupViaAck = ackResult.cleaned;
                if (!ackResult.cleaned && ackResult.error) {
                    BrowserLogger.warn('ocr', 'OCR cleanup acknowledgement was rejected', {
                        requestId,
                        path: response.pdfPath,
                        error: ackResult.error,
                    });
                }
            } catch (ackErr) {
                BrowserLogger.warn('ocr', 'Failed to acknowledge OCR temp result file', {
                    requestId,
                    path: response.pdfPath,
                    error: ackErr,
                });
            }
        }

        if (didCleanupViaAck) {
            return;
        }

        try {
            await documents.cleanupOcrTemp(response.pdfPath);
        } catch (cleanupErr) {
            BrowserLogger.warn('ocr', 'Failed to cleanup temp file', {
                requestId,
                path: response.pdfPath,
                error: cleanupErr,
            });
        }
    }

    async function readOcrPdfResult(
        ocr: IOcrCapability,
        documents: IDocumentsCapability,
        requestId: string,
        response: TOcrCompleteResult,
        ensureRunActive: TRunGuard,
    ) {
        if (!response.pdfPath) {
            throw new Error(t('errors.ocr.noPdfData'));
        }

        BrowserLogger.debug('ocr', 'Reading OCR PDF from temp path', {
            requestId,
            path: response.pdfPath,
        });

        try {
            const fileData = await documents.readFile(response.pdfPath);
            const pdfBytes = new Uint8Array(fileData);
            BrowserLogger.debug('ocr', 'Loaded OCR PDF', {
                requestId,
                bytes: pdfBytes.length,
            });
            ensureRunActive();
            return pdfBytes;
        } finally {
            await acknowledgeOrCleanupOcrResult(ocr, documents, requestId, response);
        }
    }

    function storeOcrPdfResult(pdfBytes: Uint8Array) {
        results.value = {
            pages: new Map(),
            languages: [...settings.value.selectedLanguages],
            completedAt: Date.now(),
            searchablePdfData: pdfBytes,
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
    ): workingCopyPath is TDocumentRef {
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

    function getSelectedOcrPages(currentPage: number, totalPages: number) {
        const pages = parsePageRange(
            settings.value.pageRange,
            settings.value.customRange,
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

    async function handleOcrResponse(
        ocr: IOcrCapability,
        documents: IDocumentsCapability,
        requestId: string,
        response: TOcrCompleteResult,
        ensureRunActive: TRunGuard,
    ) {
        applyOcrResponseErrors(response, requestId);

        if (response.success && response.pdfPath) {
            const pdfBytes = await readOcrPdfResult(
                ocr,
                documents,
                requestId,
                response,
                ensureRunActive,
            );
            storeOcrPdfResult(pdfBytes);
        } else if (response.success) {
            throw new Error(t('errors.ocr.noPdfData'));
        } else if (!response.success) {
            error.value = error.value || t('errors.ocr.createSearchablePdf');
        }
    }

    async function executeOcrRun(
        requestId: string,
        pages: number[],
        workingCopyPath: TDocumentRef,
        runToken: symbol,
        ensureRunActive: TRunGuard,
    ) {
        const ocr = getOcrCapability();
        const documents = getDocumentsCapability();
        registerProgressListener(ocr, requestId, runToken);
        const pageRequests = buildPageRequests(pages);

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

        await handleOcrResponse(ocr, documents, requestId, response, ensureRunActive);
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
        const pages = getSelectedOcrPages(currentPage, totalPages);

        if (!validateOcrRunRequest(pages, workingCopyPath)) {
            return;
        }

        clearResults();

        const {
            runToken,
            runGeneration,
            ensureRunActive,
        } = createOcrRunContext();

        beginRunProgress(pages);
        if (!await waitForRunUiReady(runToken, runGeneration)) {
            return;
        }

        const requestId = createOcrRequestId(pages);

        try {
            await executeOcrRun(
                requestId,
                pages,
                workingCopyPath,
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

        const requestIdToCancel = activeRequestId.value;
        if (requestIdToCancel) {
            BrowserLogger.info('ocr', 'Cancelling OCR', { requestId: requestIdToCancel });
            void getOcrCapability().cancel(requestIdToCancel).catch((cancelError) => {
                const normalizedCancelError: unknown = cancelError;
                BrowserLogger.debug('ocr', 'OCR cancel request failed', {
                    requestId: requestIdToCancel,
                    error: normalizedCancelError,
                });
            });
        }
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
            searchablePdfData: null,
        };
    }

    function toggleLanguage(code: string, selected: boolean) {
        if (selected) {
            if (!settings.value.selectedLanguages.includes(code)) {
                settings.value.selectedLanguages.push(code);
            }
        } else {
            const index = settings.value.selectedLanguages.indexOf(code);
            if (index !== -1) {
                settings.value.selectedLanguages.splice(index, 1);
            }
        }
    }

    if (isBrowserPlatformActive()) {
        watch(settings, value => saveBrowserOcrPreferences(value), { deep: true });
    }

    const hasResults = computed(() => results.value.searchablePdfData !== null);

    const progressPercent = computed(() => {
        if (progress.value.phase === 'preparing') {
            return null;
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
    ): Promise<boolean> {
        if (isExporting.value) {
            return false;
        }

        isExporting.value = true;
        error.value = null;

        try {
            const selectedLanguages = settings.value.selectedLanguages;
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
        toggleLanguage,
        exportDocx,
    };
};
