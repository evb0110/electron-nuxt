// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
} from 'vue';
import { usePdfViewerNavigationDiagnostics } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerNavigationDiagnostics';

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {diagnostic: vi.fn()}}));

type TPdfRenderTraceTestWindow = Window & {
    __getPdfRenderTrace?: () => Array<{
        event: string;
        payload: Record<string, unknown>;
    }>;
    __pdfRenderTrace?: boolean;
    __pdfRenderTraceBuffer?: unknown[];
};

describe('PDF viewer navigation diagnostics', () => {
    afterEach(() => {
        const traceWindow = window as TPdfRenderTraceTestWindow;
        delete traceWindow.__getPdfRenderTrace;
        delete traceWindow.__pdfRenderTrace;
        delete traceWindow.__pdfRenderTraceBuffer;
        vi.clearAllMocks();
    });

    it('publishes the current scheduler snapshot immediately when diagnostics activate', () => {
        const snapshot = {
            accepting: true,
            queueDepth: 0,
            queuedByLane: {
                'navigation-target': 0,
                'viewport-visible': 0,
                'viewport-nearby': 0,
                'thumbnail-current': 0,
                'thumbnail-visible': 0,
                prefetch: 0,
            },
            inFlightByLane: {
                'navigation-target': 0,
                'viewport-visible': 0,
                'viewport-nearby': 0,
                'thumbnail-current': 0,
                'thumbnail-visible': 0,
                prefetch: 0,
            },
            inFlightPages: [],
            residentPages: [],
            reservedPixels: 0,
        } as const;
        const getRasterSchedulerSnapshot = vi.fn(() => snapshot);
        const traceWindow = window as TPdfRenderTraceTestWindow;
        traceWindow.__pdfRenderTrace = true;
        traceWindow.__pdfRenderTraceBuffer = [];
        const scope = effectScope();

        scope.run(() => usePdfViewerNavigationDiagnostics({
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            isLoading: ref(false),
            continuousScroll: computed(() => false),
            fitMode: computed(() => 'height'),
            viewMode: computed(() => 'single'),
            zoom: computed(() => 1),
            navigationAnchorWindow: computed(() => null),
            virtualizedContinuousMode: computed(() => false),
            virtualWindowStart: computed(() => 1),
            virtualWindowEnd: computed(() => 1),
            searchNavigationTargetPage: ref(null),
            searchNavigationState: ref('idle'),
            getRasterSchedulerSnapshot,
            summarizeViewerStateForLog: () => null,
        }));

        expect(getRasterSchedulerSnapshot).toHaveBeenCalledOnce();
        expect(traceWindow.__getPdfRenderTrace?.()).toContainEqual({
            event: 'raster-scheduler-snapshot',
            payload: expect.objectContaining({scheduler: snapshot}),
        });
        scope.stop();
    });
});
