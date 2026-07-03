import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfHistory } from '@app/modules/pdf-viewer/runtime/composables/usePdfHistory';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';
import { cast } from '@tests/helpers/cast';

const loggerWarn = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    warn: (...args: unknown[]) => loggerWarn(...args),
}}));

function createMockDeps(overrides: Partial<Parameters<typeof usePdfHistory>[0]> = {}) {
    return cast<Parameters<typeof usePdfHistory>[0]>({
        pdfDocument: ref<PDFDocumentProxy | null>(null),
        pdfViewerRef: ref<{
            scrollToPage: (page: number) => void;
            captureScrollSnapshot?: () => IScrollSnapshot | null;
            restoreScrollSnapshot?: (
                snapshot: IScrollSnapshot | null,
                options?: { fallbackPage?: number | null; },
            ) => void;
            undoAnnotation: () => void;
            redoAnnotation: () => void;
        } | null>(null),
        currentPage: ref(1),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        canUndo: ref(true),
        canRedo: ref(true),
        isAnnotationUndoContext: ref(false),
        nextUndoSource: ref<TWorkspaceUndoSource | null>('file'),
        nextRedoSource: ref<TWorkspaceUndoSource | null>('file'),
        workingCopyPath: ref<string | null>('/tmp/test.pdf'),
        resetSearchCache: vi.fn(),
        clearOcrCache: vi.fn(),
        undoHistory: vi.fn(async () => true),
        redoHistory: vi.fn(async () => true),
        ...overrides,
    });
}

describe('usePdfHistory', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        loggerWarn.mockClear();
    });

    it('sets isHistoryBusy during undo and clears it after', async () => {
        const deps = createMockDeps();
        const { handleUndo } = usePdfHistory(deps);

        const undoPromise = handleUndo();

        expect(deps.isHistoryBusy.value).toBe(true);

        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('sets isHistoryBusy during redo and clears it after', async () => {
        const deps = createMockDeps();
        const { handleRedo } = usePdfHistory(deps);

        const redoPromise = handleRedo();

        expect(deps.isHistoryBusy.value).toBe(true);

        await vi.advanceTimersByTimeAsync(9000);
        await redoPromise;

        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('clears isHistoryBusy even when undo throws', async () => {
        const deps = createMockDeps({undoHistory: vi.fn(async () => { throw new Error('undo failed'); })});
        const { handleUndo } = usePdfHistory(deps);

        await expect(handleUndo()).rejects.toThrow('undo failed');
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('does nothing when isAnySaving is true', async () => {
        const deps = createMockDeps({ isAnySaving: ref(true) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undoHistory).not.toHaveBeenCalled();
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('does nothing when canUndo is false', async () => {
        const deps = createMockDeps({ canUndo: ref(false) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undoHistory).not.toHaveBeenCalled();
    });

    it('does nothing when canRedo is false', async () => {
        const deps = createMockDeps({ canRedo: ref(false) });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(deps.redoHistory).not.toHaveBeenCalled();
    });

    it('skips when already busy', async () => {
        const deps = createMockDeps({ isHistoryBusy: ref(true) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undoHistory).not.toHaveBeenCalled();
    });

    it('delegates to undoAnnotation when in annotation context', async () => {
        const undoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            nextUndoSource: ref<TWorkspaceUndoSource | null>(null),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation,
                redoAnnotation: vi.fn(),
            }),
        });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(undoAnnotation).toHaveBeenCalledOnce();
        expect(deps.undoHistory).not.toHaveBeenCalled();
    });

    it('delegates to redoAnnotation when in annotation context', async () => {
        const redoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            nextRedoSource: ref<TWorkspaceUndoSource | null>(null),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation: vi.fn(),
                redoAnnotation,
            }),
        });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(redoAnnotation).toHaveBeenCalledOnce();
        expect(deps.redoHistory).not.toHaveBeenCalled();
    });

    it('routes metadata undo through timeline when annotation context has no undoable annotation', async () => {
        const undoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            canUndoAnnotation: ref(false),
            nextUndoSource: ref('metadata'),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation,
                redoAnnotation: vi.fn(),
            }),
        });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(undoAnnotation).not.toHaveBeenCalled();
        expect(deps.undoHistory).toHaveBeenCalledOnce();
    });

    it('routes metadata redo through timeline when annotation context has no redoable annotation', async () => {
        const redoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            canRedoAnnotation: ref(false),
            nextRedoSource: ref('metadata'),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation: vi.fn(),
                redoAnnotation,
            }),
        });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(redoAnnotation).not.toHaveBeenCalled();
        expect(deps.redoHistory).toHaveBeenCalledOnce();
    });

    it('routes annotation-context undo to the top timeline source', async () => {
        const undoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            undoHistory: vi.fn(async () => false),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation,
                redoAnnotation: vi.fn(),
            }),
        });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(undoAnnotation).not.toHaveBeenCalled();
        expect(deps.undoHistory).toHaveBeenCalledOnce();
    });

    it('routes annotation-context redo to the top timeline source', async () => {
        const redoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            redoHistory: vi.fn(async () => false),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation: vi.fn(),
                redoAnnotation,
            }),
        });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(redoAnnotation).not.toHaveBeenCalled();
        expect(deps.redoHistory).toHaveBeenCalledOnce();
    });

    it('keeps redo on the timeline after a timeline undo', async () => {
        const nextUndoSource = ref<TWorkspaceUndoSource | null>('file');
        const nextRedoSource = ref<TWorkspaceUndoSource | null>(null);
        const redoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            nextUndoSource,
            nextRedoSource,
            undoHistory: vi.fn(async () => {
                nextUndoSource.value = null;
                nextRedoSource.value = 'file';
                return true;
            }),
            redoHistory: vi.fn(async () => true),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation: vi.fn(),
                redoAnnotation,
            }),
        });
        const {
            handleUndo,
            handleRedo,
        } = usePdfHistory(deps);

        const undoPromise = handleUndo();
        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        const redoPromise = handleRedo();
        await vi.advanceTimersByTimeAsync(9000);
        await redoPromise;

        expect(redoAnnotation).not.toHaveBeenCalled();
        expect(deps.redoHistory).toHaveBeenCalledOnce();
    });

    it('routes annotation timeline sources through timeline history without file reload work', async () => {
        const clearOcrCache = vi.fn();
        const deps = createMockDeps({
            clearOcrCache,
            nextUndoSource: ref<TWorkspaceUndoSource | null>('annotation'),
        });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undoHistory).toHaveBeenCalledOnce();
        expect(clearOcrCache).not.toHaveBeenCalled();
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('logs when undo is available but the next undo source is missing', async () => {
        const deps = createMockDeps({ nextUndoSource: ref<TWorkspaceUndoSource | null>(null) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(loggerWarn).toHaveBeenCalledWith(
            'pdf-history',
            'Undo requested but no timeline history source was available',
            {
                direction: 'undo',
                canUndo: true,
                canRedo: true,
                isAnnotationUndoContext: false,
            },
        );
        expect(deps.undoHistory).not.toHaveBeenCalled();
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('logs when redo is available but the next redo source is missing', async () => {
        const deps = createMockDeps({ nextRedoSource: ref<TWorkspaceUndoSource | null>(null) });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(loggerWarn).toHaveBeenCalledWith(
            'pdf-history',
            'Redo requested but no timeline history source was available',
            {
                direction: 'redo',
                canUndo: true,
                canRedo: true,
                isAnnotationUndoContext: false,
            },
        );
        expect(deps.redoHistory).not.toHaveBeenCalled();
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('clears OCR cache before undo', async () => {
        const clearOcrCache = vi.fn();
        const undoHistory = vi.fn(async () => true);
        const deps = createMockDeps({
            clearOcrCache,
            undoHistory,
        });
        const { handleUndo } = usePdfHistory(deps);

        const undoPromise = handleUndo();
        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/test.pdf');
        expect(clearOcrCache.mock.invocationCallOrder[0]).toBeLessThan(
            undoHistory.mock.invocationCallOrder[0]!,
        );
    });

    it('does not clear OCR cache for metadata undo', async () => {
        const deps = createMockDeps({ nextUndoSource: ref('metadata') });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undoHistory).toHaveBeenCalledOnce();
        expect(deps.clearOcrCache).not.toHaveBeenCalled();
    });

    it('resolves waitForPdfReload on timeout when document does not change', async () => {
        const deps = createMockDeps();
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(3);
        let settled = false;
        void promise.then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(7999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await promise;
        expect(settled).toBe(true);
    });

    it('resolves waitForPdfReload early when pdfDocument changes', async () => {
        const deps = createMockDeps();
        const scrollToPage = vi.fn();
        deps.pdfViewerRef.value = {
            scrollToPage,
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
        };
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(5);

        deps.pdfDocument.value = { numPages: 10 } as PDFDocumentProxy;
        await nextTick();
        await vi.advanceTimersByTimeAsync(32);
        await promise;

        expect(deps.resetSearchCache).toHaveBeenCalledOnce();
    });

    it('restores the captured scroll snapshot when the viewer exposes exact restore hooks', async () => {
        const deps = createMockDeps();
        const scrollToPage = vi.fn();
        const captureScrollSnapshot = vi.fn(() => ({
            width: 1200,
            height: 2400,
            centerX: 600,
            centerY: 900,
            anchorPage: 5,
            anchorViewportX: 200,
            anchorViewportY: 160,
        }) satisfies IScrollSnapshot);
        const restoreScrollSnapshot = vi.fn();
        deps.pdfViewerRef.value = {
            scrollToPage,
            captureScrollSnapshot,
            restoreScrollSnapshot,
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
        };
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(5);

        deps.pdfDocument.value = { numPages: 10 } as PDFDocumentProxy;
        await nextTick();
        await vi.advanceTimersByTimeAsync(32);
        await promise;

        expect(captureScrollSnapshot).toHaveBeenCalledOnce();
        expect(restoreScrollSnapshot).toHaveBeenCalledWith({
            width: 1200,
            height: 2400,
            centerX: 600,
            centerY: 900,
            anchorPage: 5,
            anchorViewportX: 200,
            anchorViewportY: 160,
        }, { fallbackPage: 5 });
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('can force page-only reload restoration without using the scroll snapshot', async () => {
        const deps = createMockDeps();
        const scrollToPage = vi.fn();
        const captureScrollSnapshot = vi.fn(() => ({
            width: 1200,
            height: 2400,
            centerX: 600,
            centerY: 900,
            anchorPage: 5,
        }) satisfies IScrollSnapshot);
        const restoreScrollSnapshot = vi.fn();
        deps.pdfViewerRef.value = {
            scrollToPage,
            captureScrollSnapshot,
            restoreScrollSnapshot,
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
        };
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(5, { captureScrollSnapshot: false });

        deps.pdfDocument.value = { numPages: 10 } as PDFDocumentProxy;
        await nextTick();
        await vi.advanceTimersByTimeAsync(32);
        await promise;

        expect(captureScrollSnapshot).not.toHaveBeenCalled();
        expect(restoreScrollSnapshot).not.toHaveBeenCalled();
        expect(scrollToPage).toHaveBeenCalledWith(5);
    });

    it('does not call scrollToPage if doc reference stays the same', async () => {
        const doc = cast<PDFDocumentProxy>({ numPages: 3 });
        const deps = createMockDeps({ pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(doc)) });
        const scrollToPage = vi.fn();
        deps.pdfViewerRef.value = {
            scrollToPage,
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
        };
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(2);

        deps.pdfDocument.value = doc;
        await nextTick();
        await vi.advanceTimersByTimeAsync(8000);
        await promise;

        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('does not clear OCR cache when workingCopyPath is null', async () => {
        const deps = createMockDeps({ workingCopyPath: ref<string | null>(null) });
        const { handleUndo } = usePdfHistory(deps);

        const undoPromise = handleUndo();
        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        expect(deps.clearOcrCache).not.toHaveBeenCalled();
    });

    it('does not wait for reload when undo is a no-op', async () => {
        const deps = createMockDeps({ undoHistory: vi.fn(async () => false) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('does not wait for reload when redo is a no-op', async () => {
        const deps = createMockDeps({ redoHistory: vi.fn(async () => false) });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(deps.isHistoryBusy.value).toBe(false);
    });
});
