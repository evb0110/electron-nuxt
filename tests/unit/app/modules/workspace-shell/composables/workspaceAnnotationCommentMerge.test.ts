import {
    describe,
    expect,
    it,
} from 'vitest';
import { mergeWorkspaceAnnotationComments } from '@app/modules/workspace-shell/composables/workspaceAnnotationCommentMerge';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'comment-1',
        stableKey: 'src:editor:0:comment-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        kindLabel: 'Inline Note',
        subtype: 'FreeText',
        author: 'Eugene',
        createdAt: 100,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'editor',
        hasNote: true,
        markerRect: {
            left: 0.4,
            top: 0.3,
            width: 0.02,
            height: 0.02,
        },
        ...overrides,
    };
}

describe('mergeWorkspaceAnnotationComments', () => {
    it('keeps a fresh open editor note when a stale sync omits it', () => {
        const note = createComment();

        const merged = mergeWorkspaceAnnotationComments({
            incomingComments: [],
            previousComments: [note],
            openNotes: [{ comment: note }],
        });

        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual(expect.objectContaining({
            stableKey: note.stableKey,
            text: note.text,
            createdAt: note.createdAt,
            hasNote: true,
        }));
    });

    it('uses the open note text while the debounced annotation sync catches up', () => {
        const note = createComment();

        const merged = mergeWorkspaceAnnotationComments({
            incomingComments: [],
            previousComments: [note],
            openNotes: [ {
                comment: note,
                text: 'typed locally',
            } ],
        });

        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual(expect.objectContaining({
            stableKey: note.stableKey,
            text: 'typed locally',
            createdAt: 100,
            hasNote: true,
        }));
    });

    it('merges a carried transient note with its synchronized replacement instead of duplicating it', () => {
        const transientNote = createComment({
            stableKey: 'src:editor:0:comment-1',
            annotationId: null,
        });
        const synchronizedNote = createComment({
            stableKey: 'ann:0:12R',
            annotationId: '12R',
            createdAt: null,
        });

        const merged = mergeWorkspaceAnnotationComments({
            incomingComments: [synchronizedNote],
            previousComments: [transientNote],
            openNotes: [],
        });

        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual(expect.objectContaining({
            stableKey: 'ann:0:12R',
            annotationId: '12R',
            createdAt: transientNote.createdAt,
            hasNote: true,
        }));
    });

    it('sorts carried notes by creation time so text edits do not reorder the sidebar', () => {
        const olderNote = createComment({
            id: 'note',
            stableKey: 'src:editor:0:note',
            createdAt: 100,
        });
        const newerHighlight = createComment({
            id: 'highlight',
            stableKey: 'ann:0:20R',
            createdAt: 200,
            kindLabel: 'Highlight',
            subtype: 'Highlight',
            source: 'pdf',
            annotationId: '20R',
            hasNote: false,
            text: 'Highlighted text',
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.1,
                height: 0.02,
            },
        });

        const merged = mergeWorkspaceAnnotationComments({
            incomingComments: [newerHighlight],
            previousComments: [olderNote],
            openNotes: [ {
                comment: olderNote,
                text: 'typed later',
            } ],
        });

        expect(merged.map(comment => comment.stableKey)).toEqual([
            olderNote.stableKey,
            newerHighlight.stableKey,
        ]);
    });
});
