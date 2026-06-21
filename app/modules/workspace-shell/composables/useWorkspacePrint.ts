import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdf';
import {
    buildBrowserPrintFrameMarkup,
    normalizePrintPageNumbers,
    type IBrowserPrintDocument,
    type TPrintOrientation,
} from '@app/utils/pdfPrintShared';

const BROWSER_PRINT_CLEANUP_TIMEOUT_MS = 60000;
const BROWSER_PRINT_LOAD_TIMEOUT_MS = 30000;
const BROWSER_PRINT_LOAD_SETTLE_DELAY_MS = 300;
const BROWSER_PRINT_FRAME_MIN_WIDTH_PX = 1280;
const BROWSER_PRINT_FRAME_MIN_HEIGHT_PX = 1600;
const PDF_MIME_TYPE = 'application/pdf';

function isCrossOriginFrameAccessError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.name === 'SecurityError'
        || error.message.includes('cross-origin frame')
        || error.message.includes('Blocked a frame with origin');
}

function createPrintAbortError() {
    const error = new Error('Print preparation was canceled');
    error.name = 'AbortError';
    return error;
}

function isPrintAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function throwIfPrintAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw createPrintAbortError();
    }
}

function createPrintSignalOptions(signal: AbortSignal | undefined) {
    return signal ? { signal } : {};
}

interface IWorkspacePrintDeps {
    totalPages: Readonly<Ref<number>>;
    currentPage: Readonly<Ref<number>>;
    selectedPages: Readonly<Ref<number[]>>;
    sourcePdf: Readonly<Ref<TPdfSource | null>>;
    workingCopyPath: Readonly<Ref<string | null>>;
    fileName: Readonly<Ref<string | null>>;
    hasPendingUnsavedChanges: Readonly<Ref<boolean>>;
    hasPendingPrintSerializationChanges?: Readonly<Ref<boolean>>;
    getQuickPrintPageMetrics: () => Promise<IPdfPageMetric[] | null>;
    getPrintableSourceData: () => Promise<Uint8Array | null>;
    renderLoadedPdfPagesForBrowserPrint?: (
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) => Promise<void>;
}

interface IPrintDialogSubmitPayload {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export const useWorkspacePrint = (deps: IWorkspacePrintDeps) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const printDialogOpen = ref(false);
    const printDialogSelectedPages = ref<number[]>([]);
    const isPreparingPrint = ref(false);
    const activePrintAction = ref<'default' | 'current-page' | null>(null);
    const printError = ref<string | null>(null);
    const activePrintFrame = ref<HTMLIFrameElement | null>(null);
    const printStatus = computed(() => isPreparingPrint.value ? t('print.preparing') : null);
    const isPreparingCurrentPagePrint = computed(() => (
        isPreparingPrint.value && activePrintAction.value === 'current-page'
    ));
    let removeAfterPrintListener: (() => void) | null = null;
    let browserPrintCleanupTimer: number | null = null;
    let activeBrowserPrintUrl: string | null = null;
    let activePrintAbortController: AbortController | null = null;
    let closeDialogForSystemPrint = false;

    function resetPrintError() {
        printError.value = null;
    }

    function clearBrowserPrintCleanupTimer() {
        if (browserPrintCleanupTimer === null || typeof window === 'undefined') {
            return;
        }

        window.clearTimeout(browserPrintCleanupTimer);
        browserPrintCleanupTimer = null;
    }

    function clearActiveBrowserPrintUrl() {
        if (!activeBrowserPrintUrl) {
            return;
        }

        revokeBrowserPrintUrl(activeBrowserPrintUrl);
        activeBrowserPrintUrl = null;
    }

    function cleanupPrintFrame() {
        if (typeof window !== 'undefined' && removeAfterPrintListener) {
            removeAfterPrintListener();
            removeAfterPrintListener = null;
        }

        if (typeof window !== 'undefined') {
            clearBrowserPrintCleanupTimer();
        }

        clearActiveBrowserPrintUrl();

        if (activePrintFrame.value) {
            activePrintFrame.value.remove();
            activePrintFrame.value = null;
        }
    }

    function cancelActivePrintPreparation() {
        activePrintAbortController?.abort();
        cleanupPrintFrame();
        isPreparingPrint.value = false;
        activePrintAction.value = null;
    }

    function closePrintDialogForSystemDialog() {
        closeDialogForSystemPrint = true;
        printDialogOpen.value = false;
    }

    function normalizeSelectedPages() {
        return uniq(deps.selectedPages.value)
            .filter(page => Number.isInteger(page) && page >= 1 && page <= deps.totalPages.value)
            .sort((left, right) => left - right);
    }

    function normalizeCurrentPage() {
        const page = deps.currentPage.value;
        if (!Number.isInteger(page) || page < 1 || page > deps.totalPages.value) {
            return null;
        }

        return page;
    }

    function handlePrint() {
        closeDialogForSystemPrint = false;
        printDialogSelectedPages.value = normalizeSelectedPages();
        resetPrintError();
        printDialogOpen.value = true;
    }

    async function handleQuickPrint() {
        printDialogSelectedPages.value = normalizeSelectedPages();
        resetPrintError();
        const defaultPayload = {
            viewMode: 'single',
            orientation: 'auto',
        } satisfies IPrintDialogSubmitPayload;

        const { shouldPrintPageMetricsDirectly } = await import('@app/utils/pdfPrint');
        const printSourceDirectly = shouldPrintPageMetricsDirectly(
            await deps.getQuickPrintPageMetrics() ?? [],
            defaultPayload,
        ) === true;

        await handlePrintDialogSubmit(defaultPayload, {
            action: 'default',
            printSourceDirectly,
            reopenDialogOnError: false,
        });
    }

    async function handlePrintCurrentPage() {
        const currentPrintPage = normalizeCurrentPage();
        if (currentPrintPage === null) {
            return;
        }

        resetPrintError();
        await handlePrintDialogSubmit({
            pageNumbers: [currentPrintPage],
            viewMode: 'single',
            orientation: 'auto',
        }, {
            action: 'current-page',
            reopenDialogOnError: false,
        });
    }

    function handlePrintDialogOpenChange(isOpen: boolean) {
        printDialogOpen.value = isOpen;
        if (!isOpen) {
            if (closeDialogForSystemPrint) {
                closeDialogForSystemPrint = false;
                resetPrintError();
                return;
            }

            if (isPreparingPrint.value) {
                cancelActivePrintPreparation();
            }
            resetPrintError();
        } else {
            closeDialogForSystemPrint = false;
        }
    }

    function createHiddenPrintFrame() {
        if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.print !== 'function') {
            throw new Error('Window printing is unavailable');
        }

        cleanupPrintFrame();

        const frame = document.createElement('iframe');
        const frameWidth = Math.max(window.innerWidth || 0, BROWSER_PRINT_FRAME_MIN_WIDTH_PX);
        const frameHeight = Math.max(window.innerHeight || 0, BROWSER_PRINT_FRAME_MIN_HEIGHT_PX);
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.position = 'fixed';
        frame.style.left = `-${frameWidth + 200}px`;
        frame.style.top = '0';
        frame.style.width = `${frameWidth}px`;
        frame.style.height = `${frameHeight}px`;
        frame.style.opacity = '0.001';
        frame.style.pointerEvents = 'none';
        frame.style.border = '0';
        document.body.append(frame);
        activePrintFrame.value = frame;

        return frame;
    }

    function createBrowserPrintUrl(printablePdf: Blob | Uint8Array) {
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            throw new Error('Browser PDF printing is unavailable');
        }

        if (printablePdf instanceof Blob) {
            return URL.createObjectURL(printablePdf);
        }

        const pdfBytes = new Uint8Array(printablePdf);
        return URL.createObjectURL(new Blob([pdfBytes.buffer], { type: PDF_MIME_TYPE }));
    }

    function revokeBrowserPrintUrl(printUrl: string) {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(printUrl);
        }
    }

    function waitForPrintFrameLoad(frame: HTMLIFrameElement, signal?: AbortSignal) {
        if (typeof window === 'undefined') {
            return Promise.reject(new Error('Window printing is unavailable'));
        }

        return new Promise<void>((resolve, reject) => {
            const onLoad = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('Failed to load the printable PDF'));
            };
            const onAbort = () => {
                cleanup();
                reject(createPrintAbortError());
            };
            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(new Error('Timed out while preparing the printable PDF'));
            }, BROWSER_PRINT_LOAD_TIMEOUT_MS);
            const cleanup = () => {
                frame.removeEventListener('load', onLoad);
                frame.removeEventListener('error', onError);
                signal?.removeEventListener('abort', onAbort);
                window.clearTimeout(timeoutId);
            };

            if (signal?.aborted) {
                cleanup();
                reject(createPrintAbortError());
                return;
            }

            frame.addEventListener('load', onLoad, { once: true });
            frame.addEventListener('error', onError, { once: true });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async function waitForPrintFrameReady(targetWindow: Window, signal?: AbortSignal) {
        throwIfPrintAborted(signal);
        try {
            const { waitForPrintPaint } = await import('@app/utils/pdfPrint');
            await waitForPrintPaint(targetWindow);
        } catch (error) {
            if (!isCrossOriginFrameAccessError(error)) {
                throw error;
            }
        }
        throwIfPrintAborted(signal);

        if (typeof window === 'undefined') {
            return;
        }

        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, BROWSER_PRINT_LOAD_SETTLE_DELAY_MS);
        });
        throwIfPrintAborted(signal);
    }

    async function printRenderedContentInHiddenFrame(
        renderContent: (
            targetDocument: IBrowserPrintDocument,
            signal: AbortSignal | undefined,
        ) => Promise<void>,
        signal?: AbortSignal,
    ) {
        const frame = createHiddenPrintFrame();
        const frameLoad = waitForPrintFrameLoad(frame, signal);

        frame.srcdoc = buildBrowserPrintFrameMarkup();
        await frameLoad;
        throwIfPrintAborted(signal);

        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
            cleanupPrintFrame();
            throw new Error('Missing print frame window');
        }

        await renderContent(frameWindow.document, signal);
        throwIfPrintAborted(signal);

        const afterPrint = () => {
            cleanupPrintFrame();
        };
        window.addEventListener('afterprint', afterPrint, { once: true });
        removeAfterPrintListener = () => {
            window.removeEventListener('afterprint', afterPrint);
        };
        try {
            frameWindow.addEventListener('afterprint', afterPrint, { once: true });
            removeAfterPrintListener = () => {
                window.removeEventListener('afterprint', afterPrint);
                frameWindow.removeEventListener('afterprint', afterPrint);
            };
        } catch (error) {
            if (!isCrossOriginFrameAccessError(error)) {
                cleanupPrintFrame();
                throw error;
            }
        }
        browserPrintCleanupTimer = window.setTimeout(afterPrint, BROWSER_PRINT_CLEANUP_TIMEOUT_MS);

        try {
            await waitForPrintFrameReady(frameWindow, signal);
            closePrintDialogForSystemDialog();
            frameWindow.focus();
            throwIfPrintAborted(signal);
            frameWindow.print();
            toast.add({
                color: 'success',
                title: t('print.requestSent'),
            });
        } catch (error) {
            cleanupPrintFrame();
            throw error;
        }
    }

    async function printPdfInHiddenFrame(printablePdf: Blob | Uint8Array, signal?: AbortSignal) {
        await printRenderedContentInHiddenFrame(
            async (targetDocument, renderSignal) => {
                const { renderPdfPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
                await renderPdfPagesForBrowserPrint(
                    targetDocument,
                    printablePdf,
                    createPrintSignalOptions(renderSignal),
                );
            },
            signal,
        );
    }

    async function printLoadedPdfPagesInHiddenFrame(pageNumbers: number[], signal?: AbortSignal) {
        if (!deps.renderLoadedPdfPagesForBrowserPrint) {
            throw new Error('Loaded PDF printing is unavailable');
        }

        await printRenderedContentInHiddenFrame(
            (targetDocument, renderSignal) => deps.renderLoadedPdfPagesForBrowserPrint!(
                targetDocument,
                pageNumbers,
                createPrintSignalOptions(renderSignal),
            ),
            signal,
        );
    }

    async function printPdfWithBrowserPdfViewer(printablePdf: Blob | Uint8Array, signal?: AbortSignal) {
        const frame = createHiddenPrintFrame();
        const printUrl = createBrowserPrintUrl(printablePdf);
        activeBrowserPrintUrl = printUrl;
        const frameLoad = waitForPrintFrameLoad(frame, signal);

        frame.src = printUrl;

        try {
            await frameLoad;
            throwIfPrintAborted(signal);

            const frameWindow = frame.contentWindow;
            if (!frameWindow) {
                throw new Error('Missing print frame window');
            }

            const afterPrint = () => {
                cleanupPrintFrame();
            };
            window.addEventListener('afterprint', afterPrint, { once: true });
            removeAfterPrintListener = () => {
                window.removeEventListener('afterprint', afterPrint);
            };
            try {
                frameWindow.addEventListener('afterprint', afterPrint, { once: true });
                removeAfterPrintListener = () => {
                    window.removeEventListener('afterprint', afterPrint);
                    frameWindow.removeEventListener('afterprint', afterPrint);
                };
            } catch (error) {
                if (!isCrossOriginFrameAccessError(error)) {
                    throw error;
                }
            }
            browserPrintCleanupTimer = window.setTimeout(afterPrint, BROWSER_PRINT_CLEANUP_TIMEOUT_MS);

            await waitForPrintFrameReady(frameWindow, signal);
            closePrintDialogForSystemDialog();
            frameWindow.focus();
            throwIfPrintAborted(signal);
            frameWindow.print();
            toast.add({
                color: 'success',
                title: t('print.requestSent'),
            });
        } catch (error) {
            cleanupPrintFrame();
            throw error;
        }
    }

    async function tryPrintInBrowserWithNativeFallback(
        printablePdf: Blob | Uint8Array,
        signal?: AbortSignal,
    ) {
        try {
            await printPdfInHiddenFrame(printablePdf, signal);
            return true;
        } catch (renderedPrintError) {
            throwIfPrintAborted(signal);
            try {
                await printPdfWithBrowserPdfViewer(printablePdf, signal);
                return true;
            } catch (pdfViewerPrintError) {
                throw pdfViewerPrintError instanceof Error
                    ? pdfViewerPrintError
                    : renderedPrintError;
            }
        }
    }

    function hasPendingPrintSerializationChanges() {
        return deps.hasPendingPrintSerializationChanges?.value
            ?? deps.hasPendingUnsavedChanges.value;
    }

    function resolveLoadedPdfSinglePagePrint(payload: IPrintDialogSubmitPayload) {
        if (
            !deps.renderLoadedPdfPagesForBrowserPrint
            || hasPendingPrintSerializationChanges()
            || payload.viewMode !== 'single'
            || payload.orientation !== 'auto'
            || !payload.pageNumbers?.length
        ) {
            return null;
        }

        const pageNumbers = normalizePrintPageNumbers(payload.pageNumbers, deps.totalPages.value);
        return pageNumbers.length === 1 ? pageNumbers : null;
    }

    async function handlePrintDialogSubmit(
        payload: IPrintDialogSubmitPayload,
        options: {
            action?: 'default' | 'current-page';
            printSourceDirectly?: boolean;
            reopenDialogOnError?: boolean;
        } = {},
    ) {
        activePrintAbortController?.abort();
        const abortController = new AbortController();
        activePrintAbortController = abortController;
        const { signal } = abortController;
        closeDialogForSystemPrint = false;
        isPreparingPrint.value = true;
        activePrintAction.value = options.action ?? 'default';
        resetPrintError();

        try {
            const loadedPageNumbers = resolveLoadedPdfSinglePagePrint(payload);
            if (loadedPageNumbers) {
                await printLoadedPdfPagesInHiddenFrame(loadedPageNumbers, signal);
                return;
            }

            throwIfPrintAborted(signal);
            const sourceData = await deps.getPrintableSourceData();
            throwIfPrintAborted(signal);
            if (!sourceData) {
                throw new Error('Missing printable PDF source data');
            }

            if (options.printSourceDirectly === true) {
                await tryPrintInBrowserWithNativeFallback(sourceData, signal);
                return;
            }

            const { buildPrintablePdfData } = await import('@app/utils/pdfPrint');
            const printablePdfData = await buildPrintablePdfData(sourceData, payload);
            throwIfPrintAborted(signal);
            if (!printablePdfData) {
                throw new Error('Failed to prepare printable PDF data');
            }

            await tryPrintInBrowserWithNativeFallback(printablePdfData, signal);
        } catch (error) {
            if (isPrintAbortError(error)) {
                return;
            }

            const localizedError = error instanceof Error && error.message
                ? t('print.failedWithReason', { reason: error.message })
                : t('print.failed');
            if (options.reopenDialogOnError === false) {
                toast.add({
                    color: 'error',
                    title: t('print.failed'),
                    description: localizedError,
                });
            } else {
                printDialogOpen.value = true;
                printError.value = localizedError;
            }
        } finally {
            if (activePrintAbortController === abortController) {
                activePrintAbortController = null;
                isPreparingPrint.value = false;
                activePrintAction.value = null;
                closeDialogForSystemPrint = false;
            }
        }
    }

    onScopeDispose(() => {
        activePrintAbortController?.abort();
        activePrintAbortController = null;
        cleanupPrintFrame();
        printDialogOpen.value = false;
        printDialogSelectedPages.value = [];
        isPreparingPrint.value = false;
        activePrintAction.value = null;
        printError.value = null;
        closeDialogForSystemPrint = false;
    });

    return {
        printDialogOpen,
        printDialogSelectedPages,
        isPreparingPrint,
        isPreparingCurrentPagePrint,
        printError,
        printStatus,
        handlePrint,
        handleQuickPrint,
        handlePrintCurrentPage,
        handlePrintDialogOpenChange,
        handlePrintDialogSubmit,
    };
};
