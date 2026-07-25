// @vitest-environment happy-dom

import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';
import { useTextMarkupPresentationController } from '@app/modules/pdf-viewer/runtime/annotations/useTextMarkupPresentationController';
import { setTestElementRect } from '@tests/helpers/domGeometryTestHarness';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const PAGE_RECT = {
    left: 0,
    top: 0,
    width: 1000,
    height: 1000,
};

interface ITestPage {
    markup: SVGElement;
    page: HTMLElement;
}

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    const pageNumber = overrides.pageNumber ?? 1;
    return {
        id: `${String(pageNumber)}2R0`,
        stableKey: `ann:${pageNumber - 1}:12R`,
        sortIndex: null,
        pageIndex: pageNumber - 1,
        pageNumber,
        text: '',
        kindLabel: null,
        subtype: 'Highlight',
        author: null,
        modifiedAt: null,
        color: '#ec4899',
        colorEdited: true,
        uid: null,
        annotationId: `${String(pageNumber)}2R0`,
        source: 'pdf',
        hasNote: false,
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        },
        ...overrides,
    };
}

function createViewerWithPages(pageNumbers: readonly number[]) {
    const viewer = setTestElementRect(document.createElement('div'), PAGE_RECT) as HTMLElement;
    const pages = new Map<number, ITestPage>();
    for (const pageNumber of pageNumbers) {
        const page = setTestElementRect(document.createElement('div'), PAGE_RECT) as HTMLElement;
        page.classList.add('page_container');
        page.dataset.page = String(pageNumber);
        const host = document.createElement('div');
        host.classList.add('page_canvas', 'canvasWrapper');
        const markup = setTestElementRect(document.createElementNS(SVG_NAMESPACE, 'svg'), {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        markup.setAttribute('class', 'highlight');
        markup.setAttribute('fill', '#ffd400');
        host.append(markup);
        page.append(host);
        viewer.append(page);
        pages.set(pageNumber, {
            markup,
            page,
        });
    }
    document.body.append(viewer);
    return {
        pages,
        viewer,
    };
}

// Highlight markup paints the opaque display colour derived from the settings
// opacity, so the expectation is derived the same way rather than hard-coded.
function expectedHighlightFill(color: string) {
    return toOpaqueHighlightDisplayColor(color, DEFAULT_ANNOTATION_SETTINGS.highlightOpacity);
}

function markupFill(pages: Map<number, ITestPage>, pageNumber: number) {
    return pages.get(pageNumber)?.markup.getAttribute('fill') ?? null;
}

function createController(options: {
    comments: IAnnotationCommentSummary[];
    editor?: IPdfjsEditor;
    includeEditor?: () => boolean;
    unresolvedPages?: () => readonly number[];
    viewer: HTMLElement | null;
}) {
    const annotationCommentsCache = ref<IAnnotationCommentSummary[]>(options.comments);
    const effectiveScale = ref(1);
    const activeState = ref(true);
    const viewerContainer = ref<HTMLElement | null>(options.viewer);
    const presentedScales: number[] = [];
    const clearEditorPresentation = vi.fn();
    const syncEditorPresentation = vi.fn(
        (_pageNumbers?: readonly number[]) => {
            presentedScales.push(effectiveScale.value);
            return {
                editors: options.editor && (options.includeEditor?.() ?? true)
                    ? [{
                        color: null,
                        editor: options.editor,
                        pageNumber: 1,
                        subtype: null,
                    }]
                    : [],
                unresolvedPageNumbers: options.unresolvedPages?.() ?? [],
            };
        },
    );
    const scope = effectScope();
    const controller = scope.run(() => useTextMarkupPresentationController({
        annotationCommentsCache,
        annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        clearEditorPresentation,
        effectiveScale,
        isActive: computed(() => activeState.value),
        presentEditor: vi.fn(() => true),
        readEditorPresentation: syncEditorPresentation,
        resetEditorPresentation: vi.fn(),
        viewerContainer,
    }));
    if (!controller) {
        throw new Error('Expected the presentation controller to be created');
    }
    return {
        activeState,
        annotationCommentsCache,
        clearEditorPresentation,
        controller,
        effectiveScale,
        presentedScales,
        scope,
        syncEditorPresentation,
        viewerContainer,
    };
}

async function settleFrame() {
    await nextTick();
    await vi.advanceTimersByTimeAsync(20);
}

beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('useTextMarkupPresentationController', () => {
    it('applies markup presentation once for signals that arrive within one frame', async () => {
        const {
            pages,
            viewer,
        } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 1,
        });
        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 1,
        });
        harness.controller.notify({kind: 'editors-changed'});
        await settleFrame();

        expect(markupFill(pages, 1)).toBe(expectedHighlightFill('#ec4899'));
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);
        harness.scope.stop();
    });

    it('scopes a committed page layer to that page only', async () => {
        const {
            pages,
            viewer,
        } = createViewerWithPages([
            1,
            2,
        ]);
        const harness = createController({
            comments: [
                createComment(),
                createComment({pageNumber: 2}),
            ],
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 2,
        });
        await settleFrame();

        expect(markupFill(pages, 2)).toBe(expectedHighlightFill('#ec4899'));
        expect(markupFill(pages, 1)).toBe('#ffd400');
        expect(harness.syncEditorPresentation).toHaveBeenCalledWith([2]);
        harness.scope.stop();
    });

    it('escalates an unresolved page until it presents, then stops retrying', async () => {
        const { viewer } = createViewerWithPages([1]);
        let unresolvedRounds = 2;
        const harness = createController({
            comments: [createComment()],
            unresolvedPages: () => {
                if (unresolvedRounds <= 0) {
                    return [];
                }
                unresolvedRounds -= 1;
                return [1];
            },
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 1,
        });
        await settleFrame();
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60);
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(120);
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(5000);
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(3);
        harness.scope.stop();
    });

    it('treats a delayed editor root as unresolved and presents it on the bounded retry', async () => {
        const { viewer } = createViewerWithPages([1]);
        let editorRootReady = false;
        const editor = {div: document.createElement('div')} as IPdfjsEditor;
        const harness = createController({
            comments: [],
            editor,
            includeEditor: () => editorRootReady,
            unresolvedPages: () => editorRootReady ? [] : [1],
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 1,
        });
        await settleFrame();
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);

        editorRootReady = true;
        await vi.advanceTimersByTimeAsync(60);
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10000);
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(2);
        harness.scope.stop();
    });

    it('bounds a permanently unresolved page to a single escalation ladder', async () => {
        const { viewer } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            unresolvedPages: () => [1],
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 1,
        });
        await settleFrame();
        await vi.advanceTimersByTimeAsync(10000);

        // One immediate pass plus the five bounded escalation steps.
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(6);
        harness.scope.stop();
    });

    it('drops armed repairs when the document is invalidated', async () => {
        const { viewer } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            unresolvedPages: () => [1],
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 1,
        });
        await settleFrame();
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);

        harness.controller.notify({kind: 'document-invalidated'});
        await vi.advanceTimersByTimeAsync(10000);

        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);
        harness.scope.stop();
    });

    it('re-presents and reopens the escalation budget when the viewer is activated', async () => {
        const {
            pages,
            viewer,
        } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            viewer,
        });

        harness.activeState.value = false;
        await settleFrame();
        pages.get(1)?.markup.setAttribute('fill', '#ffd400');
        harness.syncEditorPresentation.mockClear();

        harness.activeState.value = true;
        await settleFrame();

        expect(markupFill(pages, 1)).toBe(expectedHighlightFill('#ec4899'));
        expect(harness.syncEditorPresentation).toHaveBeenCalledWith(undefined);
        harness.scope.stop();
    });

    it('re-presents when the viewer container is remounted', async () => {
        const first = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            viewer: first.viewer,
        });
        await settleFrame();

        document.body.replaceChildren();
        const remounted = createViewerWithPages([1]);
        harness.viewerContainer.value = remounted.viewer;
        await settleFrame();

        expect(markupFill(remounted.pages, 1)).toBe(expectedHighlightFill('#ec4899'));
        harness.scope.stop();
    });

    it('leaves no stale markup color after rapid zoom changes', async () => {
        const {
            pages,
            viewer,
        } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            viewer,
        });

        for (let step = 0; step < 20; step += 1) {
            harness.effectiveScale.value = 1 + step * 0.25;
        }
        await settleFrame();
        expect(markupFill(pages, 1)).toBe(expectedHighlightFill('#ec4899'));
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);

        harness.annotationCommentsCache.value = [createComment({color: '#22c55e'})];
        for (let step = 0; step < 20; step += 1) {
            harness.effectiveScale.value = 6 - step * 0.25;
        }
        await settleFrame();

        expect(harness.effectiveScale.value).toBe(1.25);
        expect(harness.presentedScales.at(-1)).toBe(1.25);
        expect(markupFill(pages, 1)).toBe(expectedHighlightFill('#22c55e'));
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(2);
        harness.scope.stop();
    });

    it('coalesces a color mutation into the next presentation frame', async () => {
        const {
            pages,
            viewer,
        } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            viewer,
        });

        harness.controller.notify({
            kind: 'comment-color-mutated',
            color: '#22c55e',
            comment: createComment({color: '#22c55e'}),
            sourceColor: '#ec4899',
        });

        expect(markupFill(pages, 1)).toBe('#ffd400');
        await settleFrame();
        expect(markupFill(pages, 1)).toBe(expectedHighlightFill('#22c55e'));
        harness.scope.stop();
    });

    it('cancels queued frames, repairs, and mutations while inactive', async () => {
        const {
            pages,
            viewer,
        } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            unresolvedPages: () => [1],
            viewer,
        });

        harness.controller.notify({kind: 'editors-changed'});
        harness.controller.notify({
            kind: 'comment-color-mutated',
            color: '#22c55e',
            comment: createComment({color: '#22c55e'}),
            sourceColor: '#ec4899',
        });
        harness.activeState.value = false;
        await settleFrame();
        await vi.advanceTimersByTimeAsync(10000);

        expect(markupFill(pages, 1)).toBe('#ffd400');
        expect(harness.syncEditorPresentation).not.toHaveBeenCalled();
        harness.controller.notify({kind: 'editors-changed'});
        await vi.advanceTimersByTimeAsync(10000);
        expect(harness.syncEditorPresentation).not.toHaveBeenCalled();
        harness.scope.stop();
    });

    it('clears a deleted editor presentation while inactive without scheduling paint', async () => {
        const { viewer } = createViewerWithPages([1]);
        const harness = createController({
            comments: [],
            viewer,
        });
        const editor = {div: document.createElement('div')} as IPdfjsEditor;
        harness.activeState.value = false;
        await nextTick();

        harness.controller.notify({
            editor,
            kind: 'editor-presentation-cleared',
        });

        expect(harness.clearEditorPresentation).toHaveBeenCalledOnce();
        expect(harness.clearEditorPresentation).toHaveBeenCalledWith(editor);
        expect(harness.syncEditorPresentation).not.toHaveBeenCalled();
        harness.scope.stop();
    });

    it('does not spend or overwrite the retry budget on repeated triggers', async () => {
        const { viewer } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment()],
            unresolvedPages: () => [1],
            viewer,
        });

        harness.controller.notify({kind: 'editors-changed'});
        await settleFrame();
        for (let trigger = 0; trigger < 20; trigger += 1) {
            harness.controller.notify({kind: 'editors-changed'});
        }
        await settleFrame();
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10000);
        // Twenty extra triggers share the original first timer; only its five
        // firings advance the bounded budget.
        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(7);
        harness.scope.stop();
    });

    it('does not escalate for comments whose page is not mounted', async () => {
        const { viewer } = createViewerWithPages([1]);
        const harness = createController({
            comments: [createComment({pageNumber: 7})],
            viewer,
        });

        harness.controller.notify({
            kind: 'page-layer-committed',
            pageNumber: 7,
        });
        await settleFrame();
        await vi.advanceTimersByTimeAsync(10000);

        expect(harness.syncEditorPresentation).toHaveBeenCalledTimes(1);
        harness.scope.stop();
    });
});
