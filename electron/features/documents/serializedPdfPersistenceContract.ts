export const SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION = 1;

export interface ISerializedPdfPersistenceLimits {
    protocolVersion: typeof SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION;
    maxChunkBytes: number;
    maxInFlightChunks: number;
    maxTotalBytes: number;
    ackTimeoutMs: number;
    resultTimeoutMs: number;
}

export type TPdfPersistenceErrorCode =
    | 'CANCELED'
    | 'PROTOCOL_ERROR'
    | 'ACK_TIMEOUT'
    | 'COMMIT_FAILED'
    | 'WORKING_COPY_SYNC_WARNING'
    | 'UNKNOWN';

export type TPdfPersistenceErrorPhase =
    | 'streaming'
    | 'ack'
    | 'complete'
    | 'commit'
    | 'cancel';

export interface IPdfPersistenceErrorFrame {
    type: 'error';
    code: TPdfPersistenceErrorCode;
    phase: TPdfPersistenceErrorPhase;
    retryable: boolean;
    expected: boolean;
    error: string;
    seq?: number;
}

export interface IBeginSerializedPdfPersistenceResult extends ISerializedPdfPersistenceLimits {sessionId: string;}

export interface IBeginSerializedPdfSaveAsResult extends Partial<ISerializedPdfPersistenceLimits> {
    sessionId: string | null;
    path: string | null;
}
