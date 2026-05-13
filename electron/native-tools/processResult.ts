import { describeProcessExitCode } from '@electron/utils/processExit';
export { createAbortError } from '@electron/utils/abort';

export interface IProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type TProcessLog = (level: 'debug' | 'warn' | 'error', message: string) => void;

function truncateForError(text: string, maxLen = 1200) {
    const normalized = text.trim();
    if (normalized.length <= maxLen) {
        return normalized;
    }
    return `${normalized.slice(0, maxLen - 3)}...`;
}

export function formatArgForLog(arg: string) {
    if (/[^\w./:-]/u.test(arg)) {
        return `"${arg.replaceAll('"', '\\"')}"`;
    }
    return arg;
}

export function formatCommandFailureMessage(
    displayName: string,
    command: string,
    args: string[],
    exitCode: number,
    stdout: string,
    stderr: string,
    signal?: NodeJS.Signals | null,
) {
    const describedExitCode = describeProcessExitCode(exitCode);
    const details = truncateForError(stderr || stdout || 'No process output was captured.');
    const signalSuffix = signal ? `, signal=${signal}` : '';
    const displayCommand = `${command} ${args.map(formatArgForLog).join(' ')}`.trim();

    return {
        message: `${displayName} failed with exit code ${describedExitCode}${signalSuffix}. ${
            details || 'No process output was captured.'
        }`,
        displayCommand,
    };
}
