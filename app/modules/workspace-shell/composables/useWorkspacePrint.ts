import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdf';
import {
    buildBrowserPrintFrameMarkup,
    buildPrintablePdfData,
    renderPdfPagesForBrowserPrint,
    shouldPrintPageMetricsDirectly,
    type TPrintOrientation,
    waitForPrintPaint,
} from '@app/utils/pdfPrint';
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

interface IWorkspacePrintDeps {
    totalPages: Readonly<Ref<number>>;
    currentPage: Readonly<Ref<number>>;
    selectedPages: Readonly<Ref<number[]>>;
    sourcePdf: Readonly<Ref<TPdfSource | null>>;
    workingCopyPath: Readonly<Ref<string | null>>;
    fileName: Readonly<Ref<string | null>>;
    hasPendingUnsavedChanges: Readonly<Ref<boolean>>;
    getQuickPrintPageMetrics: () => Promise<IPdfPageMetric[] | null>;
    getPrintableSourceData: () => Promise<Uint8Array | null>;
}

interface IPrintDialogSubmitPayload {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

interface IWorkspacePrintState {
    printDialogOpen: Ref<boolean>;
    printDialogSelectedPages: Ref<number[]>;
    isPreparingPrint: Ref<boolean>;
    isPreparingCurrentPagePrint: Readonly<Ref<boolean>>;
    printError: Ref<string | null>;
    printStatus: Ref<string | null>;
    handlePrint: () => void;
    handleQuickPrint: () => Promise<void>;
    handlePrintCurrentPage: () => Promise<void>;
    handlePrintDialogOpenChange: (isOpen: boolean) => void;
    handlePrintDialogSubmit: (payload: IPrintDialogSubmitPayload) => Promise<void>;
}

export const useWorkspacePrint = (deps: IWorkspacePrintDeps): IWorkspacePrintState => {
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

        shouldPrintPageMetricsDirectly(
            await deps.getQuickPrintPageMetrics() ?? [],
            defaultPayload,
        );

        await handlePrintDialogSubmit(defaultPayload, {
            action: 'default',
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
            resetPrintError();
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

    function waitForPrintFrameLoad(frame: HTMLIFrameElement) {
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
            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(new Error('Timed out while preparing the printable PDF'));
            }, BROWSER_PRINT_LOAD_TIMEOUT_MS);
            const cleanup = () => {
                frame.removeEventListener('load', onLoad);
                frame.removeEventListener('error', onError);
                window.clearTimeout(timeoutId);
            };

            frame.addEventListener('load', onLoad, { once: true });
            frame.addEventListener('error', onError, { once: true });
        });
    }

    async function waitForPrintFrameReady(targetWindow: Window) {
        try {
            await waitForPrintPaint(targetWindow);
        } catch (error) {
            if (!isCrossOriginFrameAccessError(error)) {
                throw error;
            }
        }

        if (typeof window === 'undefined') {
            return;
        }

        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, BROWSER_PRINT_LOAD_SETTLE_DELAY_MS);
        });
    }

    async function printPdfInHiddenFrame(printablePdf: Blob | Uint8Array) {
        const frame = createHiddenPrintFrame();
        const frameLoad = waitForPrintFrameLoad(frame);

        frame.srcdoc = buildBrowserPrintFrameMarkup();
        await frameLoad;

        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
            cleanupPrintFrame();
            throw new Error('Missing print frame window');
        }

        await renderPdfPagesForBrowserPrint(frameWindow.document, printablePdf);

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
            await waitForPrintFrameReady(frameWindow);
            printDialogOpen.value = false;
            frameWindow.focus();
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

    async function printPdfWithBrowserPdfViewer(printablePdf: Blob | Uint8Array) {
        const frame = createHiddenPrintFrame();
        const printUrl = createBrowserPrintUrl(printablePdf);
        activeBrowserPrintUrl = printUrl;
        const frameLoad = waitForPrintFrameLoad(frame);

        frame.src = printUrl;

        try {
            await frameLoad;

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

            await waitForPrintFrameReady(frameWindow);
            printDialogOpen.value = false;
            frameWindow.focus();
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
    ) {
        try {
            await printPdfInHiddenFrame(printablePdf);
            return true;
        } catch (renderedPrintError) {
            try {
                await printPdfWithBrowserPdfViewer(printablePdf);
                return true;
            } catch (pdfViewerPrintError) {
                throw pdfViewerPrintError instanceof Error
                    ? pdfViewerPrintError
                    : renderedPrintError;
            }
        }
    }

    async function handlePrintDialogSubmit(
        payload: IPrintDialogSubmitPayload,
        options: {
            action?: 'default' | 'current-page';
            reopenDialogOnError?: boolean;
        } = {},
    ) {
        isPreparingPrint.value = true;
        activePrintAction.value = options.action ?? 'default';
        resetPrintError();

        try {
            const sourceData = await deps.getPrintableSourceData();
            if (!sourceData) {
                throw new Error('Missing printable PDF source data');
            }

            const printablePdfData = await buildPrintablePdfData(sourceData, payload);
            if (!printablePdfData) {
                throw new Error('Failed to prepare printable PDF data');
            }

            await tryPrintInBrowserWithNativeFallback(printablePdfData);
        } catch (error) {
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
            isPreparingPrint.value = false;
            activePrintAction.value = null;
        }
    }

    onScopeDispose(() => {
        cleanupPrintFrame();
        printDialogOpen.value = false;
        printDialogSelectedPages.value = [];
        isPreparingPrint.value = false;
        activePrintAction.value = null;
        printError.value = null;
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
