export interface IThumbnailRenderGenerationSnapshot {
    runId: number;
    renderRunId: number;
    isDocumentUsable: boolean;
    isPaneActive: boolean;
}

export function isThumbnailRenderGenerationCurrent(snapshot: IThumbnailRenderGenerationSnapshot) {
    return snapshot.runId === snapshot.renderRunId
        && snapshot.isDocumentUsable
        && snapshot.isPaneActive;
}
