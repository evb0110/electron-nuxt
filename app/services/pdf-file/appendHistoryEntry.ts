import type { TPdfHistoryEntry } from '@app/services/pdf-file/pdfHistoryEntryTypes';

interface IAppendHistoryResult {
    history: TPdfHistoryEntry[];
    historyIndex: number;
    historyCleanIndex: number;
}

function getHistoryBytes(entries: readonly TPdfHistoryEntry[]) {
    return entries.reduce(
        (total, entry) => total + (entry.kind === 'bytes' ? entry.snapshot.byteLength : 0),
        0,
    );
}

function trimHistoryByLimits(
    entries: readonly TPdfHistoryEntry[],
    limits: {
        maxEntries: number;
        maxBytes: number;
    },
) {
    const entryTrimmedHistory = entries.slice(-limits.maxEntries);
    let totalBytes = getHistoryBytes(entryTrimmedHistory);
    const byteTrimmedHistory = [...entryTrimmedHistory];

    while (byteTrimmedHistory.length > 1 && totalBytes > limits.maxBytes) {
        const [firstEntry] = byteTrimmedHistory;
        totalBytes -= firstEntry?.kind === 'bytes' ? firstEntry.snapshot.byteLength : 0;
        byteTrimmedHistory.shift();
    }

    return {
        history: byteTrimmedHistory,
        removedFromStart: entries.length - byteTrimmedHistory.length,
    };
}

export function appendHistoryEntry(state: {
    history: readonly TPdfHistoryEntry[];
    historyIndex: number;
    historyCleanIndex: number;
}, entry: TPdfHistoryEntry, limits: {
    maxEntries: number;
    maxBytes: number;
}): IAppendHistoryResult {
    if (state.history.length === 0) {
        return {
            history: [entry],
            historyIndex: 0,
            historyCleanIndex: 0,
        };
    }

    const appendedHistory = [
        ...state.history.slice(0, state.historyIndex + 1),
        entry,
    ];
    const trimmed = trimHistoryByLimits(appendedHistory, limits);
    const cleanIndexBeforeTrim = state.historyCleanIndex > state.historyIndex
        ? -1
        : state.historyCleanIndex;
    const historyCleanIndex = cleanIndexBeforeTrim < 0
        ? -1
        : trimmed.removedFromStart > cleanIndexBeforeTrim
            ? -1
            : cleanIndexBeforeTrim - trimmed.removedFromStart;

    return {
        history: trimmed.history,
        historyIndex: trimmed.history.length - 1,
        historyCleanIndex,
    };
}
