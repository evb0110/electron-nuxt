import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useAnnotationHighlight } from '@app/composables/pdf/annotations/useAnnotationHighlight';

vi.mock('pdfjs-dist', () => ({AnnotationEditorType: {FREETEXT: 3}}));

interface IRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface IFakePageElement {
    dataset: { page?: string };
    getBoundingClientRect: () => {
        left: number;
        top: number;
        width: number;
        height: number;
        right: number;
        bottom: number;
        x: number;
        y: number;
        toJSON: () => object;
    };
}

interface IFakeViewerContainer {
    querySelectorAll: (selector: string) => IFakePageElement[];
    contains: (target: IFakePageElement | null) => boolean;
}

interface IFakeTargetElement {closest: (selector: string) => IFakePageElement | null;}

function asElement(value: object): HTMLElement {
    return value as HTMLElement;
}

function createFakePageContainer(page: number, rect: IRect): IFakePageElement {
    return {
        dataset: { page: String(page) },
        getBoundingClientRect: () => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            x: rect.left,
            y: rect.top,
            toJSON: () => ({}),
        }),
    };
}

function createFakeViewerContainer(pages: IFakePageElement[]): IFakeViewerContainer {
    return {
        querySelectorAll: (selector: string) => selector === '.page_container' ? pages : [],
        contains: (target: IFakePageElement | null) => Boolean(
            target && pages.some(page => page === target || page.dataset.page === target.dataset.page),
        ),
    };
}

function createHighlightHarness(viewerContainer: IFakeViewerContainer) {
    return useAnnotationHighlight({
        viewerContainer: ref(asElement(viewerContainer)),
        annotationUiManager: shallowRef(null),
        numPages: ref(2),
        currentPage: ref(1),
        annotationTool: ref('none'),
        getIdentity: () => ({
            getEditorIdentity: () => 'editor-id',
            getEditorPendingKey: () => 'pending-editor-id',
        }),
        getMarkupSubtype: () => ({
            TOOL_TO_MARKUP_SUBTYPE: {},
            isSelectionMarkupTool: () => false,
            setEditorMarkupSubtypeOverride: () => {},
            resolveEditorMarkupSubtypeOverride: () => null,
            resolveEditorSubtypeFromPresentation: () => null,
            syncMarkupSubtypePresentationForEditors: () => {},
        }),
        getSync: () => ({
            pendingCommentEditorKeys: new Set<string>(),
            toEditorSummary: () => {
                throw new Error('not used in resolvePagePointTarget tests');
            },
        }),
        getToolManager: () => ({
            updateModeWithRetry: async () => null,
            maybeAutoResetAnnotationTool: () => {},
        }),
        stopDrag: () => {},
        emitAnnotationOpenNote: () => {},
        emitAnnotationNotePlacementChange: () => {},
    });
}

function createTarget(page: IFakePageElement | null): IFakeTargetElement {
    return {closest: (selector: string) => selector === '.page_container' ? page : null};
}

describe('useAnnotationHighlight resolvePagePointTarget', () => {
    it('prefers geometry fallback when target page conflicts with pointer coordinates', () => {
        const page1 = createFakePageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const page2 = createFakePageContainer(2, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createFakeViewerContainer([
            page1,
            page2,
        ]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(
            100,
            450,
            asElement(createTarget(page1)),
        );

        expect(resolved?.pageNumber).toBe(2);
        expect(resolved?.pageContainer).toBe(page2);
    });

    it('falls back to coordinate-based page resolution when target is unavailable', () => {
        const page1 = createFakePageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const page2 = createFakePageContainer(2, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createFakeViewerContainer([
            page1,
            page2,
        ]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(100, 450);

        expect(resolved?.pageNumber).toBe(2);
        expect(resolved?.pageContainer).toBe(page2);
    });

    it('ignores target elements from outside the active viewer container', () => {
        const page1 = createFakePageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const externalPage = createFakePageContainer(99, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createFakeViewerContainer([page1]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(
            100,
            100,
            asElement(createTarget(externalPage)),
        );

        expect(resolved?.pageNumber).toBe(1);
        expect(resolved?.pageContainer).toBe(page1);
    });
});
