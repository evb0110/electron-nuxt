import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';

type TShouldPrintPageMetricsDirectly = (
    metrics: Array<{
        width: number;
        height: number;
    }>,
    options: {
        viewMode: string;
        orientation: string;
        pageNumbers?: number[];
    },
) => boolean | null;

const buildBrowserPrintFrameMarkupMock = vi.hoisted(() => vi.fn(() => '<html><body><main data-browser-print-root></main></body></html>'));
const buildPrintablePdfDataMock = vi.hoisted(() => vi.fn());
const renderPdfPagesForBrowserPrintMock = vi.hoisted(() => vi.fn(async () => {}));
const shouldPrintPageMetricsDirectlyMock = vi.hoisted(() => vi.fn<TShouldPrintPageMetricsDirectly>(() => null));
const shouldPrintSourcePdfDirectlyMock = vi.hoisted(() => vi.fn(async () => true));
const waitForPrintPaintMock = vi.hoisted(() => vi.fn(async () => {}));
const createObjectURLMock = vi.hoisted(() => vi.fn(() => 'blob:print-pdf'));
const revokeObjectURLMock = vi.hoisted(() => vi.fn());
const documentsCapabilityMock = vi.hoisted(() => ({
    openPdfInDefaultAppData: vi.fn(),
    openPdfInDefaultAppPath: vi.fn(),
    printPdfData: vi.fn(),
    printPdfPath: vi.fn(),
}));
const toastAddMock = vi.hoisted(() => vi.fn());
const toastRemoveMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/pdfPrint', () => ({
    buildPrintablePdfData: buildPrintablePdfDataMock,
    canPrintSourcePdfDirectly: (options: {
        pageNumbers?: number[];
        viewMode: string;
        orientation: string;
    }) => (
        options.viewMode === 'single'
        && options.orientation === 'auto'
        && (!options.pageNumbers || options.pageNumbers.length === 0)
    ),
    renderPdfPagesForBrowserPrint: renderPdfPagesForBrowserPrintMock,
    shouldPrintPageMetricsDirectly: shouldPrintPageMetricsDirectlyMock,
    shouldPrintSourcePdfDirectly: shouldPrintSourcePdfDirectlyMock,
    waitForPrintPaint: waitForPrintPaintMock,
}));

vi.mock('@app/utils/pdfPrintShared', () => ({
    buildBrowserPrintFrameMarkup: buildBrowserPrintFrameMarkupMock,
    normalizePrintPageNumbers: (pageNumbers: number[] | undefined, totalPages: number) => {
        if (!pageNumbers?.length) {
            return range(1, totalPages + 1);
        }

        return uniq(pageNumbers)
            .filter(pageNumber => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= totalPages)
            .sort((left, right) => left - right);
    },
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentPdfCapability: () => documentsCapabilityMock,
    isNativePrintCapabilityUnavailable: (result: {
        success: boolean;
        canceled?: boolean;
        error?: string;
    }) => (
        result.success !== true
        && result.canceled !== true
        && result.error === 'Printing via the native desktop dialog is unavailable in the browser capability'
    ),
}));

interface IFakeFrameWindow {
    addEventListener: ReturnType<typeof vi.fn>;
    document: { querySelector: ReturnType<typeof vi.fn>; };
    removeEventListener: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    print: ReturnType<typeof vi.fn>;
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
}

interface IFakeFrame {
    style: Record<string, string>;
    tabIndex: number;
    src: string;
    srcdoc: string;
    setAttribute: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    contentWindow: IFakeFrameWindow | null;
    trigger: (eventName: string) => void;
}

function createFakeFrame() {
    const listeners = new Map<string, EventListener>();
    const frameDocument = { querySelector: vi.fn(() => ({
        replaceChildren: vi.fn(),
        append: vi.fn(),
    })) };
    const frameWindow: IFakeFrameWindow = {
        addEventListener: vi.fn(),
        document: frameDocument,
        removeEventListener: vi.fn(),
        focus: vi.fn(),
        print: vi.fn(),
        requestAnimationFrame: (callback) => {
            callback(0);
            return 1;
        },
    };
    const frame: IFakeFrame = {
        style: {},
        tabIndex: 0,
        src: '',
        srcdoc: '',
        setAttribute: vi.fn(),
        remove: vi.fn(),
        addEventListener: vi.fn((eventName: string, listener: EventListener) => {
            listeners.set(eventName, listener);
        }),
        removeEventListener: vi.fn((eventName: string) => {
            listeners.delete(eventName);
        }),
        contentWindow: frameWindow,
        trigger: (eventName) => {
            listeners.get(eventName)?.(new Event(eventName));
        },
    };

    return {
        frame,
        frameWindow,
    };
}

function stubDocumentWithFrame(appFrame = createFakeFrame()) {
    vi.stubGlobal('document', {
        body: { append: vi.fn() },
        createElement: vi.fn((tag: string) => {
            if (tag !== 'iframe') {
                throw new Error(`Unexpected element: ${tag}`);
            }
            return appFrame.frame;
        }),
    });

    return appFrame;
}

function stubDocumentWithFrames(frames: Array<ReturnType<typeof createFakeFrame>>) {
    let frameCreateCount = 0;
    vi.stubGlobal('document', {
        body: { append: vi.fn() },
        createElement: vi.fn((tag: string) => {
            if (tag !== 'iframe') {
                throw new Error(`Unexpected element: ${tag}`);
            }
            const frame = frames[frameCreateCount];
            frameCreateCount += 1;
            return frame?.frame ?? frames.at(-1)!.frame;
        }),
    });
}

async function flushMicrotasks(iterations = 6) {
    for (let index = 0; index < iterations; index += 1) {
        await Promise.resolve();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let index = 0; index < iterations; index += 1) {
        await Promise.resolve();
    }
}

function createState(options?: {
    sourcePdf?: Blob | null;
    workingCopyPath?: string | null;
    fileName?: string | null;
    hasPendingUnsavedChanges?: boolean;
    hasPendingPrintSerializationChanges?: boolean;
    getQuickPrintPageMetrics?: () => Promise<Array<{
        width: number;
        height: number;
    }> | null>;
    getPrintableSourceData?: () => Promise<Uint8Array | null>;
    ensurePrintReady?: () => Promise<boolean>;
    canPrintDjvuSource?: boolean;
    getCurrentPrintPage?: () => number | null | undefined;
    printDjvuSource?: (
        payload: {
            pageNumbers?: number[];
            viewMode: string;
            orientation: string;
        },
        options?: {
            onNativePrintHandoffStart?: () => void;
            signal?: AbortSignal;
        },
    ) => Promise<void>;
    renderLoadedPdfPagesForBrowserPrint?: (
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) => Promise<void>;
}) {
    const getQuickPrintPageMetrics = options?.getQuickPrintPageMetrics ?? vi.fn(async () => null);
    const getPrintableSourceData = options?.getPrintableSourceData ?? vi.fn(async () => Uint8Array.of(9, 8, 7));
    const scope = effectScope();
    const state = scope.run(() => useWorkspacePrint({
        totalPages: ref(10),
        currentPage: ref(4),
        selectedPages: ref([
            3,
            1,
            3,
        ]),
        sourcePdf: ref(options?.sourcePdf ?? null),
        workingCopyPath: ref(options?.workingCopyPath ?? '/tmp/document.pdf'),
        fileName: ref(options?.fileName ?? 'document.pdf'),
        hasPendingUnsavedChanges: ref(options?.hasPendingUnsavedChanges ?? false),
        ...(options?.hasPendingPrintSerializationChanges !== undefined
            ? { hasPendingPrintSerializationChanges: ref(options.hasPendingPrintSerializationChanges) }
            : {}),
        ...(options?.canPrintDjvuSource !== undefined
            ? { canPrintDjvuSource: ref(options.canPrintDjvuSource) }
            : {}),
        ...(options?.getCurrentPrintPage
            ? { getCurrentPrintPage: options.getCurrentPrintPage }
            : {}),
        getQuickPrintPageMetrics,
        ...(options?.ensurePrintReady ? {ensurePrintReady: options.ensurePrintReady} : {}),
        getPrintableSourceData,
        ...(options?.printDjvuSource
            ? { printDjvuSource: options.printDjvuSource }
            : {}),
        ...(options?.renderLoadedPdfPagesForBrowserPrint
            ? { renderLoadedPdfPagesForBrowserPrint: options.renderLoadedPdfPagesForBrowserPrint }
            : {}),
    }));

    if (!state) {
        throw new Error('Failed to create workspace print scope');
    }

    return {
        getQuickPrintPageMetrics,
        getPrintableSourceData,
        scope,
        state,
    };
}

describe('useWorkspacePrint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buildBrowserPrintFrameMarkupMock.mockReturnValue('<html><body><main data-browser-print-root></main></body></html>');
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        createObjectURLMock.mockReturnValue('blob:print-pdf');
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(null);
        shouldPrintSourcePdfDirectlyMock.mockResolvedValue(true);
        toastAddMock.mockReturnValue({ id: 'toast-id' });
        documentsCapabilityMock.openPdfInDefaultAppData.mockResolvedValue({ success: false });
        documentsCapabilityMock.openPdfInDefaultAppPath.mockResolvedValue({ success: false });
        documentsCapabilityMock.printPdfData.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string, params?: Record<string, unknown>) => {
            if (key === 'print.failedWithReason' && params?.reason) {
                return `print.failedWithReason:${String(params.reason)}`;
            }
            return key;
        } }));
        vi.stubGlobal('useToast', () => ({
            add: toastAddMock,
            remove: toastRemoveMock,
        }));
        vi.stubGlobal('URL', {
            createObjectURL: createObjectURLMock,
            revokeObjectURL: revokeObjectURLMock,
        });

        let timerId = 0;
        vi.stubGlobal('window', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            focus: vi.fn(),
            print: vi.fn(),
            setTimeout: vi.fn((callback: () => void, delay?: number) => {
                timerId += 1;
                if (delay === 300) {
                    callback();
                }
                return timerId;
            }),
            clearTimeout: vi.fn(),
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
        });
    });

    it('aborts printing when open annotation-note persistence is not ready', async () => {
        const ensurePrintReady = vi.fn(async () => false);
        const getPrintableSourceData = vi.fn(async () => Uint8Array.of(1, 2, 3));
        const {
            scope,
            state,
        } = createState({
            ensurePrintReady,
            getPrintableSourceData,
        });

        await state.handlePrintDialogSubmit({
            viewMode: 'single',
            orientation: 'auto',
        }, {reopenDialogOnError: false});

        expect(ensurePrintReady).toHaveBeenCalledOnce();
        expect(getPrintableSourceData).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'print.failed',
        }));
        scope.stop();
    });

    it('quick-prints through rendered browser printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/quick-print.pdf',
            fileName: 'quick-print.pdf',
            getQuickPrintPageMetrics: vi.fn(async () => [{
                width: 612,
                height: 792,
            }]),
        });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(true);

        try {
            const printPromise = state.handleQuickPrint();
            await flushMicrotasks(20);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            appFrame.frame.trigger('load');
            await printPromise;

            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(toastAddMock).toHaveBeenCalledWith({
                color: 'success',
                title: 'print.requestSent',
            });
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('does not use the direct metrics policy when quick-print metrics are unavailable', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            scope,
            state,
        } = createState({ getQuickPrintPageMetrics: vi.fn(async () => null) });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(true);

        try {
            const printPromise = state.handleQuickPrint();
            await flushMicrotasks(12);

            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(shouldPrintPageMetricsDirectlyMock).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;
        } finally {
            scope.stop();
        }
    });

    it('prints DjVu through the DjVu print source without serializing PDF data', async () => {
        const printDjvuSource = vi.fn(async () => {});
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            canPrintDjvuSource: true,
            printDjvuSource,
        });

        try {
            await state.handlePrintDialogSubmit({
                pageNumbers: [4],
                viewMode: 'single',
                orientation: 'auto',
            });

            expect(printDjvuSource).toHaveBeenCalledWith({
                pageNumbers: [4],
                viewMode: 'single',
                orientation: 'auto',
            }, {
                onNativePrintHandoffStart: expect.any(Function),
                signal: expect.any(AbortSignal),
            });
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('closes the app print dialog as soon as DjVu reaches the native print handoff', async () => {
        let finishPrint!: () => void;
        const printDjvuSource = vi.fn(async (
            _payload,
            options?: { onNativePrintHandoffStart?: () => void },
        ) => {
            options?.onNativePrintHandoffStart?.();
            await new Promise<void>(resolve => {
                finishPrint = resolve;
            });
        });
        const {
            scope,
            state,
        } = createState({
            canPrintDjvuSource: true,
            printDjvuSource,
        });

        try {
            state.handlePrint();
            expect(state.printDialogOpen.value).toBe(true);

            const submitPromise = state.handlePrintDialogSubmit({
                pageNumbers: [4],
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(4);

            expect(state.printDialogOpen.value).toBe(false);
            expect(state.isPreparingPrint.value).toBe(true);

            finishPrint();
            await submitPromise;

            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('uses the live viewer page when printing the current DjVu page', async () => {
        const printDjvuSource = vi.fn(async () => {});
        const {
            scope,
            state,
        } = createState({
            canPrintDjvuSource: true,
            getCurrentPrintPage: () => 7,
            printDjvuSource,
        });

        try {
            await state.handlePrintCurrentPage();

            expect(printDjvuSource).toHaveBeenCalledWith({
                pageNumbers: [7],
                viewMode: 'single',
                orientation: 'auto',
            }, {
                onNativePrintHandoffStart: expect.any(Function),
                signal: expect.any(AbortSignal),
            });
        } finally {
            scope.stop();
        }
    });

    it('shows delayed preparing feedback while current-page DjVu printing waits for native handoff', async () => {
        const timeoutCallbacks = new Map<number, () => void>();
        let timerId = 0;
        vi.stubGlobal('window', {
            setTimeout: vi.fn((callback: () => void) => {
                timerId += 1;
                timeoutCallbacks.set(timerId, callback);
                return timerId;
            }),
            clearTimeout: vi.fn((id: number) => {
                timeoutCallbacks.delete(id);
            }),
        });

        let finishPrint!: () => void;
        let startNativePrintHandoff!: () => void;
        const printDjvuSource = vi.fn(async (
            _payload,
            options?: { onNativePrintHandoffStart?: () => void },
        ) => {
            startNativePrintHandoff = () => options?.onNativePrintHandoffStart?.();
            await new Promise<void>(resolve => {
                finishPrint = resolve;
            });
        });
        const {
            scope,
            state,
        } = createState({
            canPrintDjvuSource: true,
            getCurrentPrintPage: () => 7,
            printDjvuSource,
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(4);

            timeoutCallbacks.get(1)?.();
            expect(toastAddMock).toHaveBeenCalledWith({
                close: false,
                color: 'neutral',
                description: 'print.systemDialogHint',
                duration: 0,
                icon: 'i-ph-circle-notch',
                title: 'print.preparing',
            });

            startNativePrintHandoff();
            expect(toastRemoveMock).toHaveBeenCalledWith('toast-id');

            finishPrint();
            await printPromise;

            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('uses rendered browser printing for the default flow when a working copy path is available', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/desktop.pdf',
            fileName: 'desktop.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppData).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(buildBrowserPrintFrameMarkupMock).toHaveBeenCalledTimes(1);
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints only the current page through rendered browser printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [4],
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;

            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints the current loaded PDF.js page without rebuilding the whole PDF', async () => {
        const renderLoadedPdfPagesForBrowserPrint = vi.fn(async () => {});
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
            hasPendingUnsavedChanges: true,
            hasPendingPrintSerializationChanges: false,
            renderLoadedPdfPagesForBrowserPrint,
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await printPromise;

            expect(renderLoadedPdfPagesForBrowserPrint).toHaveBeenCalledWith(
                appFrame.frameWindow.document,
                [4],
                { signal: expect.any(AbortSignal) },
            );
            expect(renderPdfPagesForBrowserPrintMock).not.toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('cancels current-page loaded-PDF print preparation', async () => {
        let abortSignal: AbortSignal | undefined;
        const renderLoadedPdfPagesForBrowserPrint = vi.fn(async (
            _targetDocument,
            _pageNumbers,
            options?: { signal?: AbortSignal },
        ) => {
            abortSignal = options?.signal;
            await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    const error = new Error('Print preparation was canceled');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        });
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
            renderLoadedPdfPagesForBrowserPrint,
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await flushMicrotasks(12);

            expect(state.isPreparingPrint.value).toBe(true);
            state.handlePrintDialogOpenChange(false);

            expect(abortSignal?.aborted).toBe(true);
            expect(appFrame.frame.remove).toHaveBeenCalledTimes(1);

            await printPromise;

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(appFrame.frameWindow.print).not.toHaveBeenCalled();
            expect(toastAddMock).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('falls back to a one-page printable PDF when native current-page extraction is unavailable', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [4],
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('falls back to a one-page printable PDF when native current-page extraction rejects', async () => {
        documentsCapabilityMock.printPdfPath.mockRejectedValue(new Error('Path is outside the allowed working directory'));
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [4],
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;

            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(toastAddMock).toHaveBeenCalledWith({
                color: 'success',
                title: 'print.requestSent',
            });
        } finally {
            scope.stop();
        }
    });

    it('quick-prints the current browser PDF source without rebuilding it', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }),
            getQuickPrintPageMetrics: vi.fn(async () => [{
                width: 612,
                height: 792,
            }]),
        });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(true);

        try {
            const printPromise = state.handleQuickPrint();
            await flushMicrotasks(12);

            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();

            appFrame.frame.trigger('load');
            await printPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(appFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('falls back to browser printing when native path printing is unavailable', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }),
            workingCopyPath: '/tmp/fallback.pdf',
            fileName: 'fallback.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints the current source PDF directly in the browser for the default flow', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({ sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }) });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            expect(appFrame.frame.src).toBe('');
            expect(appFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(Uint8Array.of(9, 8, 7), {
                viewMode: 'single',
                orientation: 'auto',
            });
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(waitForPrintPaintMock).toHaveBeenCalledWith(appFrame.frameWindow);
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();

            const afterPrintHandler = vi.mocked(appFrame.frameWindow.addEventListener).mock.calls[0]?.[1] as
                | (() => void)
                | undefined;
            afterPrintHandler?.();

            expect(appFrame.frame.remove).toHaveBeenCalledTimes(1);
        } finally {
            scope.stop();
        }
    });

    it('never hands print jobs to the default PDF app when using rendered browser printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/working-copy.pdf',
            fileName: 'working-copy.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await submitPromise;

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppData).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('still builds a transformed PDF when the default flow cannot print from an existing source directly', async () => {
        shouldPrintSourcePdfDirectlyMock.mockResolvedValue(false);
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: null,
            getQuickPrintPageMetrics: vi.fn(async () => [{
                width: 734.4,
                height: 1113.12,
            }]),
        });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(false);

        try {
            const submitPromise = state.handleQuickPrint();

            await flushMicrotasks(12);

            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('builds a transformed PDF and prints it through the rendered browser path', async () => {
        documentsCapabilityMock.printPdfData.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({ hasPendingUnsavedChanges: true });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            });
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await submitPromise;

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                },
            );
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('falls back to browser printing when native data printing is unavailable', async () => {
        documentsCapabilityMock.printPdfData.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({ hasPendingUnsavedChanges: true });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            });
            await flushMicrotasks();

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                },
            );
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('falls back to PDF viewer browser printing when rendered browser printing cannot print', async () => {
        const renderedFrame = createFakeFrame();
        const pdfViewerFrame = createFakeFrame();
        renderedFrame.frameWindow.print.mockImplementation(() => {
            throw new Error('Blocked a frame with origin "http://127.0.0.1:3235" from accessing a cross-origin frame.');
        });
        stubDocumentWithFrames([
            renderedFrame,
            pdfViewerFrame,
        ]);
        const {
            scope,
            state,
        } = createState({ sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }) });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(renderedFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');
            renderedFrame.frame.trigger('load');
            await flushMicrotasks(12);

            expect(pdfViewerFrame.frame.src).toBe('blob:print-pdf');
            pdfViewerFrame.frame.trigger('load');
            await submitPromise;

            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalledWith(
                renderedFrame.frameWindow.document,
                Uint8Array.of(7, 8, 9),
                { signal: expect.any(AbortSignal) },
            );
            expect(pdfViewerFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints even when the PDF frame blocks child-window event access', async () => {
        waitForPrintPaintMock.mockRejectedValueOnce(
            new Error(
                'Blocked a frame with origin "http://127.0.0.1:3235" from accessing a cross-origin frame.',
            ),
        );
        const appFrame = createFakeFrame();
        appFrame.frameWindow.addEventListener.mockImplementation(() => {
            throw new Error(
                'Blocked a frame with origin "http://127.0.0.1:3235" from accessing a cross-origin frame.',
            );
        });
        appFrame.frameWindow.removeEventListener.mockImplementation(() => {
            throw new Error('removeEventListener should not run for blocked cross-origin frames');
        });
        stubDocumentWithFrame(appFrame);
        const {
            scope,
            state,
        } = createState({ sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }) });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
