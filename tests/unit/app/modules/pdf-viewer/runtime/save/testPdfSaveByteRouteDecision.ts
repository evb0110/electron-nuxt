import type {IPdfSaveByteRouteDecision} from '@app/modules/pdf-viewer/public';

export const TEST_PDF_SAVE_BYTE_ROUTE_DECISION: IPdfSaveByteRouteDecision = {
    route: 'source-clean',
    annotationPlan: {
        route: 'source-clean',
        expectedCost: 'small',
        reason: 'no-live-pdfjs-annotation-work',
        unreplayableLiveAnnotationIds: [],
    },
    canonical: {
        comments: [],
        pendingTexts: new Map(),
        pendingDeletes: [],
        liveAnnotationChanges: {
            ids: new Set(),
            replayableEditorNoteIds: new Set(),
            hasChanges: false,
            hasUnknownChanges: false,
            fingerprint: '',
        },
        replayableEmbeddedAnnotationIds: new Set(),
    },
    baseBytes: 'loaded-source',
    sourceFallbackAllowed: false,
    nativeRejection: 'backend-not-native-append',
};
