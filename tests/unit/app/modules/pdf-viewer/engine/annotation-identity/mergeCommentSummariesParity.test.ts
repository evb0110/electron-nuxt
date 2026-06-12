import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { mergeCommentSummaries } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/mergeCommentSummaries';
import { mergeDuplicateCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/mergeDuplicateCommentSummary';

function rect(
    left: number,
    top: number,
    width: number,
    height: number,
): IAnnotationMarkerRect {
    return {
        height,
        left,
        top,
        width,
    };
}

function summary(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        annotationId: overrides.annotationId ?? null,
        annotationName: overrides.annotationName ?? null,
        author: overrides.author ?? null,
        color: overrides.color ?? null,
        colorEdited: overrides.colorEdited,
        createdAt: overrides.createdAt ?? null,
        displayText: overrides.displayText ?? null,
        hasNote: overrides.hasNote ?? true,
        id: overrides.id ?? 'summary-id',
        kindLabel: overrides.kindLabel ?? null,
        markerRect: overrides.markerRect ?? rect(0.1, 0.1, 0.2, 0.05),
        modifiedAt: overrides.modifiedAt ?? null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        previewText: overrides.previewText ?? null,
        sortIndex: overrides.sortIndex ?? null,
        source: overrides.source ?? 'editor',
        stableKey: overrides.stableKey ?? 'src:editor:0:summary-id',
        subtype: overrides.subtype ?? 'FreeText',
        text: overrides.text ?? '',
        uid: overrides.uid ?? null,
    };
}

describe('merge comment summary parity', () => {
    it.each([
        [
            'fills empty text and keeps earliest created/latest modified fields',
            summary({
                author: null,
                createdAt: 20,
                id: 'editor-empty',
                markerRect: rect(0.1, 0.1, 0.1, 0.1),
                modifiedAt: 30,
                sortIndex: 5,
                source: 'editor',
                text: '',
            }),
            summary({
                author: 'Ada',
                createdAt: 10,
                id: 'pdf-text',
                markerRect: rect(0.1, 0.1, 0.3, 0.2),
                modifiedAt: 40,
                sortIndex: 2,
                source: 'pdf',
                text: 'Reloaded note',
            }),
            {
                author: 'Ada',
                createdAt: 10,
                markerRect: rect(0.1, 0.1, 0.1, 0.1),
                modifiedAt: 40,
                sortIndex: 2,
                source: 'editor',
                stableKey: 'src:editor:0:summary-id',
                text: 'Reloaded note',
            },
            {
                author: 'Ada',
                createdAt: 10,
                markerRect: rect(0.1, 0.1, 0.1, 0.1),
                modifiedAt: 40,
                sortIndex: 2,
                source: 'editor',
                stableKey: 'src:editor:0:editor-empty',
                text: 'Reloaded note',
            },
        ],
        [
            'prefers PDF subtype while preserving a locally edited color',
            summary({
                annotationId: '42R0',
                color: '#ec4899',
                colorEdited: true,
                id: 'editor-underline',
                source: 'editor',
                subtype: 'Underline',
            }),
            summary({
                annotationId: '42R0',
                color: '#eab308',
                id: 'pdf-highlight',
                source: 'pdf',
                subtype: 'Highlight',
            }),
            {
                annotationId: '42R0',
                color: '#ec4899',
                colorEdited: true,
                id: 'editor-underline',
                stableKey: 'src:editor:0:summary-id',
                subtype: 'Highlight',
            },
            {
                annotationId: '42R0',
                color: '#ec4899',
                colorEdited: true,
                id: 'editor-underline',
                stableKey: 'ann:0:42R0',
                subtype: 'Highlight',
            },
        ],
        [
            'uses PDF color for an unedited editor text-markup mirror',
            summary({
                annotationId: '43R0',
                color: '#ffd400',
                colorEdited: false,
                id: 'editor-underline',
                source: 'editor',
                subtype: 'Underline',
            }),
            summary({
                annotationId: '43R0',
                color: '#06b6d4',
                id: 'pdf-underline',
                source: 'pdf',
                subtype: 'Underline',
            }),
            {
                color: '#06b6d4',
                colorEdited: false,
                stableKey: 'src:editor:0:summary-id',
                subtype: 'Underline',
            },
            {
                color: '#06b6d4',
                colorEdited: false,
                stableKey: 'ann:0:43R0',
                subtype: 'Underline',
            },
        ],
        [
            'takes an incoming marker rect when the existing rect is absent',
            summary({
                id: 'without-rect',
                markerRect: null,
                source: 'pdf',
            }),
            summary({
                id: 'with-rect',
                markerRect: rect(0.2, 0.3, 0.05, 0.04),
                modifiedAt: 5,
                source: 'editor',
            }),
            {
                id: 'without-rect',
                markerRect: rect(0.2, 0.3, 0.05, 0.04),
                source: 'editor',
                stableKey: 'src:editor:0:summary-id',
            },
            {
                id: 'without-rect',
                markerRect: rect(0.2, 0.3, 0.05, 0.04),
                source: 'editor',
                stableKey: 'src:editor:0:without-rect',
            },
        ],
        [
            'normalizes duplicate stable keys to annotation names',
            summary({
                annotationId: null,
                annotationName: null,
                id: 'runtime-note',
                source: 'editor',
                stableKey: 'src:editor:0:runtime-note',
            }),
            summary({
                annotationId: '44R0',
                annotationName: 'evb-markup:stable',
                id: 'pdf-note',
                source: 'pdf',
                stableKey: 'ann:0:44R0',
            }),
            {
                annotationId: '44R0',
                annotationName: 'evb-markup:stable',
                id: 'runtime-note',
                stableKey: 'src:editor:0:runtime-note',
            },
            {
                annotationId: '44R0',
                annotationName: 'evb-markup:stable',
                id: 'pdf-note',
                stableKey: 'nm:evb-markup:stable',
            },
        ],
    ] as const)('%s', (_name, existing, incoming, expectedMerged, expectedDuplicate) => {
        expect(mergeCommentSummaries(existing, incoming)).toMatchObject(expectedMerged);
        expect(mergeDuplicateCommentSummary(existing, incoming)).toMatchObject(expectedDuplicate);
    });
});
