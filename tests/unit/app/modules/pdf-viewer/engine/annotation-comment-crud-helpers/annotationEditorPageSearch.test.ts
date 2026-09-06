import { requirePageIndex } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { findEditorByAnnotationElementId } from '@app/modules/pdf-viewer/engine/annotation-comment-crud-helpers/findEditorByAnnotationElementId';
import { findEditorForComment } from '@app/modules/pdf-viewer/engine/annotation-comment-crud-helpers/findEditorForComment';

const PAGE_COUNT = 1_000_000;

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'missing-comment',
        stableKey: 'ann:500000:missing-comment',
        sortIndex: null,
        pageIndex: 500_000,
        pageNumber: 500_001,
        text: 'note',
        kindLabel: null,
        subtype: null,
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'last-annotation',
        source: 'pdf',
        hasNote: true,
        markerRect: null,
        ...overrides,
    };
}

function createSparseUiManager(editors: readonly IPdfjsEditor[]) {
    const visitedPages: number[] = [];
    const getEditors = vi.fn((pageIndex: number) => {
        visitedPages.push(pageIndex);
        return editors.filter(editor => editor.parentPageIndex === pageIndex);
    });
    const getEditor = vi.fn<(id: string) => IPdfjsEditor | null>(() => null);
    return {
        // The search helper only calls these two PDF.js manager methods.
        manager: Object.assign(Object.create(null), {
            getEditor,
            getEditors,
        }),
        getEditor,
        getEditors,
        visitedPages,
    };
}

describe('annotation editor page search', () => {
    it('finds an annotation on the last sparse page without a million-page scan', () => {
        const firstEditor = {
            id: 'first-editor',
            uid: 'first-editor',
            annotationElementId: 'first-annotation',
            parentPageIndex: 0,
        } as IPdfjsEditor;
        const lastEditor = {
            id: 'last-editor',
            uid: 'last-editor',
            annotationElementId: 'last-annotation',
            parentPageIndex: PAGE_COUNT - 1,
        } as IPdfjsEditor;
        const harness = createSparseUiManager([
            firstEditor,
            lastEditor,
        ]);

        const result = findEditorForComment(
            harness.manager,
            PAGE_COUNT,
            createComment(),
            editor => editor.id ?? '',
            {
                annotationPageIndexes: [
                    requirePageIndex(0),
                    requirePageIndex(PAGE_COUNT - 1),
                ],
                mountedPageIndexes: [
                    requirePageIndex(0),
                    requirePageIndex(PAGE_COUNT - 1),
                ],
            },
        );

        expect(result).toBe(lastEditor);
        expect(harness.visitedPages).toContain(0);
        expect(harness.visitedPages).toContain(PAGE_COUNT - 1);
        expect(harness.visitedPages.length).toBeLessThan(40);
        expect(harness.visitedPages).not.toContain(1);
        expect(harness.visitedPages).not.toContain(PAGE_COUNT - 2);
    });

    it('checks the global editor map before any page fallback', () => {
        const editor = {
            id: 'global-editor',
            uid: 'global-editor',
            annotationElementId: 'global-annotation',
            parentPageIndex: PAGE_COUNT - 1,
        } as IPdfjsEditor;
        const harness = createSparseUiManager([editor]);
        harness.getEditor.mockImplementation((id: string) => id === 'global-editor' ? editor : null);

        const result = findEditorForComment(
            harness.manager,
            PAGE_COUNT,
            createComment({
                id: 'global-editor',
                annotationId: null,
                pageIndex: 500_000,
            }),
            candidate => candidate.id ?? '',
        );

        expect(result).toBe(editor);
        expect(harness.getEditors).not.toHaveBeenCalled();
    });

    it('bounds annotation-element fallback when the sparse page is absent', () => {
        const harness = createSparseUiManager([]);

        expect(findEditorByAnnotationElementId(
            harness.manager,
            PAGE_COUNT,
            requirePageIndex(500_000),
            'missing-annotation',
            {
                annotationPageIndexes: [
                    requirePageIndex(0),
                    requirePageIndex(PAGE_COUNT - 1),
                ],
                mountedPageIndexes: [
                    requirePageIndex(0),
                    requirePageIndex(PAGE_COUNT - 1),
                ],
            },
        )).toBeNull();
        expect(harness.visitedPages.length).toBeLessThan(40);
        expect(harness.visitedPages).toContain(0);
        expect(harness.visitedPages).toContain(PAGE_COUNT - 1);
    });
});
