import type { TPdfHistoryEntry } from '@app/services/pdf-file/pdfHistoryEntryTypes';

interface IAppendHistoryResult {
    history: TPdfHistoryEntry[];
    historyIndex: number;
    historyCleanIndex: number;
}

function getHistoryBytes(entries: readonly TPdfHistoryEntry[]) {
    return entries.reduce((totals, entry) => {
        if (entry.kind === 'bytes') {
            totals.memory += entry.snapshot.byteLength;
        } else {
            totals.disk += entry.size;
        }
        return totals;
    }, {
        memory: 0,
        disk: 0,
    });
}

function trimHistoryByLimits(
    entries: readonly TPdfHistoryEntry[],
    limits: {
        maxEntries: number;
        maxBytes: number;
        maxPathBytes?: number;
    },
) {
    const entryTrimmedHistory = entries.slice(-limits.maxEntries);
    const totalBytes = getHistoryBytes(entryTrimmedHistory);
    const byteTrimmedHistory = [...entryTrimmedHistory];
    const maxPathBytes = limits.maxPathBytes ?? limits.maxBytes;

    while (
        byteTrimmedHistory.length > 1
        && (totalBytes.memory > limits.maxBytes || totalBytes.disk > maxPathBytes)
    ) {
        const [firstEntry] = byteTrimmedHistory;
        if (firstEntry?.kind === 'bytes') {
            totalBytes.memory -= firstEntry.snapshot.byteLength;
        } else if (firstEntry) {
            totalBytes.disk -= firstEntry.size;
        }
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
    maxPathBytes?: number;
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
