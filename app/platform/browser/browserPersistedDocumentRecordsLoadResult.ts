import type { IBrowserPersistedDocumentRecord } from '@app/platform/browser/browserDocumentTypes';

export interface IBrowserPersistedDocumentRecordsLoadResult {
    available: boolean;
    records: IBrowserPersistedDocumentRecord[];
}
