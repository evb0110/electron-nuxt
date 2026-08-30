import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import {
    buildBrowserPrintFrameMarkup,
    normalizePrintPageNumbers,
    type IBrowserPrintDocument,
    type TPrintOrientation,
} from '@app/utils/pdfPrintShared';
import { buildPrintSelectionFileName } from '@app/utils/buildPrintSelectionFileName';
import {
    getDocumentPdfCapability,
    isNativePrintCapabilityUnavailable,
} from '@app/utils/platformDocuments';
import type { TPageSelection } from '@contracts/pageNumbers';
import {
    createExplicitPageSelection,
    materializePageSelection,
    pageSelectionCount,
} from '@contracts/pageNumbers';

const BROWSER_PRINT_CLEANUP_TIMEOUT_MS = 60000;
const BROWSER_PRINT_LOAD_TIMEOUT_MS = 30000;
const BROWSER_PRINT_LOAD_SETTLE_DELAY_MS = 300;
const PRINT_PREPARING_TOAST_DELAY_MS = 600;
const BROWSER_PRINT_FRAME_MIN_WIDTH_PX = 1280;
const BROWSER_PRINT_FRAME_MIN_HEIGHT_PX = 1600;
const PDF_MIME_TYPE = 'application/pdf';
const NATIVE_PRINT_REQUIRED_REASON = 'requires-native-backend' as const;
const PDF_LIB_PRINT_PAGE_COUNT_LIMIT = 5_000;
const PRINT_SELECTION_MATERIALIZATION_LIMIT = 100_000;
const HIGH_PAGE_COUNT_PRINT_LAYOUT_ERROR_KEY = 'print.highPageCountAdvancedLayout' as const;

class NativePrintRequiredError extends Error {
    readonly code = 'native-print-required' as const;
    readonly unsupportedReason = NATIVE_PRINT_REQUIRED_REASON;

    constructor(message = 'Native PDF printing is required for this request') {
        super(message);
        this.name = 'NativePrintRequiredError';
    }
}

function isPathPdfSource(value: TPdfSource | null): value is Extract<TPdfSource, {kind: 'path'}> {
    return typeof value === 'object'
        && value !== null
        && 'kind' in value
        && value.kind === 'path'
        && typeof value.path === 'string';
}

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
    selectedPageSelection?: Readonly<Ref<TPageSelection | null>>;
    sourcePdf: Readonly<Ref<TPdfSource | null>>;
    workingCopyPath: Readonly<Ref<string | null>>;
    fileName: Readonly<Ref<string | null>>;
    hasPendingUnsavedChanges: Readonly<Ref<boolean>>;
    hasPendingPrintSerializationChanges?: Readonly<Ref<boolean>>;
    canPrintDjvuSource?: Readonly<Ref<boolean>>;
    getCurrentPrintPage?: () => number | null | undefined;
    getQuickPrintPageMetrics: () => Promise<IPdfPageMetric[] | null>;
    ensurePrintReady?: () => Promise<boolean>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean | string | null>;
    getPrintableSourceData: (options?: { signal?: AbortSignal }) => Promise<Uint8Array | null>;
    renderLoadedPdfPagesForBrowserPrint?: (
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) => Promise<void>;
    printDjvuSource?: (
        payload: IPrintDialogSubmitPayload,
        options?: {
            onNativePrintHandoffStart?: () => void;
            signal?: AbortSignal;
        },
    ) => Promise<void>;
}

interface IPrintDialogSubmitPayload {
    pageNumbers?: number[];
    pageSelection?: TPageSelection;
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export const useWorkspacePrint = (deps: IWorkspacePrintDeps) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const printDialogOpen = ref(false);
    const printDialogSelectedPages = ref<number[]>([]);
    const printDialogPageSelection = shallowRef<TPageSelection | null>(null);
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
    let activePrintResourceOwner: number | null = null;
    let nextPrintRunId = 0;
    let closeDialogForSystemPrint = false;
    let preparingPrintToastTimer: number | null = null;
    let preparingPrintToastId: string | number | null = null;

    const supportsAdvancedPrintOptions = computed(() => (
        !isPathPdfSource(deps.sourcePdf.value)
        && deps.totalPages.value <= PDF_LIB_PRINT_PAGE_COUNT_LIMIT
    ));

    function canPrintDjvuSource() {
        return Boolean(deps.printDjvuSource)
            && (deps.canPrintDjvuSource?.value ?? true);
    }

    function requiresNativePrintForHighPageCountLayout(payload: IPrintDialogSubmitPayload) {
        if (
            deps.totalPages.value <= PDF_LIB_PRINT_PAGE_COUNT_LIMIT
            || Boolean(payload.pageNumbers?.length)
        ) {
            return false;
        }

        return payload.viewMode !== 'single' || payload.orientation !== 'auto';
    }

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

    function cleanupPrintFrame(expectedOwner?: number) {
        if (expectedOwner !== undefined && activePrintResourceOwner !== expectedOwner) {
            return;
        }
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
        activePrintResourceOwner = null;
    }

    function clearPreparingPrintToast() {
        if (typeof window !== 'undefined' && preparingPrintToastTimer !== null) {
            window.clearTimeout(preparingPrintToastTimer);
        }
        preparingPrintToastTimer = null;

        if (preparingPrintToastId !== null) {
            toast.remove(preparingPrintToastId);
            preparingPrintToastId = null;
        }
    }

    function showPreparingPrintToast() {
        if (preparingPrintToastId !== null || !isPreparingPrint.value) {
            return;
        }
        if (typeof window !== 'undefined' && preparingPrintToastTimer !== null) {
            window.clearTimeout(preparingPrintToastTimer);
            preparingPrintToastTimer = null;
        }
        const preparingToast = toast.add({
            close: false,
            color: 'neutral',
            description: t('print.systemDialogHint'),
            duration: 0,
            icon: 'i-ph-circle-notch',
            title: t('print.preparing'),
        });
        preparingPrintToastId = preparingToast.id;
    }

    function schedulePreparingPrintToast() {
        if (typeof window === 'undefined' || preparingPrintToastTimer !== null || preparingPrintToastId !== null) {
            return;
        }

        preparingPrintToastTimer = window.setTimeout(() => {
            preparingPrintToastTimer = null;
            if (!isPreparingPrint.value) {
                return;
            }
            showPreparingPrintToast();
        }, PRINT_PREPARING_TOAST_DELAY_MS);
    }

    function cancelActivePrintPreparation() {
        activePrintAbortController?.abort();
        clearPreparingPrintToast();
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

    function resolveCurrentPageSelection() {
        const selection = deps.selectedPageSelection?.value;
        if (selection?.pageCount === deps.totalPages.value) {
            return selection;
        }
        return createExplicitPageSelection(deps.totalPages.value, normalizeSelectedPages());
    }

    function normalizeCurrentPage() {
        const page = deps.getCurrentPrintPage?.() ?? deps.currentPage.value;
        if (!Number.isInteger(page) || page < 1 || page > deps.totalPages.value) {
            return null;
        }

        return page;
    }

    function resolveBrowserPrintTitle(payload: IPrintDialogSubmitPayload) {
        return buildPrintSelectionFileName({
            fileName: deps.fileName.value,
            pageNumbers: payload.pageNumbers,
            totalPages: deps.totalPages.value,
            formatPage: page => t('print.fileNamePage', { page }),
            formatPages: pages => t('print.fileNamePages', { pages }),
            formatSelection: selection => t('print.fileNamePageSelection', selection),
        });
    }

    function handlePrint() {
        closeDialogForSystemPrint = false;
        printDialogSelectedPages.value = normalizeSelectedPages();
        printDialogPageSelection.value = resolveCurrentPageSelection();
        resetPrintError();
        printDialogOpen.value = true;
    }

    async function handleQuickPrint() {
        printDialogSelectedPages.value = normalizeSelectedPages();
        printDialogPageSelection.value = resolveCurrentPageSelection();
        resetPrintError();
        const defaultPayload = {
            viewMode: 'single',
            orientation: 'auto',
        } satisfies IPrintDialogSubmitPayload;

        if (canPrintDjvuSource()) {
            await handlePrintDialogSubmit(defaultPayload, {
                action: 'default',
                reopenDialogOnError: false,
            });
            return;
        }

        if (isPathPdfSource(deps.sourcePdf.value)) {
            await handlePrintDialogSubmit(defaultPayload, {
                action: 'default',
                reopenDialogOnError: false,
            });
            return;
        }

        const { shouldPrintPageMetricsDirectly } = await import('@app/utils/pdfPrint');
        const quickPrintPageMetrics = await deps.getQuickPrintPageMetrics();
        const printSourceDirectly = quickPrintPageMetrics !== null
            && shouldPrintPageMetricsDirectly(
                quickPrintPageMetrics,
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

    function createHiddenPrintFrame(owner: number) {
        if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.print !== 'function') {
            throw new Error('Window printing is unavailable');
        }

        cleanupPrintFrame();
        activePrintResourceOwner = owner;

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

    function installAfterPrintCleanup(frameWindow: Window, owner: number) {
        const afterPrint = () => {
            cleanupPrintFrame(owner);
        };
        window.addEventListener('afterprint', afterPrint, {once: true});
        removeAfterPrintListener = () => {
            window.removeEventListener('afterprint', afterPrint);
        };
        try {
            frameWindow.addEventListener('afterprint', afterPrint, {once: true});
            removeAfterPrintListener = () => {
                window.removeEventListener('afterprint', afterPrint);
                frameWindow.removeEventListener('afterprint', afterPrint);
            };
        } catch (error) {
            if (!isCrossOriginFrameAccessError(error)) {
                cleanupPrintFrame(owner);
                throw error;
            }
        }
        browserPrintCleanupTimer = window.setTimeout(afterPrint, BROWSER_PRINT_CLEANUP_TIMEOUT_MS);
    }

    async function printRenderedContentInHiddenFrame(
        renderContent: (
            targetDocument: IBrowserPrintDocument,
            signal: AbortSignal | undefined,
        ) => Promise<void>,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        const frame = createHiddenPrintFrame(owner);
        const frameLoad = waitForPrintFrameLoad(frame, signal);

        frame.srcdoc = buildBrowserPrintFrameMarkup(printTitle);
        await frameLoad;
        throwIfPrintAborted(signal);

        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
            cleanupPrintFrame(owner);
            throw new Error('Missing print frame window');
        }

        await renderContent(frameWindow.document, signal);
        throwIfPrintAborted(signal);

        installAfterPrintCleanup(frameWindow, owner);

        try {
            await waitForPrintFrameReady(frameWindow, signal);
            closePrintDialogForSystemDialog();
            frameWindow.focus();
            throwIfPrintAborted(signal);
            frameWindow.print();
        } catch (error) {
            cleanupPrintFrame(owner);
            throw error;
        }
    }

    async function printPdfInHiddenFrame(
        printablePdf: Blob | Uint8Array,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        await printRenderedContentInHiddenFrame(
            async (targetDocument, renderSignal) => {
                const { renderPdfPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
                await renderPdfPagesForBrowserPrint(
                    targetDocument,
                    printablePdf,
                    createPrintSignalOptions(renderSignal),
                );
            },
            printTitle,
            signal,
            owner,
        );
    }

    async function printLoadedPdfPagesInHiddenFrame(
        pageNumbers: number[],
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        if (!deps.renderLoadedPdfPagesForBrowserPrint) {
            throw new Error('Loaded PDF printing is unavailable');
        }

        await printRenderedContentInHiddenFrame(
            (targetDocument, renderSignal) => deps.renderLoadedPdfPagesForBrowserPrint!(
                targetDocument,
                pageNumbers,
                createPrintSignalOptions(renderSignal),
            ),
            printTitle,
            signal,
            owner,
        );
    }

    async function printPdfWithBrowserPdfViewer(
        printablePdf: Blob | Uint8Array,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        const frame = createHiddenPrintFrame(owner);
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

            try {
                frameWindow.document.title = printTitle;
            } catch (error) {
                if (!isCrossOriginFrameAccessError(error)) {
                    throw error;
                }
            }

            installAfterPrintCleanup(frameWindow, owner);

            await waitForPrintFrameReady(frameWindow, signal);
            closePrintDialogForSystemDialog();
            frameWindow.focus();
            throwIfPrintAborted(signal);
            frameWindow.print();
        } catch (error) {
            cleanupPrintFrame(owner);
            throw error;
        }
    }

    async function tryPrintInBrowserWithNativeFallback(
        printablePdf: Blob | Uint8Array,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        try {
            await printPdfInHiddenFrame(printablePdf, printTitle, signal, owner);
            return true;
        } catch (renderedPrintError) {
            throwIfPrintAborted(signal);
            try {
                await printPdfWithBrowserPdfViewer(printablePdf, printTitle, signal, owner);
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

    function hasPendingPathPrintChanges() {
        return deps.hasPendingUnsavedChanges.value || hasPendingPrintSerializationChanges();
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

    function resolveNativePathPrintPageNumbers(payload: IPrintDialogSubmitPayload) {
        if (payload.viewMode !== 'single' || payload.orientation !== 'auto') {
            return null;
        }

        if (!payload.pageNumbers?.length) {
            return undefined;
        }

        const pageNumbers = normalizePrintPageNumbers(payload.pageNumbers, deps.totalPages.value);
        if (pageNumbers.length === 0) {
            return null;
        }

        const totalPages = deps.totalPages.value;
        if (
            totalPages > 0
            && pageNumbers.length === totalPages
            && pageNumbers.every((pageNumber, index) => pageNumber === index + 1)
        ) {
            return undefined;
        }

        return pageNumbers;
    }

    async function tryPrintPathInNativeDialog(
        payload: IPrintDialogSubmitPayload,
        signal: AbortSignal,
    ) {
        const sourcePdf = deps.sourcePdf.value;
        if (!isPathPdfSource(sourcePdf)) {
            return false;
        }

        const pageNumbers = resolveNativePathPrintPageNumbers(payload);
        if (pageNumbers === null) {
            throw new NativePrintRequiredError(
                hasPendingPathPrintChanges()
                    ? 'Native PDF printing is required because this dirty path-backed request cannot be represented without detached staging'
                    : 'Native PDF printing is required because this path-backed request cannot be represented by the native path handoff',
            );
        }

        const printPdfPath = getDocumentPdfCapability().printPdfPath;
        if (typeof printPdfPath !== 'function') {
            throw new NativePrintRequiredError(
                'Native PDF printing is required because path printing is unavailable',
            );
        }

        const wasDirty = hasPendingPathPrintChanges();
        let printPath = sourcePdf.path;
        if (wasDirty) {
            throwIfPrintAborted(signal);
            if (!deps.ensureWorkingCopyFreshForRead) {
                throw new NativePrintRequiredError(
                    'Native PDF printing is required because the dirty working copy could not be refreshed as a path',
                );
            }

            const freshPath = await deps.ensureWorkingCopyFreshForRead();
            throwIfPrintAborted(signal);
            if (freshPath === false || freshPath === null) {
                throw new NativePrintRequiredError(
                    'Native PDF printing is required because the dirty working copy could not be saved as a path',
                );
            }

            if (typeof freshPath === 'string') {
                if (!freshPath) {
                    throw new NativePrintRequiredError(
                        'Native PDF printing is required because the refreshed working-copy path is empty',
                    );
                }
                printPath = freshPath;
            } else if (deps.workingCopyPath.value) {
                printPath = deps.workingCopyPath.value;
            } else {
                const freshSource = deps.sourcePdf.value;
                if (!isPathPdfSource(freshSource)) {
                    throw new NativePrintRequiredError(
                        'Native PDF printing is required because the refreshed working-copy path is unavailable',
                    );
                }
                printPath = freshSource.path;
            }
        }

        throwIfPrintAborted(signal);
        closePrintDialogForSystemDialog();
        showPreparingPrintToast();
        const result = pageNumbers === undefined
            ? await printPdfPath(printPath, deps.fileName.value ?? undefined)
            : await printPdfPath(printPath, deps.fileName.value ?? undefined, pageNumbers);
        throwIfPrintAborted(signal);
        if (result.success || result.canceled) {
            return true;
        }

        if (isNativePrintCapabilityUnavailable(result)) {
            throw new NativePrintRequiredError(
                result.error ?? 'Native PDF printing requires a native backend for this path-backed document',
            );
        }

        throw new Error(result.error ?? 'Failed to open the native print dialog');
    }

    async function handlePrintDialogSubmit(
        payload: IPrintDialogSubmitPayload,
        options: {
            action?: 'default' | 'current-page';
            printSourceDirectly?: boolean;
            reopenDialogOnError?: boolean;
        } = {},
    ) {
        if (isPreparingPrint.value) {
            showPreparingPrintToast();
            return;
        }
        const printRunId = ++nextPrintRunId;
        const abortController = new AbortController();
        activePrintAbortController = abortController;
        const { signal } = abortController;
        closeDialogForSystemPrint = false;
        isPreparingPrint.value = true;
        activePrintAction.value = options.action ?? 'default';
        resetPrintError();
        if (!printDialogOpen.value) {
            schedulePreparingPrintToast();
        }

        try {
            if (payload.pageSelection) {
                const selection = payload.pageSelection.pageCount === deps.totalPages.value
                    ? payload.pageSelection
                    : resolveCurrentPageSelection();
                const selectedCount = pageSelectionCount(selection);
                if (selectedCount > PRINT_SELECTION_MATERIALIZATION_LIMIT) {
                    throw new Error(t('print.selectionTooLarge'));
                }
                payload = {
                    viewMode: payload.viewMode,
                    orientation: payload.orientation,
                    ...(selectedCount === deps.totalPages.value
                        ? {}
                        : {pageNumbers: materializePageSelection(selection)}),
                };
            }
            if (requiresNativePrintForHighPageCountLayout(payload)) {
                throw new NativePrintRequiredError(t(HIGH_PAGE_COUNT_PRINT_LAYOUT_ERROR_KEY));
            }
            throwIfPrintAborted(signal);
            if (deps.ensurePrintReady && !await deps.ensurePrintReady()) {
                throw new Error('Annotation notes could not be persisted for printing');
            }
            throwIfPrintAborted(signal);

            if (canPrintDjvuSource() && deps.printDjvuSource) {
                throwIfPrintAborted(signal);
                let didStartNativePrintHandoff = false;
                await deps.printDjvuSource(payload, {
                    signal,
                    onNativePrintHandoffStart: () => {
                        didStartNativePrintHandoff = true;
                        closePrintDialogForSystemDialog();
                    },
                });
                throwIfPrintAborted(signal);
                if (!didStartNativePrintHandoff) {
                    closePrintDialogForSystemDialog();
                }
                return;
            }

            if (await tryPrintPathInNativeDialog(payload, signal)) {
                return;
            }

            const browserPrintTitle = resolveBrowserPrintTitle(payload);
            const loadedPageNumbers = resolveLoadedPdfSinglePagePrint(payload);
            if (loadedPageNumbers) {
                await printLoadedPdfPagesInHiddenFrame(
                    loadedPageNumbers,
                    browserPrintTitle,
                    signal,
                    printRunId,
                );
                return;
            }

            throwIfPrintAborted(signal);
            const sourceData = await deps.getPrintableSourceData({ signal });
            throwIfPrintAborted(signal);
            if (!sourceData) {
                throw new Error('Missing printable PDF source data');
            }

            if (options.printSourceDirectly === true) {
                if (deps.totalPages.value > PDF_LIB_PRINT_PAGE_COUNT_LIMIT) {
                    await printPdfWithBrowserPdfViewer(
                        sourceData,
                        browserPrintTitle,
                        signal,
                        printRunId,
                    );
                } else {
                    await tryPrintInBrowserWithNativeFallback(
                        sourceData,
                        browserPrintTitle,
                        signal,
                        printRunId,
                    );
                }
                return;
            }

            if (
                deps.totalPages.value > PDF_LIB_PRINT_PAGE_COUNT_LIMIT
                && payload.viewMode === 'single'
                && payload.orientation === 'auto'
                && (!payload.pageNumbers || payload.pageNumbers.length === 0)
            ) {
                await printPdfWithBrowserPdfViewer(
                    sourceData,
                    browserPrintTitle,
                    signal,
                    printRunId,
                );
                return;
            }

            const { buildPrintablePdfData } = await import('@app/utils/pdfPrint');
            const printablePdfData = await buildPrintablePdfData(sourceData, payload);
            throwIfPrintAborted(signal);
            if (!printablePdfData) {
                throw new Error('Failed to prepare printable PDF data');
            }

            await tryPrintInBrowserWithNativeFallback(
                printablePdfData,
                browserPrintTitle,
                signal,
                printRunId,
            );
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
                clearPreparingPrintToast();
                isPreparingPrint.value = false;
                activePrintAction.value = null;
                closeDialogForSystemPrint = false;
            }
        }
    }

    onScopeDispose(() => {
        activePrintAbortController?.abort();
        activePrintAbortController = null;
        clearPreparingPrintToast();
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
        printDialogPageSelection,
        isPreparingPrint,
        isPreparingCurrentPagePrint,
        printError,
        printStatus,
        supportsAdvancedPrintOptions,
        handlePrint,
        handleQuickPrint,
        handlePrintCurrentPage,
        handlePrintDialogOpenChange,
        handlePrintDialogSubmit,
    };
};
