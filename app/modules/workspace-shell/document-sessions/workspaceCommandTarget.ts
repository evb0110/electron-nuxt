import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';

export type TWorkspaceCommandTarget =
    | {
        kind: 'transaction';
        tabId: string;
        sessionId: string;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend;
        documentInstanceId?: TDocumentInstanceId | null;
        transactionId: string;
        documentRevisionToken?: TDocumentRevisionToken;
    }
    | {
        kind: 'revision';
        tabId: string;
        sessionId: string;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend;
        documentInstanceId?: TDocumentInstanceId | null;
        sessionRevision: number;
        documentRevisionToken?: TDocumentRevisionToken;
    };
