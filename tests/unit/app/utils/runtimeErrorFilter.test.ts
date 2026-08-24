import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import {
    createDebugLogRuntimeErrorReport,
    getIgnorableRuntimeErrorMessage,
    isIgnorableRuntimeErrorMessage,
    isUiReportableDebugLog,
} from '@app/utils/runtimeErrorFilter';

function debugLogEntry(
    source: string,
    level: IDebugLogEntry['level'],
    message: string,
): IDebugLogEntry {
    return {
        source,
        message: level === undefined ? message : `[${level}] ${message}`,
        timestamp: '2026-08-23T08:57:36.046Z',
        ...(level === undefined ? {} : {level}),
    };
}

describe('runtime error filter', () => {
    it('ignores known ResizeObserver browser warnings', () => {
        expect(isIgnorableRuntimeErrorMessage('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
        expect(isIgnorableRuntimeErrorMessage(new Error('ResizeObserver loop limit exceeded'))).toBe(true);
        expect(getIgnorableRuntimeErrorMessage({message: 'ResizeObserver loop completed with undelivered notifications.'})).toBe(
            'ResizeObserver loop completed with undelivered notifications.',
        );
    });

    it('keeps real runtime failures fatal', () => {
        expect(isIgnorableRuntimeErrorMessage('TypeError: Cannot read properties of undefined')).toBe(false);
        expect(getIgnorableRuntimeErrorMessage(new Error('Boom'))).toBeNull();
    });

    it('does not suppress real errors that merely mention ResizeObserver text', () => {
        expect(isIgnorableRuntimeErrorMessage(
            'TypeError: Cannot read properties of undefined. ResizeObserver loop completed with undelivered notifications.',
        )).toBe(false);
    });

    it('promotes only error-level main-process logs to runtime reports', () => {
        expect(isUiReportableDebugLog(debugLogEntry(
            'worker-task',
            'ERROR',
            'Worker reported failure: path=scan-cleanup-worker.js message=pdftoppm failed',
        ))).toBe(true);
        // The wrapper that re-throws the same rejection logs its context below
        // error level so one fault cannot become two reports.
        expect(isUiReportableDebugLog(debugLogEntry(
            'scan-cleanup-worker-task',
            'WARN',
            'Scan cleanup worker task rejected (already reported): Error: pdftoppm failed',
        ))).toBe(false);
        expect(isUiReportableDebugLog(debugLogEntry(
            'scan-cleanup-worker-task',
            'INFO',
            'Scan cleanup worker task canceled',
        ))).toBe(false);
    });

    it('falls back to the printed level prefix when an entry carries no level', () => {
        expect(isUiReportableDebugLog(debugLogEntry('working-copy', undefined, '[ERROR] Boom'))).toBe(true);
        expect(isUiReportableDebugLog(debugLogEntry('working-copy', undefined, '[WARN] Retained the working copy'))).toBe(false);
    });

    it('shows the entry verbatim while deduplicating one fault across repetitions', () => {
        const entry = debugLogEntry(
            'worker-task',
            'ERROR',
            'Worker reported failure: path=scan-cleanup-worker.js elapsedMs=1873 message=pdftoppm failed',
        );

        const report = createDebugLogRuntimeErrorReport(entry, 'Runtime error');

        // What the user reads keeps the timing and the timestamp; only the key
        // the report store groups by is normalized.
        expect(report.error).toBe(`${entry.timestamp}\n${entry.message}`);
        expect(report.title).toBe('Runtime error');
        expect(report.source).toBe('worker-task');
        expect(report.dedupeKey).toBe(
            'worker-task\n[ERROR] Worker reported failure: path=scan-cleanup-worker.js '
            + 'elapsedMs=<n> message=pdftoppm failed',
        );
    });

    it('keys the same fault together across elapsed time, process id and stack frames', () => {
        const sameFault = [
            debugLogEntry('worker-task', 'ERROR', 'Worker reported failure: path=w.js elapsedMs=1873 message=boom'),
            debugLogEntry('worker-task', 'ERROR', 'Worker reported failure: path=w.js elapsedMs=42 message=boom'),
        ].map(entry => createDebugLogRuntimeErrorReport(entry, 'Runtime error').dedupeKey);
        expect(new Set(sameFault).size).toBe(1);

        const sameTermination = [
            debugLogEntry(
                'native-tools',
                'ERROR',
                'evb-scan-cleanup process tree (pid=4242) was not proven dead within 8000ms of termination',
            ),
            debugLogEntry(
                'native-tools',
                'ERROR',
                'evb-scan-cleanup process tree (pid=9137) was not proven dead within 8000ms of termination',
            ),
        ].map(entry => createDebugLogRuntimeErrorReport(entry, 'Runtime error').dedupeKey);
        expect(new Set(sameTermination).size).toBe(1);

        // The same throw reported twice: only the frames below the message
        // differ, and they carry build-dependent line and column numbers.
        const sameStack = [
            debugLogEntry(
                'scan-cleanup-worker-task',
                'ERROR',
                'Scan cleanup worker task rejected: Error: boom\n    at run (/app/a.js:10:3)\n    at go (/app/b.js:4:1)',
            ),
            debugLogEntry(
                'scan-cleanup-worker-task',
                'ERROR',
                'Scan cleanup worker task rejected: Error: boom\n    at run (/app/a.js:11:9)',
            ),
        ].map(entry => createDebugLogRuntimeErrorReport(entry, 'Runtime error').dedupeKey);
        expect(new Set(sameStack).size).toBe(1);
    });

    it('keeps distinct faults apart, including the digits that name them', () => {
        const keyFor = (source: string, message: string) => createDebugLogRuntimeErrorReport(
            debugLogEntry(source, 'ERROR', message),
            'Runtime error',
        ).dedupeKey;

        // Different message, different worker, different exit code, different
        // page: four faults, four reports. Normalizing any of these away would
        // hide a failure the user never gets told about.
        const distinct = [
            keyFor('worker-task', 'Worker reported failure: path=w.js elapsedMs=1873 message=boom'),
            keyFor('worker-task', 'Worker reported failure: path=w.js elapsedMs=1873 message=pdftoppm failed'),
            keyFor('worker-task', 'Worker reported failure: path=other.js elapsedMs=1873 message=boom'),
            keyFor('worker-task', 'Worker exited before returning a result: path=w.js code=1 elapsedMs=1873'),
            keyFor('worker-task', 'Worker exited before returning a result: path=w.js code=139 elapsedMs=1873'),
            keyFor('scan-cleanup', 'Page 3 failed to render'),
            keyFor('scan-cleanup', 'Page 7 failed to render'),
        ];
        expect(new Set(distinct).size).toBe(distinct.length);

        // The same message from two subsystems is two faults; the source stays
        // part of the key.
        expect(keyFor('worker-task', 'boom')).not.toBe(keyFor('working-copy', 'boom'));
    });
});
