import { createBrowserDocumentRevisionInfo } from '@app/platform/browser/browserDocumentRevision';
import type { IBrowserDocumentEntry } from '@app/platform/browser/browserDocumentTypes';
import type {
    IDocumentRevisionChangedEvent,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';

export function emitBrowserDocumentRevisionChange(options: {
    entries: ReadonlyMap<string, IBrowserDocumentEntry>;
    listeners: ReadonlySet<(event: IDocumentRevisionChangedEvent) => void>;
    entry: IBrowserDocumentEntry;
    previousToken: TDocumentRevisionToken | undefined;
    reason: TDocumentRevisionChangeReason;
}) {
    const emit = (event: IDocumentRevisionChangedEvent) => {
        for (const listener of options.listeners) {
            listener(event);
        }
    };
    emit({
        ...createBrowserDocumentRevisionInfo(options.entry),
        ...(options.previousToken ? { previousToken: options.previousToken } : {}),
        reason: options.reason,
    });
    for (const dependentEntry of options.entries.values()) {
        if (
            dependentEntry.ref !== options.entry.ref
            && dependentEntry.storageMode === 'source-proxy'
            && dependentEntry.sourceRef === options.entry.ref
        ) {
            emit({
                ...createBrowserDocumentRevisionInfo(options.entry, dependentEntry.ref),
                ...(options.previousToken ? { previousToken: options.previousToken } : {}),
                reason: options.reason,
            });
        }
    }
}
