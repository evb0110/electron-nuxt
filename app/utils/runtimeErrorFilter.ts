import type { IDebugLogEntry } from '@contracts/electronApiCommon';

const UI_REPORTABLE_MESSAGE_PREFIX = '[ERROR]';

const IGNORABLE_RUNTIME_ERROR_MESSAGES = [
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
] as const;

function normalizeRuntimeErrorMessage(value: unknown) {
    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized.length > 0
            ? normalized
            : null;
    }

    if (value instanceof Error) {
        return normalizeRuntimeErrorMessage(value.message);
    }

    if (
        typeof value === 'object'
        && value !== null
        && 'message' in value
    ) {
        return normalizeRuntimeErrorMessage((value as {message?: unknown}).message);
    }

    return null;
}

export function isIgnorableRuntimeErrorMessage(value: unknown) {
    const normalizedMessage = normalizeRuntimeErrorMessage(value);
    if (!normalizedMessage) {
        return false;
    }

    return IGNORABLE_RUNTIME_ERROR_MESSAGES.some((message) => normalizedMessage === message);
}

export function getIgnorableRuntimeErrorMessage(value: unknown) {
    return isIgnorableRuntimeErrorMessage(value)
        ? normalizeRuntimeErrorMessage(value)
        : null;
}

/**
 * Decides which main-process log entries become user-visible runtime reports.
 *
 * Only error level qualifies, and that is the whole deduplication contract: one
 * underlying fault is logged at error level exactly once, by the layer closest
 * to it, and every wrapper that re-throws the same rejection logs its context
 * below that level. A wrapper that kept error level would produce a second
 * report with a different source and message, which the report store keys apart
 * and counts twice for a single fault.
 *
 * Cancellation is not a fault either. Closing a source tab stops the jobs that
 * read its working copy, and every layer that observes the resulting rejection
 * describes it as a cancellation, so nothing here has an error to surface.
 */
export function isUiReportableDebugLog(entry: IDebugLogEntry) {
    // The broadcast carries the level as its own field, but the printed message
    // keeps the level prefix, so an entry replayed from a log file is classified
    // the same way as a live one.
    if (entry.level !== undefined) {
        return entry.level === 'ERROR';
    }
    return entry.message.startsWith(UI_REPORTABLE_MESSAGE_PREFIX);
}

// Everything from the first stack-frame continuation line to the end of the
// message. The frames of one throw site move with every build, and the line
// above them already names the fault.
const RUNTIME_REPORT_STACK_FRAMES = /\n\s+at\s[\s\S]*$/u;
// Keyed values that differ on every occurrence of one fault: how long the run
// had been going, and which operating-system process it was.
const RUNTIME_REPORT_RUN_SPECIFIC_FIELDS = /\b(elapsedMs|durationMs|totalMs|pid)=\d+/gu;
// The same measurement written as prose: "after 1234 ms", "within 8000ms",
// "over 30000ms", "for 1000ms".
const RUNTIME_REPORT_PROSE_DURATIONS = /\b(after|within|over|for) \d+(?:\.\d+)?\s*m?s\b/gu;

/**
 * Reduces a log message to the part that identifies the fault rather than the
 * run that hit it.
 *
 * Exactly three things are removed and nothing else:
 *
 * 1. Stack frames, from the first `at ...` continuation line onward.
 * 2. Elapsed time and process identity on their keyed spellings: `elapsedMs=`,
 *    `durationMs=`, `totalMs=`, `pid=`.
 * 3. The same elapsed time written as prose after `after`, `within`, `over` or
 *    `for`.
 *
 * Digits that say what failed rather than when are left alone -- an exit
 * `code=`, a page number, a byte count, a worker path -- so two genuinely
 * different faults never collapse into one report. This is deliberately a
 * narrow, enumerated list rather than "strip every number": the cost of
 * over-normalizing is a fault the user never sees.
 */
function normalizeRuntimeReportFault(message: string) {
    return message
        .replace(RUNTIME_REPORT_STACK_FRAMES, '')
        .replace(RUNTIME_REPORT_RUN_SPECIFIC_FIELDS, '$1=<n>')
        .replace(RUNTIME_REPORT_PROSE_DURATIONS, '$1 <n>')
        .trimEnd();
}

/**
 * Shapes a reportable log entry into a runtime report.
 *
 * The displayed error is the entry verbatim, timestamp included: the user
 * reading a diagnostic needs what actually happened and when. Only the dedupe
 * key is normalized, and it deliberately excludes the timestamp: one fault
 * repeated across a run is one report with a count, and including the time --
 * or the elapsed milliseconds and stack frames the message carries -- would
 * make every repetition a new card. The key also excludes the title, which is
 * localized, so the same fault does not split into two reports when the user
 * changes language.
 */
export function createDebugLogRuntimeErrorReport(entry: IDebugLogEntry, title: string) {
    return {
        title,
        source: entry.source,
        error: `${entry.timestamp}\n${entry.message}`,
        dedupeKey: `${entry.source}\n${normalizeRuntimeReportFault(entry.message)}`,
    };
}
