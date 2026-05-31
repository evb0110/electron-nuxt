export interface IBeginSerializedPdfPersistenceResult {sessionId: string;}

export interface IBeginSerializedPdfSaveAsResult {
    sessionId: string | null;
    path: string | null;
}
