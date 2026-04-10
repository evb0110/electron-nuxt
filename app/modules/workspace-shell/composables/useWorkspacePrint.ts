import type { Ref } from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdf';
import {
    buildPrintablePdfData,
    canPrintSourcePdfDirectly,
    shouldPrintPageMetricsDirectly,
    shouldPrintSourcePdfDirectly,
    type TPrintOrientation,
    waitForPrintPaint,
} from '@app/utils/pdf-print';
import {
    getDocumentsCapability,
    isNativePrintCapabilityUnavailable,
} from '@app/utils/platform-documents';

const BROWSER_PRINT_CLEANUP_TIMEOUT_MS = 60000;
const BROWSER_PRINT_LOAD_TIMEOUT_MS = 30000;
const BROWSER_PRINT_LOAD_SETTLE_DELAY_MS = 300;
const BROWSER_PRINT_FRAME_MIN_WIDTH_PX = 1280;
const BROWSER_PRINT_FRAME_MIN_HEIGHT_PX = 1600;

function isPathPdfSource(value: TPdfSource | null): value is Extract<TPdfSource, { kind: 'path'; }> {
    return typeof value === 'object'
        && value !== null
        && 'kind' in value
        && value.kind === 'path'
        && typeof value.path === 'string';
}

interface IWorkspacePrintDeps {
    totalPages: Readonly<Ref<number>>;
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
    printError: Ref<string | null>;
    printStatus: Ref<string | null>;
    handlePrint: () => void;
    handleQuickPrint: () => Promise<void>;
    handlePrintDialogOpenChange: (isOpen: boolean) => void;
    handlePrintDialogSubmit: (payload: IPrintDialogSubmitPayload) => Promise<void>;
}

export function useWorkspacePrint(deps: IWorkspacePrintDeps): IWorkspacePrintState {
    const { t } = useTypedI18n();
    const toast = useToast();
    const printDialogOpen = ref(false);
    const printDialogSelectedPages = ref<number[]>([]);
    const isPreparingPrint = ref(false);
    const printError = ref<string | null>(null);
    const activePrintFrame = ref<HTMLIFrameElement | null>(null);
    const activePrintObjectUrl = ref<string | null>(null);
    const printStatus = computed(() => isPreparingPrint.value ? t('print.preparing') : null);
    let removeAfterPrintListener: (() => void) | null = null;
    let browserPrintCleanupTimer: number | null = null;

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

    function cleanupPrintFrame() {
        if (typeof window !== 'undefined' && removeAfterPrintListener) {
            removeAfterPrintListener();
            removeAfterPrintListener = null;
        }

        if (typeof window !== 'undefined') {
            clearBrowserPrintCleanupTimer();
        }

        if (activePrintFrame.value) {
            activePrintFrame.value.remove();
            activePrintFrame.value = null;
        }

        if (activePrintObjectUrl.value && typeof URL !== 'undefined') {
            URL.revokeObjectURL(activePrintObjectUrl.value);
            activePrintObjectUrl.value = null;
        }
    }

    function normalizeSelectedPages() {
        return Array.from(new Set(deps.selectedPages.value))
            .filter(page => Number.isInteger(page) && page >= 1 && page <= deps.totalPages.value)
            .sort((left, right) => left - right);
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

        const directPrintFromMetrics = shouldPrintPageMetricsDirectly(
            await deps.getQuickPrintPageMetrics() ?? [],
            defaultPayload,
        );

        if (directPrintFromMetrics === true && await tryOpenDirectPrintFromCurrentSource(defaultPayload)) {
            return;
        }

        await handlePrintDialogSubmit(defaultPayload, {
            reopenDialogOnError: false,
            skipSourceDirectPrint: directPrintFromMetrics === false,
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
        await waitForPrintPaint(targetWindow);

        if (typeof window === 'undefined') {
            return;
        }

        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, BROWSER_PRINT_LOAD_SETTLE_DELAY_MS);
        });
    }

    function createPrintablePdfObjectUrl(printablePdf: Blob | Uint8Array) {
        const blob = printablePdf instanceof Blob
            ? printablePdf
            : new Blob([new Uint8Array(printablePdf)], { type: 'application/pdf' });
        const objectUrl = URL.createObjectURL(blob);
        activePrintObjectUrl.value = objectUrl;
        return objectUrl;
    }

    async function printPdfInHiddenFrame(printablePdf: Blob | Uint8Array) {
        const frame = createHiddenPrintFrame();
        const objectUrl = createPrintablePdfObjectUrl(printablePdf);
        const frameLoad = waitForPrintFrameLoad(frame);

        frame.src = objectUrl;
        await frameLoad;

        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
            cleanupPrintFrame();
            throw new Error('Missing print frame window');
        }

        const afterPrint = () => {
            cleanupPrintFrame();
        };
        window.addEventListener('afterprint', afterPrint, { once: true });
        frameWindow.addEventListener('afterprint', afterPrint, { once: true });
        removeAfterPrintListener = () => {
            window.removeEventListener('afterprint', afterPrint);
            frameWindow.removeEventListener('afterprint', afterPrint);
        };
        browserPrintCleanupTimer = window.setTimeout(afterPrint, BROWSER_PRINT_CLEANUP_TIMEOUT_MS);

        try {
            await waitForPrintFrameReady(frameWindow);
            printDialogOpen.value = false;
            frameWindow.focus();
            frameWindow.print();
        } catch (error) {
            cleanupPrintFrame();
            throw error;
        }
    }

    async function tryOpenNativePrintDialogForPdfData(printablePdfData: Uint8Array) {
        const result = await getDocumentsCapability().printPdfData(
            printablePdfData,
            deps.fileName.value ?? undefined,
        );
        if (isNativePrintCapabilityUnavailable(result)) {
            return false;
        }

        printDialogOpen.value = false;
        if (result.success || result.canceled) {
            return true;
        }

        throw new Error(result.error || 'Failed to open the native print dialog');
    }

    async function tryOpenNativePrintDialogForResolvedPath(path: string | null | undefined) {
        if (!path) {
            return false;
        }

        const result = await getDocumentsCapability().printPdfPath(
            path,
            deps.fileName.value ?? undefined,
        );
        if (isNativePrintCapabilityUnavailable(result)) {
            return false;
        }

        printDialogOpen.value = false;
        if (result.success || result.canceled) {
            return true;
        }

        throw new Error(result.error || 'Failed to open the native print dialog');
    }

    async function tryOpenNativePrintDialogForPath() {
        return tryOpenNativePrintDialogForResolvedPath(deps.workingCopyPath.value);
    }

    async function tryOpenDirectPrintFromCurrentSource(payload: IPrintDialogSubmitPayload) {
        if (deps.hasPendingUnsavedChanges.value || !canPrintSourcePdfDirectly(payload)) {
            return false;
        }

        if (await tryOpenNativePrintDialogForPath()) {
            return true;
        }

        const sourcePdf = deps.sourcePdf.value;
        if (isPathPdfSource(sourcePdf)) {
            return tryOpenNativePrintDialogForResolvedPath(sourcePdf.path);
        }

        if (sourcePdf instanceof Blob) {
            if (await tryOpenNativePrintDialogForPdfData(new Uint8Array(await sourcePdf.arrayBuffer()))) {
                return true;
            }

            await printPdfInHiddenFrame(sourcePdf);
            return true;
        }

        return false;
    }

    async function tryPrintSourcePdfDirectly(
        payload: IPrintDialogSubmitPayload,
        sourceData: Uint8Array,
    ) {
        if (deps.hasPendingUnsavedChanges.value || !canPrintSourcePdfDirectly(payload)) {
            return false;
        }

        if (!(await shouldPrintSourcePdfDirectly(sourceData, payload))) {
            return false;
        }

        if (await tryOpenNativePrintDialogForPath()) {
            return true;
        }

        const sourcePdf = deps.sourcePdf.value;
        await printPdfInHiddenFrame(
            sourcePdf instanceof Blob
                ? sourcePdf
                : sourceData,
        );
        return true;
    }

    async function handlePrintDialogSubmit(
        payload: IPrintDialogSubmitPayload,
        options: {
            reopenDialogOnError?: boolean;
            skipSourceDirectPrint?: boolean;
        } = {},
    ) {
        isPreparingPrint.value = true;
        resetPrintError();

        try {
            if (!options.skipSourceDirectPrint && await tryOpenDirectPrintFromCurrentSource(payload)) {
                return;
            }

            const sourceData = await deps.getPrintableSourceData();
            if (!sourceData) {
                throw new Error('Missing printable PDF source data');
            }

            if (!options.skipSourceDirectPrint && await tryPrintSourcePdfDirectly(payload, sourceData)) {
                return;
            }

            const printablePdfData = await buildPrintablePdfData(sourceData, payload);
            if (!printablePdfData) {
                throw new Error('Failed to prepare printable PDF data');
            }

            if (!(await tryOpenNativePrintDialogForPdfData(printablePdfData))) {
                await printPdfInHiddenFrame(printablePdfData);
            }
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
        }
    }

    onScopeDispose(() => {
        cleanupPrintFrame();
    });

    return {
        printDialogOpen,
        printDialogSelectedPages,
        isPreparingPrint,
        printError,
        printStatus,
        handlePrint,
        handleQuickPrint,
        handlePrintDialogOpenChange,
        handlePrintDialogSubmit,
    };
}
