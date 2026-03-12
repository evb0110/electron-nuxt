
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { uniq } from 'es-toolkit/array';
import type { IOcrLanguage } from '@contracts/shared';
import { getElectronAPI } from '@app/utils/electron';
import { createDocxFromText } from '@app/utils/docx';
import { OCR_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browser-logger';
import { waitForVisualFrames } from '@app/utils/async-helpers';
import {
    parsePageRange,
    type IOcrSettings,
    type IOcrProgress,
    type IOcrResults,
} from '@app/composables/ocrLanguages';
import {
    loadOcrText,
    extractPdfText,
} from '@app/composables/ocrProcessing';
import { createOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';

const RTL_OCR_LANGUAGES = new Set([
    'heb',
    'syr',
]);

class OcrCanceledError extends Error {
    constructor() {
        super('OCR canceled');
        this.name = 'OcrCanceledError';
    }
}

export const useOcr = () => {
    const { t } = useTypedI18n();
    const { localizeOcrError } = createOcrErrorLocalizer(t);

    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>({
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
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
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
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        pendingOcrReject = null;
    }

    async function loadLanguages() {
        try {
            const api = getElectronAPI();
            availableLanguages.value = await api.ocr.getLanguages();
        } catch (e) {
            error.value = localizeOcrError(e, 'errors.ocr.loadLanguages');
        }
    }

    async function runOcr(
        currentPage: number,
        totalPages: number,
        workingCopyPath: string | null = null,
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
        const pages = parsePageRange(
            settings.value.pageRange,
            settings.value.customRange,
            currentPage,
            totalPages,
        );

        BrowserLogger.debug('ocr', 'Pages selected', pages);

        if (pages.length === 0) {
            error.value = t('errors.ocr.noValidPages');
            return;
        }
        if (!workingCopyPath) {
            error.value = t('errors.file.invalid');
            return;
        }

        const runToken = Symbol('ocr-run');
        activeRunToken = runToken;
        const runGeneration = cancelGeneration;
        const ensureRunActive = () => {
            if (
                activeRunToken !== runToken
                || runGeneration !== cancelGeneration
            ) {
                throw new OcrCanceledError();
            }
        };

        progress.value = {
            isRunning: true,
            phase: 'preparing',
            currentPage: pages[0] ?? 1,
            totalPages: pages.length,
            processedCount: 0,
        };

        await nextTick();
        if (
            activeRunToken !== runToken
            || runGeneration !== cancelGeneration
        ) {
            return;
        }

        await waitForVisualFrames({ frames: 2 });
        if (
            activeRunToken !== runToken
            || runGeneration !== cancelGeneration
        ) {
            return;
        }

        const requestId = `ocr-${crypto.randomUUID()}`;
        activeRequestId.value = requestId;
        BrowserLogger.info('ocr', 'Request created', {
            requestId,
            pages: pages.length, 
        });

        try {
            const api = getElectronAPI();

            progressCleanup = api.ocr.onProgress((p) => {
                if (activeRunToken !== runToken) {
                    return;
                }
                BrowserLogger.debug('ocr', 'Progress update', {
                    ...p,
                    requestId,
                });
                if (p.requestId === requestId) {
                    progress.value.phase = 'processing';
                    progress.value.currentPage = p.currentPage;
                    progress.value.processedCount = p.processedCount;
                }
            });

            const languages = [...settings.value.selectedLanguages];
            const pageRequests = pages.map(pageNum => ({
                pageNumber: pageNum,
                languages,
            }));

            BrowserLogger.debug('ocr', 'Starting backend job', {
                requestId,
                pages,
                workingCopyPath,
            });

            ensureRunActive();
            const ocrPromise = new Promise<{
                success: boolean;
                pdfPath?: string;
                requiresCleanupAck?: boolean;
                errors: string[];
            }>((resolve, reject) => {
                let didResolve = false;
                pendingOcrReject = reject;

                completeCleanup = api.ocr.onComplete((result) => {
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
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        resolve(result);
                    }
                });

                timeoutId = setTimeout(() => {
                    if (!didResolve && activeRunToken === runToken) {
                        pendingOcrReject = null;
                        timeoutId = null;
                        reject(new Error(t('errors.ocr.timeout')));
                    }
                }, OCR_TIMEOUT_MS);
            });

            ensureRunActive();
            const startResult = await api.ocr.createSearchablePdf(
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

            if (response.errors.length > 0) {
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

            if (response.success && response.pdfPath) {
                let pdfBytes: Uint8Array;

                BrowserLogger.debug('ocr', 'Reading OCR PDF from temp path', {
                    requestId,
                    path: response.pdfPath, 
                });
                let didCleanupViaAck = false;

                try {
                    const fileData = await api.documents.readFile(response.pdfPath);
                    pdfBytes = new Uint8Array(fileData);
                    BrowserLogger.debug('ocr', 'Loaded OCR PDF', {
                        requestId,
                        bytes: pdfBytes.length, 
                    });
                    ensureRunActive();
                } finally {
                    if (response.requiresCleanupAck) {
                        try {
                            const ackResult = await api.ocr.acknowledgeResultFile(requestId, response.pdfPath);
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

                    if (!didCleanupViaAck) {
                        try {
                            await api.documents.cleanupOcrTemp(response.pdfPath);
                        } catch (cleanupErr) {
                            BrowserLogger.warn('ocr', 'Failed to cleanup temp file', {
                                requestId,
                                path: response.pdfPath,
                                error: cleanupErr, 
                            });
                        }
                    }
                }

                results.value = {
                    pages: new Map(),
                    languages: [...settings.value.selectedLanguages],
                    completedAt: Date.now(),
                    searchablePdfData: pdfBytes,
                };
            } else if (response.success) {
                throw new Error(t('errors.ocr.noPdfData'));
            } else if (!response.success) {
                error.value = error.value || t('errors.ocr.createSearchablePdf');
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const errStack = e instanceof Error ? e.stack : undefined;
            if (e instanceof OcrCanceledError) {
                return;
            }
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
            const api = getElectronAPI();
            void api.ocr.cancel(requestIdToCancel).catch((cancelError) => {
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
        workingCopyPath: string | null,
        pdfDocument: PDFDocumentProxy | null = null,
    ): Promise<boolean> {
        const workingPath = workingCopyPath ?? '';

        if (isExporting.value) {
            return false;
        }

        isExporting.value = true;
        error.value = null;

        try {
            let text = workingCopyPath ? await loadOcrText(workingCopyPath) : null;
            if (!text && pdfDocument) {
                text = await extractPdfText(pdfDocument);
            }
            if (!text) {
                error.value = t('errors.ocr.noText');
                return false;
            }

            const api = getElectronAPI();
            const outPath = await api.documents.saveDocxAs(workingPath);
            if (!outPath) {
                return false;
            }

            const hasRtl = settings.value.selectedLanguages.some(lang => RTL_OCR_LANGUAGES.has(lang));
            const docxBytes = createDocxFromText(text, hasRtl);
            await api.documents.writeDocxFile(outPath, docxBytes);
            return true;
        } catch (e) {
            error.value = localizeOcrError(e, 'errors.ocr.exportDocx');
            return false;
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
