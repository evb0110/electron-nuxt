import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { collectEditedTextMarkupCanvasSuppressionIds } from '@app/modules/pdf-viewer/annotations/editedTextMarkupCanvasSuppression';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? '12R0',
        stableKey: overrides.stableKey ?? 'ann:0:12R',
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'Marked text',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'Underline',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: 'color' in overrides ? (overrides.color ?? null) : '#22c55e',
        colorEdited: overrides.colorEdited,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? '12R0',
        source: overrides.source ?? 'pdf',
        markerRect: 'markerRect' in overrides
            ? (overrides.markerRect ?? null)
            : {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            },
    };
}

describe('collectEditedTextMarkupCanvasSuppressionIds', () => {
    it('combines managed hidden ids with edited materialized text-markup ids', () => {
        const ids = collectEditedTextMarkupCanvasSuppressionIds([
            createComment({
                annotationId: '42R0',
                colorEdited: true,
                subtype: 'Underline',
            }),
            createComment({
                annotationId: '43R0',
                colorEdited: false,
                subtype: 'StrikeOut',
            }),
            createComment({
                annotationId: '44R0',
                colorEdited: true,
                subtype: 'Text',
            }),
            createComment({
                annotationId: '45R',
                colorEdited: true,
                subtype: 'Highlight',
            }),
        ], new Set(['99R0']));

        expect(Array.from(ids).sort()).toEqual([
            '42R',
            '45R',
            '99R',
        ]);
    });

    it('does not suppress edited canvas paint when no replacement visual can be drawn', () => {
        const ids = collectEditedTextMarkupCanvasSuppressionIds([
            createComment({
                annotationId: '42R0',
                colorEdited: true,
                markerRect: null,
            }),
            createComment({
                annotationId: '43R0',
                colorEdited: true,
                color: null,
            }),
        ]);

        expect(Array.from(ids)).toEqual([]);
    });
});
