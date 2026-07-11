import type { TDocumentRef } from '@contracts/documentRef';

export type TDocumentOutputOperation =
    | 'djvu-convert'
    | 'djvu-open'
    | 'djvu-print'
    | 'image-export'
    | 'multipage-tiff'
    | 'ocr-projection'
    | 'save-as-pdf';

export type TDocumentOutputSourceKind = 'pdf' | 'djvu';

export interface IDocumentOutputProgress {
    phase: string;
    percent: number;
    current?: number;
    total?: number;
    error?: string;
}

interface IDocumentOutputJobBase {
    jobId: string;
    operation: TDocumentOutputOperation;
    sourceKind: TDocumentOutputSourceKind;
    progress: IDocumentOutputProgress;
    updatedAtMs: number;
}

export type TDocumentOutputJobState =
    | IDocumentOutputJobBase & {status: 'queued' | 'running'}
    | IDocumentOutputJobBase & {
        status: 'handoff';
        artifactPath: TDocumentRef
    }
    | IDocumentOutputJobBase & {
        status: 'completed';
        artifactPath?: TDocumentRef
    }
    | IDocumentOutputJobBase & {
        status: 'canceled' | 'failed';
        error?: string
    };

export interface IDocumentOutputStartOptions {
    operation: TDocumentOutputOperation;
    sourceKind: TDocumentOutputSourceKind;
    jobId?: string;
    initialPhase?: string;
}

export interface IDocumentOutputJobHandle {
    jobId: string;
    signal: AbortSignal;
}

export interface IDocumentOutputService {
    start(options: IDocumentOutputStartOptions): IDocumentOutputJobHandle;
    getState(jobId: string): TDocumentOutputJobState | null;
    subscribe(jobId: string, listener: (state: TDocumentOutputJobState) => void): () => void;
    cancel(jobId: string, reason?: string): boolean;
}
