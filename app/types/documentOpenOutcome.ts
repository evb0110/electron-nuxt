import type { TOpenFileResult } from '@contracts/electronApiDocuments';

export type TDocumentOpenOutcome =
    | {
        status: 'opened';
        result: TOpenFileResult;
    }
    | { status: 'cancelled' }
    | {
        status: 'failed';
        error: string;
    }
    | {
        status: 'stale';
        result: TOpenFileResult;
    };

export function didOpenDocument(outcome: TDocumentOpenOutcome) {
    return outcome.status === 'opened';
}
