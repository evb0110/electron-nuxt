import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildPdfAnnotationSavePlan } from '@app/services/pdf-save/pdfAnnotationSavePlanner';

describe('buildPdfAnnotationSavePlan', () => {
    it('replays embedded annotation operations from source bytes when live PDF.js ids are covered', () => {
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: true,
            hasEditorOnlyAnnotationsPendingMaterialization: false,
            liveAnnotationChanges: {
                ids: new Set(['3856R']),
                replayableEditorNoteIds: new Set(),
                hasChanges: true,
                hasUnknownChanges: false,
            },
            replayableEmbeddedAnnotationIds: new Set(['3856R']),
        });

        expect(plan.route).toBe('source-replay');
        expect(plan.expectedCost).toBe('full-document');
    });

    it('uses PDF.js materialization only for unreplayable live annotation ids', () => {
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: true,
            hasEditorOnlyAnnotationsPendingMaterialization: false,
            liveAnnotationChanges: {
                ids: new Set(['pdfjs_internal_editor_0']),
                replayableEditorNoteIds: new Set(),
                hasChanges: true,
                hasUnknownChanges: false,
            },
            replayableEmbeddedAnnotationIds: new Set(['3856R']),
        });

        expect(plan.route).toBe('pdfjs-materialize');
        expect(plan.expectedCost).toBe('full-document');
        expect(plan.unreplayableLiveAnnotationIds).toEqual(['pdfjs_internal_editor_0']);
    });

    it('keeps clean saves on the source-byte path', () => {
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: false,
            hasEditorOnlyAnnotationsPendingMaterialization: false,
            liveAnnotationChanges: {
                ids: new Set(),
                replayableEditorNoteIds: new Set(),
                hasChanges: false,
                hasUnknownChanges: false,
            },
            replayableEmbeddedAnnotationIds: new Set(),
        });

        expect(plan.route).toBe('source-clean');
        expect(plan.reason).toBe('no-live-pdfjs-annotation-work');
    });

    it('materializes through PDF.js when live annotation storage inspection is unknown', () => {
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: false,
            hasEditorOnlyAnnotationsPendingMaterialization: false,
            liveAnnotationChanges: {
                ids: new Set(),
                replayableEditorNoteIds: new Set(),
                hasChanges: true,
                hasUnknownChanges: true,
            },
            replayableEmbeddedAnnotationIds: new Set(),
        });

        expect(plan.route).toBe('pdfjs-materialize');
        expect(plan.reason).toBe('unknown-live-pdfjs-annotation-storage');
    });

    it('replays pending embedded note operations even when live storage inspection is unknown', () => {
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: true,
            hasEditorOnlyAnnotationsPendingMaterialization: false,
            liveAnnotationChanges: {
                ids: new Set(),
                replayableEditorNoteIds: new Set(),
                hasChanges: true,
                hasUnknownChanges: true,
            },
            replayableEmbeddedAnnotationIds: new Set(['pdfjs_internal_editor_0']),
        });

        expect(plan.route).toBe('source-replay');
        expect(plan.reason).toBe('pending-embedded-annotation-operations-with-unknown-live-storage');
    });
});
