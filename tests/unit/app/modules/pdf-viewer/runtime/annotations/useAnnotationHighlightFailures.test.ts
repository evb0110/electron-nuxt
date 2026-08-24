// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { cast } from '@tests/helpers/cast';
import type { IAnnotationCreationFailureReport } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { useAnnotationHighlight } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight';
import {
    runInTrackedScope,
    stopTrackedScopes,
} from '@tests/helpers/trackedEffectScope';

vi.mock('pdfjs-dist', () => ({AnnotationEditorType: {
    FREETEXT: 3,
    HIGHLIGHT: 9,
}}));

/**
 * The bridge keeps its retry budget private: 12 attempts spaced 80 ms apart.
 * Advancing that whole window is what drives a late editor binding to give up.
 */
const EDITOR_BINDING_RETRY_WINDOW_MS = 12 * 80;

const pagePointRange: {value: Range | null} = {value: null};
vi.mock(
    '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPagePoint',
    () => ({buildRangeFromPagePoint: () => pagePointRange.value}),
);

interface IHighlightHarnessOptions {
    updateModeWithRetry?: (mode: unknown) => Promise<unknown>;
    createdEditor?: unknown;
    getSelectionBoxes?: () => unknown;
    submitSelectionMarkupIntent?: () => unknown;
    /** Runs inside pdf.js editor creation, to swap the document mid-flight. */
    onCreateEditor?: () => void;
}

function createPage(pageNumber: number) {
    const page = document.createElement('div');
    page.className = 'page_container';
    page.dataset.page = String(pageNumber);
    Object.defineProperty(page, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            left: 0,
            top: 0,
            width: 200,
            height: 200,
            right: 200,
            bottom: 200,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }),
    });
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const span = document.createElement('span');
    const text = document.createTextNode(`Page ${pageNumber} text`);
    span.append(text);
    textLayer.append(span);
    page.append(textLayer);
    return {
        page,
        text,
    };
}

function summaryFor(id: string, pageIndex: number): IAnnotationCommentSummary {
    return {
        id,
        stableKey: `src:editor:${pageIndex}:${id}`,
        pageIndex,
        pageNumber: pageIndex + 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'editor',
        hasNote: false,
        markerRect: null,
    };
}

function createHarness(options: IHighlightHarnessOptions = {}) {
    const first = createPage(1);
    const second = createPage(2);
    const viewer = document.createElement('div');
    viewer.append(first.page, second.page);
    document.body.append(viewer);

    const createdEditor = options.createdEditor === undefined
        ? {
            id: 'created-editor',
            div: document.createElement('div'),
            parentPageIndex: 0,
        }
        : options.createdEditor;
    const layerDiv = document.createElement('div');
    // pdf.js only creates a point editor when its layer has a real box, so the
    // harness gives it one; without it the direct-creation path is skipped and
    // the point-note tests silently exercise the fallback instead.
    Object.defineProperty(layerDiv, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            left: 0,
            top: 0,
            width: 200,
            height: 200,
            right: 200,
            bottom: 200,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }),
    });
    const layer = {
        div: layerDiv,
        addCommands: vi.fn(),
        addUndoableEditor: vi.fn(),
        createAndAddNewEditor: vi.fn(() => {
            options.onCreateEditor?.();
            return createdEditor;
        }),
    };
    const uiManager = {
        getActive: vi.fn(() => null),
        getEditors: vi.fn(() => new Set()),
        getLayer: vi.fn(() => layer),
        getMode: vi.fn(() => 0),
        getSelectionBoxes: vi.fn(options.getSelectionBoxes ?? (() => [{
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.03,
        }])),
        waitForEditorsRendered: vi.fn(async () => undefined),
    };
    const failures: IAnnotationCreationFailureReport[] = [];
    const submitStickyNoteIntent = vi.fn(() => ({
        annotationId: 'canonical-note',
        comment: summaryFor('canonical-note', 0),
    }));
    const submitSelectionMarkupIntent = vi.fn(options.submitSelectionMarkupIntent ?? (() => ({
        annotationId: 'canonical-highlight',
        subtype: 'Highlight' as const,
        comment: summaryFor('canonical-highlight', 0),
        replacements: [],
    })));
    const emitAnnotationOpenNote = vi.fn();
    const bindProjectedEditorIdentity = vi.fn();
    const modeCalls: unknown[] = [];
    const annotationUiManager = shallowRef(uiManager as never);

    const highlight = runInTrackedScope(() => useAnnotationHighlight({
        viewerContainer: ref(viewer),
        isActive: ref(true),
        annotationUiManager,
        numPages: ref(2),
        currentPage: ref(1),
        annotationTool: ref('highlight'),
        getIdentity: () => ({getEditorIdentity: editor => String(editor.id)}),
        getMarkupSubtype: () => ({
            toolToMarkupSubtype: {},
            isSelectionMarkupTool: () => true,
            setEditorMarkupSubtypeOverride: () => {},
            resolveEditorMarkupSubtypeOverride: () => null,
            resolveEditorSubtypeFromPresentation: () => null,
        }),
        getSync: () => ({
            scheduleAnnotationCommentsSync: () => {},
            toEditorSummary: (editor, pageIndex) => summaryFor(String(editor.id), pageIndex),
        }),
        getToolManager: () => ({
            updateModeWithRetry: async (_manager, mode) => {
                modeCalls.push(mode);
                return options.updateModeWithRetry
                    ? options.updateModeWithRetry(mode)
                    : null;
            },
            maybeAutoResetAnnotationTool: () => {},
        }),
        textMarkupPresentation: {notify: vi.fn()},
        annotationIntentSink: {
            submitSelectionMarkupIntent: submitSelectionMarkupIntent as never,
            submitStickyNoteIntent: submitStickyNoteIntent as never,
            bindProjectedEditorIdentity,
        },
        reportAnnotationFailure: report => failures.push(report),
        stopDrag: () => {},
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange: () => {},
    }));

    function rangeOnPage(page: 1 | 2) {
        const target = page === 1 ? first.text : second.text;
        const range = document.createRange();
        range.setStart(target, 0);
        range.setEnd(target, target.length);
        return range;
    }

    function crossPageRange() {
        const range = document.createRange();
        range.setStart(first.text, 0);
        range.setEnd(second.text, second.text.length);
        return range;
    }

    return {
        highlight,
        layer,
        uiManager,
        annotationUiManager,
        failures,
        modeCalls,
        emitAnnotationOpenNote,
        bindProjectedEditorIdentity,
        submitStickyNoteIntent,
        submitSelectionMarkupIntent,
        rangeOnPage,
        crossPageRange,
        viewer,
    };
}

function stubSelection(range: Range | null) {
    const selection = {
        addRange: vi.fn(),
        removeAllRanges: vi.fn(),
        rangeCount: range ? 1 : 0,
        isCollapsed: !range,
        anchorNode: range?.startContainer ?? null,
        focusNode: range?.endContainer ?? null,
        getRangeAt: () => {
            if (!range) {
                throw new Error('no range');
            }
            return range;
        },
    };
    vi.spyOn(document, 'getSelection').mockReturnValue(cast<Selection>(selection));
    return selection;
}

beforeEach(() => {
    document.body.innerHTML = '';
    pagePointRange.value = null;
    vi.stubGlobal('PointerEvent', class extends Event {});
});

afterEach(() => {
    stopTrackedScopes();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('useAnnotationHighlight creation outcomes', () => {
    it('reports a failure when the annotation mode switch throws', async () => {
        const harness = createHarness({updateModeWithRetry: async (mode) => {
            if (mode === 9) {
                throw new Error('mode switch exploded');
            }
            return null;
        }});
        const range = harness.rangeOnPage(1);
        stubSelection(range);

        const outcome = await harness.highlight.highlightSelectionInternal(false, range);

        // The canonical intent already ran, so the annotation exists without
        // an editor. That is not success, and it is not "nothing happened".
        expect(outcome).toEqual({
            status: 'pending-editor',
            annotationId: 'canonical-highlight',
            reason: 'mode-switch-failed',
        });
        expect(harness.failures).toEqual([expect.objectContaining({reason: 'mode-switch-failed'})]);
        expect(harness.layer.createAndAddNewEditor).not.toHaveBeenCalled();
    });

    it('reports a failure when the annotation mode retries are exhausted', async () => {
        const harness = createHarness({updateModeWithRetry: async (mode) => (
            mode === 9 ? 'retries exhausted' : null
        )});
        const range = harness.rangeOnPage(1);
        stubSelection(range);

        const outcome = await harness.highlight.highlightSelectionInternal(false, range);

        expect(outcome).toEqual({
            status: 'pending-editor',
            annotationId: 'canonical-highlight',
            reason: 'mode-switch-failed',
        });
        expect(harness.failures).toHaveLength(1);
    });

    it('reports a rejected explicit cross-page range without minting anything', async () => {
        const harness = createHarness({getSelectionBoxes: () => null});
        const range = harness.crossPageRange();
        stubSelection(range);

        const outcome = await harness.highlight.highlightSelectionInternal(false, range);

        expect(outcome).toEqual({
            status: 'failed',
            reason: 'selection-spans-pages',
        });
        expect(harness.submitSelectionMarkupIntent).not.toHaveBeenCalled();
        expect(harness.failures).toEqual([expect.objectContaining({reason: 'selection-spans-pages'})]);
    });

    it('does not report success when no editor is bound to the created annotation', async () => {
        const harness = createHarness({createdEditor: null});
        const range = harness.rangeOnPage(1);
        stubSelection(range);

        const outcome = await harness.highlight.highlightSelectionInternal(false, range);

        expect(outcome).toEqual({
            status: 'pending-editor',
            annotationId: 'canonical-highlight',
            reason: 'editor-unavailable',
        });
    });

    it('reports a failure once the editor binding retries are exhausted', async () => {
        vi.useFakeTimers();
        const harness = createHarness({createdEditor: null});
        const range = harness.rangeOnPage(1);
        stubSelection(range);

        await harness.highlight.highlightSelectionInternal(false, range);
        expect(harness.failures).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(EDITOR_BINDING_RETRY_WINDOW_MS);

        expect(harness.failures).toEqual([expect.objectContaining({reason: 'editor-binding-failed'})]);
    });

    it('cancels a selection markup whose editor manager is replaced mid-flight', async () => {
        const swapManager = {run: () => {}};
        const harness = createHarness({updateModeWithRetry: async (mode) => {
            if (mode === 9) {
                swapManager.run();
                return 'retries exhausted';
            }
            return null;
        }});
        swapManager.run = () => {
            harness.annotationUiManager.value = {
                ...harness.uiManager,
                getEditors: () => new Set(),
            } as never;
        };
        const range = harness.rangeOnPage(1);
        stubSelection(range);

        const outcome = await harness.highlight.highlightSelectionInternal(false, range);

        expect(outcome).toEqual({status: 'cancelled'});
        // The failure belongs to a document that is gone.
        expect(harness.failures).toEqual([]);
    });

    it('cancels instead of binding an editor to a document that was replaced', async () => {
        const swapManager = {run: () => {}};
        const harness = createHarness({onCreateEditor: () => swapManager.run()});
        swapManager.run = () => {
            harness.annotationUiManager.value = {
                ...harness.uiManager,
                getEditors: () => new Set(),
            } as never;
        };
        const range = harness.rangeOnPage(1);
        stubSelection(range);

        const outcome = await harness.highlight.highlightSelectionInternal(false, range);

        // pdf.js handed back an editor, but it belongs to the document that
        // just went away; binding it would publish success for a projection
        // the user will never see.
        expect(outcome).toEqual({status: 'cancelled'});
        expect(harness.bindProjectedEditorIdentity).not.toHaveBeenCalled();
        expect(harness.failures).toEqual([]);
    });

    it('cancels a point note whose document is replaced while its editor is created', async () => {
        const swapManager = {run: () => {}};
        const harness = createHarness({onCreateEditor: () => swapManager.run()});
        swapManager.run = () => {
            harness.annotationUiManager.value = {
                ...harness.uiManager,
                getEditors: () => new Set(),
            } as never;
        };
        stubSelection(null);

        const outcome = await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: false});

        expect(outcome).toEqual({status: 'cancelled'});
        expect(harness.bindProjectedEditorIdentity).not.toHaveBeenCalled();
        expect(harness.emitAnnotationOpenNote).not.toHaveBeenCalled();
        expect(harness.failures).toEqual([]);
    });

    it('projects the real outcome onto the boolean automation surface', async () => {
        // The boolean is only worth anything if both ends of it are real: a
        // half-created annotation must read false, and a bound editor true.
        const failing = createHarness({updateModeWithRetry: async (mode) => (
            mode === 9 ? 'retries exhausted' : null
        )});
        stubSelection(failing.rangeOnPage(1));

        await expect(failing.highlight.highlightSelection()).resolves.toBe(false);

        const succeeding = createHarness();
        stubSelection(succeeding.rangeOnPage(1));

        await expect(succeeding.highlight.highlightSelection()).resolves.toBe(true);
        expect(succeeding.failures).toEqual([]);
    });

    it('reports a rejected cross-page selection with its own reason', async () => {
        const harness = createHarness();
        stubSelection(harness.crossPageRange());

        const applied = await harness.highlight.maybeApplySelectionMarkup();

        expect(applied).toBe(false);
        expect(harness.failures).toEqual([expect.objectContaining({reason: 'selection-spans-pages'})]);
    });

    it('stays silent when a pointer gesture carries no selection', async () => {
        const harness = createHarness();
        stubSelection(null);

        await harness.highlight.maybeApplySelectionMarkup();

        expect(harness.failures).toEqual([]);
    });

    it('reports the typed reason to the agent text markup result', async () => {
        const harness = createHarness({updateModeWithRetry: async (mode) => (
            mode === 9 ? 'retries exhausted' : null
        )});
        stubSelection(null);

        const result = await harness.highlight.createTextMarkupFromText({
            pageNumber: 1,
            text: 'Page 1 text',
        });

        expect(result.created).toBe(false);
        expect(result.failureReason).toBe('mode-switch-failed');
        expect(result.reason).toContain('annotation editing mode');
        // The canonical annotation exists, so an automation caller that
        // retried on `created: false` alone would mint a duplicate.
        expect(result.pendingEditor).toBe(true);
    });

    it('marks a genuine no-op as safe to retry', async () => {
        const harness = createHarness({getSelectionBoxes: () => null});
        stubSelection(null);

        const result = await harness.highlight.createTextMarkupFromText({
            pageNumber: 1,
            text: 'Page 1 text',
        });

        expect(result.created).toBe(false);
        expect(result.failureReason).toBe('selection-not-in-text-layer');
        expect(result.pendingEditor).toBeUndefined();
    });
});

describe('useAnnotationHighlight point comment fallback', () => {
    it('falls back to a sticky note when the text-anchor attempt creates nothing', async () => {
        const harness = createHarness({getSelectionBoxes: () => null});
        pagePointRange.value = harness.rangeOnPage(1);
        stubSelection(null);

        await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: true});

        expect(harness.submitSelectionMarkupIntent).not.toHaveBeenCalled();
        expect(harness.submitStickyNoteIntent).toHaveBeenCalledOnce();
    });

    it('does not add a sticky note when the text-anchor attempt already minted one', async () => {
        const harness = createHarness({updateModeWithRetry: async (mode) => (
            mode === 9 ? 'retries exhausted' : null
        )});
        pagePointRange.value = harness.rangeOnPage(1);
        stubSelection(null);

        const outcome = await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: true});

        expect(harness.submitSelectionMarkupIntent).toHaveBeenCalledOnce();
        expect(harness.submitStickyNoteIntent).not.toHaveBeenCalled();
        expect(outcome.status).toBe('pending-editor');
    });

    it('surfaces the text-anchor reason when no sticky-note fallback follows it', async () => {
        const harness = createHarness({updateModeWithRetry: async (mode) => (
            mode === 9 ? 'retries exhausted' : null
        )});
        pagePointRange.value = harness.rangeOnPage(1);
        stubSelection(null);

        await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: true});

        // The attempt suppressed its own report so a fallback could own the
        // outcome; no fallback ran, so the reason must not be swallowed.
        expect(harness.failures).toEqual([expect.objectContaining({reason: 'mode-switch-failed'})]);
    });

    it('does not report the late binding failure of an attempt whose report was suppressed', async () => {
        vi.useFakeTimers();
        const harness = createHarness({createdEditor: null});
        pagePointRange.value = harness.rangeOnPage(1);
        stubSelection(null);

        const outcome = await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: true});

        // The text-anchor attempt minted the annotation, so no sticky-note
        // fallback runs and `commentAtPoint` hands over the one reason.
        expect(outcome.status).toBe('pending-editor');
        expect(harness.failures).toEqual([expect.objectContaining({reason: 'editor-unavailable'})]);

        await vi.advanceTimersByTimeAsync(EDITOR_BINDING_RETRY_WINDOW_MS);

        // The retry loop kept looking for the editor and gave up, but the
        // caller already spoke for this operation; a second report would
        // toast one gesture twice.
        expect(harness.failures).toEqual([expect.objectContaining({reason: 'editor-unavailable'})]);
    });

    it('still reports the late binding failure of a point note that owns its report', async () => {
        vi.useFakeTimers();
        const harness = createHarness({createdEditor: null});
        stubSelection(null);

        const placement = harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: false});
        // The point path settles for 60 ms before it gives up on a directly
        // created editor, so the placement only resolves once time moves.
        await vi.advanceTimersByTimeAsync(60);
        const outcome = await placement;

        expect(outcome.status).toBe('pending-editor');
        expect(harness.failures).toEqual([]);

        await vi.advanceTimersByTimeAsync(EDITOR_BINDING_RETRY_WINDOW_MS);

        expect(harness.failures).toEqual([expect.objectContaining({reason: 'editor-binding-failed'})]);
    });

    it('drops the pending editor retry when its scope is disposed', async () => {
        vi.useFakeTimers();
        const harness = createHarness({createdEditor: null});
        stubSelection(null);

        const placement = harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: false});
        await vi.advanceTimersByTimeAsync(60);
        await placement;
        harness.uiManager.getEditors.mockClear();

        stopTrackedScopes();
        await vi.advanceTimersByTimeAsync(EDITOR_BINDING_RETRY_WINDOW_MS);

        // Nothing may run after disposal. A surviving retry reaches for the DOM
        // long after the viewer that owned it is gone: in a test run that is an
        // unhandled error against a torn-down environment, and in the app it is
        // work charged to a document the user already closed.
        expect(harness.failures).toEqual([]);
        expect(harness.uiManager.getEditors).not.toHaveBeenCalled();
    });

    it('refuses to schedule an editor retry once its scope is disposed', async () => {
        vi.useFakeTimers();
        const harness = createHarness({createdEditor: null});
        stubSelection(null);

        // Disposal lands first; the placement that follows resolves from an
        // async continuation, which is exactly when a late retry used to be
        // scheduled with nothing left to clear it.
        stopTrackedScopes();
        const placement = harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: false});
        await vi.advanceTimersByTimeAsync(60);
        await placement;
        harness.uiManager.getEditors.mockClear();

        await vi.advanceTimersByTimeAsync(EDITOR_BINDING_RETRY_WINDOW_MS);

        expect(harness.uiManager.getEditors).not.toHaveBeenCalled();
        // The retry never ran, so it also never gave up: a disposed viewer must
        // not toast a binding failure for a document nobody is looking at.
        expect(harness.failures).toEqual([]);
    });

    it('cancels the late point-note binding when the editor manager is replaced', async () => {
        vi.useFakeTimers();
        const swapManager = {run: () => {}};
        const harness = createHarness({
            createdEditor: null,
            updateModeWithRetry: async (mode) => {
                if (mode === 3) {
                    swapManager.run();
                }
                return null;
            },
        });
        swapManager.run = () => {
            harness.annotationUiManager.value = {
                ...harness.uiManager,
                getEditors: () => new Set(),
            } as never;
        };
        stubSelection(null);

        const outcome = await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: false});

        expect(outcome).toEqual({status: 'cancelled'});
        expect(harness.emitAnnotationOpenNote).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(EDITOR_BINDING_RETRY_WINDOW_MS);

        expect(harness.failures).toEqual([]);
    });

    it('skips the sticky-note fallback when the text-anchor attempt created an annotation', async () => {
        const harness = createHarness();
        pagePointRange.value = harness.rangeOnPage(1);
        stubSelection(null);

        const outcome = await harness.highlight.commentAtPoint(1, 0.5, 0.5, {preferTextAnchor: true});

        expect(harness.submitSelectionMarkupIntent).toHaveBeenCalledOnce();
        expect(harness.submitStickyNoteIntent).not.toHaveBeenCalled();
        expect(outcome.status).toBe('created');
    });
});
