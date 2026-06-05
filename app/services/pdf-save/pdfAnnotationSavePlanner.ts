import type { IPdfLiveAnnotationChangeSummary } from '@app/services/pdf-save/pdfAnnotationStorageChanges';

export type TPdfAnnotationSaveRoute =
    | 'source-clean'
    | 'source-replay'
    | 'pdfjs-materialize';

export type TPdfAnnotationSaveExpectedCost =
    | 'small'
    | 'full-document';

export interface IPdfAnnotationSavePlanInput {
    hasPendingReplayableEmbeddedChanges: boolean;
    hasEditorOnlyAnnotationsPendingMaterialization: boolean;
    liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
    replayableEmbeddedAnnotationIds: ReadonlySet<string>;
}

export function buildPdfAnnotationSavePlan(
    input: IPdfAnnotationSavePlanInput,
) {
    if (
        input.hasPendingReplayableEmbeddedChanges
        && !input.hasEditorOnlyAnnotationsPendingMaterialization
    ) {
        // FreeText sticky notes are replayed by our serializer. Large scanned PDFs can
        // make PDF.js saveDocument stall, so keep replayable-only note saves off that path.
        if (input.liveAnnotationChanges.hasUnknownChanges) {
            return {
                route: 'source-replay',
                expectedCost: 'full-document',
                reason: 'pending-embedded-annotation-operations-with-unknown-live-storage',
                unreplayableLiveAnnotationIds: [],
            };
        }

        if (!input.liveAnnotationChanges.hasChanges) {
            return {
                route: 'source-replay',
                expectedCost: 'full-document',
                reason: 'pending-embedded-annotation-operations',
                unreplayableLiveAnnotationIds: [],
            };
        }

        const unreplayableLiveAnnotationIds = Array.from(input.liveAnnotationChanges.ids)
            .filter(id => !input.replayableEmbeddedAnnotationIds.has(id));
        if (unreplayableLiveAnnotationIds.length === 0 && input.liveAnnotationChanges.ids.size > 0) {
            return {
                route: 'source-replay',
                expectedCost: 'full-document',
                reason: 'live-pdfjs-ids-covered-by-embedded-operations',
                unreplayableLiveAnnotationIds,
            };
        }

        if (unreplayableLiveAnnotationIds.length > 0) {
            return {
                route: 'pdfjs-materialize',
                expectedCost: 'full-document',
                reason: 'unreplayable-live-pdfjs-annotation-ids',
                unreplayableLiveAnnotationIds,
            };
        }
    }

    if (input.liveAnnotationChanges.hasUnknownChanges) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: 'unknown-live-pdfjs-annotation-storage',
            unreplayableLiveAnnotationIds: [],
        };
    }

    if (input.liveAnnotationChanges.hasChanges) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: 'live-pdfjs-annotation-storage',
            unreplayableLiveAnnotationIds: Array.from(input.liveAnnotationChanges.ids),
        };
    }

    if (input.hasEditorOnlyAnnotationsPendingMaterialization) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: 'editor-only-annotations-pending-materialization',
            unreplayableLiveAnnotationIds: [],
        };
    }

    return {
        route: 'source-clean',
        expectedCost: 'small',
        reason: 'no-live-pdfjs-annotation-work',
        unreplayableLiveAnnotationIds: [],
    };
}
