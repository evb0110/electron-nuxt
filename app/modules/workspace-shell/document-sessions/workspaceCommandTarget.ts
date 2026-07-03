import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';

export type TWorkspaceCommandTarget =
    | {
        kind: 'transaction';
        tabId: string;
        sessionId: string;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend;
        transactionId: string;
        documentRevisionToken?: TDocumentRevisionToken;
    }
    | {
        kind: 'revision';
        tabId: string;
        sessionId: string;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend;
        sessionRevision: number;
        documentRevisionToken?: TDocumentRevisionToken;
    };
