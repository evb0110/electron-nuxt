import {readFile} from 'node:fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';

export type TDocumentRecoveryJournalErrorCode =
    | 'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE'
    | 'DOCUMENT_RECOVERY_JOURNAL_INVALID';

export class DocumentRecoveryJournalError extends Error {
    public readonly code: TDocumentRecoveryJournalErrorCode;
    public readonly journalPath: string;
    public override readonly cause: unknown;

    public constructor(
        code: TDocumentRecoveryJournalErrorCode,
        journalPath: string,
        cause?: unknown,
        message?: string,
    ) {
        super(
            message ?? (code === 'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE'
                ? `Recovery journal could not be read: ${journalPath}`
                : `Recovery journal is invalid: ${journalPath}`),
        );
        this.name = 'DocumentRecoveryJournalError';
        this.code = code;
        this.journalPath = journalPath;
        this.cause = cause;
    }
}

export function invalidDocumentRecoveryJournal(
    journalPath: string,
    cause?: unknown,
    message?: string,
) {
    return new DocumentRecoveryJournalError(
        'DOCUMENT_RECOVERY_JOURNAL_INVALID',
        journalPath,
        cause,
        message,
    );
}

export async function readDocumentRecoveryJournal(journalPath: string): Promise<unknown | undefined> {
    let raw: string;
    try {
        raw = await readFile(journalPath, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return undefined;
        }
        throw new DocumentRecoveryJournalError(
            'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE',
            journalPath,
            error,
        );
    }

    try {
        return JSON.parse(raw) as unknown;
    } catch (error) {
        throw invalidDocumentRecoveryJournal(journalPath, error);
    }
}
