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
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';

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

const buildPrintablePdfDataMock = vi.hoisted(() => vi.fn());
const shouldPrintPageMetricsDirectlyMock = vi.hoisted(() => vi.fn<TShouldPrintPageMetricsDirectly>(() => null));
const shouldPrintSourcePdfDirectlyMock = vi.hoisted(() => vi.fn(async () => true));
const waitForPrintPaintMock = vi.hoisted(() => vi.fn(async () => {}));
const isDesktopPlatformActiveMock = vi.hoisted(() => vi.fn(() => false));
const documentsCapabilityMock = vi.hoisted(() => ({
    printPdfData: vi.fn(),
    printPdfPath: vi.fn(),
}));
const toastAddMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/pdf-print', () => ({
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
    shouldPrintPageMetricsDirectly: shouldPrintPageMetricsDirectlyMock,
    shouldPrintSourcePdfDirectly: shouldPrintSourcePdfDirectlyMock,
    waitForPrintPaint: waitForPrintPaintMock,
}));

vi.mock('@app/utils/platform-documents', () => ({
    getDocumentsCapability: () => documentsCapabilityMock,
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

vi.mock('@app/utils/platform', () => ({ isDesktopPlatformActive: isDesktopPlatformActiveMock }));

interface IFakeFrameWindow {
    addEventListener: ReturnType<typeof vi.fn>;
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
    const frameWindow: IFakeFrameWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        focus: vi.fn(),
        print: vi.fn(),
        requestAnimationFrame: (callback: FrameRequestCallback) => {
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
        trigger: (eventName: string) => {
            listeners.get(eventName)?.(new Event(eventName));
        },
    };

    return {
        frame,
        frameWindow,
    };
}

async function flushMicrotasks(iterations = 6) {
    for (let index = 0; index < iterations; index += 1) {
        await Promise.resolve();
    }
}

function createState(options?: {
    sourcePdf?: Blob | null;
    workingCopyPath?: string | null;
    fileName?: string | null;
    hasPendingUnsavedChanges?: boolean;
    getQuickPrintPageMetrics?: () => Promise<Array<{
        width: number;
        height: number;
    }> | null>;
    getPrintableSourceData?: () => Promise<Uint8Array | null>;
}) {
    const getQuickPrintPageMetrics = options?.getQuickPrintPageMetrics ?? vi.fn(async () => null);
    const getPrintableSourceData = options?.getPrintableSourceData ?? vi.fn(async () => Uint8Array.of(9, 8, 7));
    const scope = effectScope();
    const state = scope.run(() => useWorkspacePrint({
        totalPages: ref(10),
        selectedPages: ref([
            3,
            1,
            3,
        ]),
        sourcePdf: ref(options?.sourcePdf ?? null),
        workingCopyPath: ref(options?.workingCopyPath ?? '/tmp/document.pdf'),
        fileName: ref(options?.fileName ?? 'document.pdf'),
        hasPendingUnsavedChanges: ref(options?.hasPendingUnsavedChanges ?? false),
        getQuickPrintPageMetrics,
        getPrintableSourceData,
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
        isDesktopPlatformActiveMock.mockReturnValue(false);
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(null);
        shouldPrintSourcePdfDirectlyMock.mockResolvedValue(true);
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
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

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
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:print-document'),
            revokeObjectURL: vi.fn(),
        });
    });

    it('quick-prints through the default single-page native flow', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
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
            await state.handleQuickPrint();

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/quick-print.pdf',
                'quick-print.pdf',
            );
            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('bypasses the desktop native dialog and prints through the embedded frame', async () => {
        isDesktopPlatformActiveMock.mockReturnValue(true);
        const appFrame = createFakeFrame();
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(shouldPrintSourcePdfDirectlyMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('quick-prints the current browser PDF source without rebuilding it', async () => {
        const appFrame = createFakeFrame();
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();

            appFrame.frame.trigger('load');
            await printPromise;

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
        const appFrame = createFakeFrame();
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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
            await flushMicrotasks();

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/fallback.pdf',
                'fallback.pdf',
            );
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(1, 2, 3),
                'fallback.pdf',
            );
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints the current source PDF directly in the browser for the default flow', async () => {
        const appFrame = createFakeFrame();
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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
            await flushMicrotasks();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
            expect(appFrame.frame.src).toBe('');
            expect(appFrame.frame.srcdoc).toContain('<embed src="blob:print-document" type="application/pdf">');

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(waitForPrintPaintMock).toHaveBeenCalledWith(appFrame.frameWindow);
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();

            const afterPrintHandler = vi.mocked(appFrame.frameWindow.addEventListener).mock.calls[0]?.[1] as
                | (() => void)
                | undefined;
            afterPrintHandler?.();

            expect(appFrame.frame.remove).toHaveBeenCalledTimes(1);
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:print-document');
        } finally {
            scope.stop();
        }
    });

    it('prints the working-copy path directly in Electron for the default flow', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
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

            await state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/working-copy.pdf',
                'working-copy.pdf',
            );
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('still builds a transformed PDF when the default flow cannot print from an existing source directly', async () => {
        shouldPrintSourcePdfDirectlyMock.mockResolvedValue(false);
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = createFakeFrame();
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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

            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('builds a transformed PDF and sends it to the Electron native print dialog', async () => {
        documentsCapabilityMock.printPdfData.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({ hasPendingUnsavedChanges: true });

        try {
            state.handlePrint();

            await state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            });

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                },
            );
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'document.pdf',
            );
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
        const appFrame = createFakeFrame();
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'document.pdf',
            );
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints even when the PDF frame blocks child-window event access', async () => {
        isDesktopPlatformActiveMock.mockReturnValue(true);
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
        vi.stubGlobal('document', {
            body: { append: vi.fn() },
            createElement: vi.fn((tag: string) => {
                if (tag !== 'iframe') {
                    throw new Error(`Unexpected element: ${tag}`);
                }
                return appFrame.frame;
            }),
        });
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

            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
