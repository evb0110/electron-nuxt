import { spawn } from 'child_process';
import {
    formatArgForLog,
    formatCommandFailureMessage,
    createAbortError,
    type IProcessResult,
    type TProcessLog,
} from '@electron/native-tools/process-result';
import {
    getCommandDirectory,
    prependDirectoryToPath,
} from '@electron/native-tools/tool-registry';

interface IRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    commandLabel?: string;
    log?: TProcessLog;
    defaultCwdToCommandDir?: boolean;
    prependCommandDirToPath?: boolean;
    includeProcessEnv?: boolean;
    windowsHide?: boolean;
}

const DEFAULT_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_NATIVE_TOOL_MAX_STDOUT_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();
const DEFAULT_MAX_STDERR_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_NATIVE_TOOL_MAX_STDERR_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();

function appendWithCap(current: string, chunk: Buffer, maxBytes: number) {
    const chunkText = chunk.toString();
    if (maxBytes <= 0) {
        return {
            value: '',
            truncated: true,
        };
    }

    const nextValue = current + chunkText;
    if (Buffer.byteLength(nextValue, 'utf8') <= maxBytes) {
        return {
            value: nextValue,
            truncated: false,
        };
    }

    const targetTailBytes = Math.max(1, Math.floor(maxBytes * 0.9));
    let tail = nextValue;
    while (Buffer.byteLength(tail, 'utf8') > targetTailBytes && tail.length > 1) {
        tail = tail.slice(Math.floor(tail.length * 0.1));
    }
    return {
        value: tail,
        truncated: true,
    };
}

export async function runCommand(
    command: string,
    args: string[],
    options: IRunCommandOptions = {},
): Promise<IProcessResult> {
    const {
        cwd,
        env,
        timeoutMs,
        maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
        allowedExitCodes = [0],
        signal,
        commandLabel,
        log,
        defaultCwdToCommandDir = false,
        prependCommandDirToPath = false,
        includeProcessEnv = true,
        windowsHide = true,
    } = options;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }

        const commandDir = getCommandDirectory(command);
        const effectiveCwd = cwd ?? (defaultCwdToCommandDir ? commandDir ?? undefined : undefined);
        const baseEnv: NodeJS.ProcessEnv = includeProcessEnv ? { ...process.env } : {};
        const mergedEnv = env
            ? {
                ...baseEnv,
                ...env,
            }
            : (includeProcessEnv ? process.env : undefined);
        const effectiveEnv = commandDir && prependCommandDirToPath && mergedEnv
            ? prependDirectoryToPath(commandDir, mergedEnv)
            : mergedEnv;
        const displayName = commandLabel ?? command;
        const displayCommand = `${command} ${args.map(formatArgForLog).join(' ')}`.trim();

        const proc = spawn(command, args, {
            cwd: effectiveCwd,
            env: effectiveEnv,
            shell: false,
            windowsHide,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let settled = false;

        const finalizeReject = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            reject(error);
        };

        const finalizeResolve = (result: IProcessResult) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            resolve(result);
        };

        proc.stdout?.on('data', (data: Buffer) => {
            const appended = appendWithCap(stdout, data, maxStdoutBytes);
            stdout = appended.value;
            stdoutTruncated = stdoutTruncated || appended.truncated;
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const appended = appendWithCap(stderr, data, maxStderrBytes);
            stderr = appended.value;
            stderrTruncated = stderrTruncated || appended.truncated;
        });

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                proc.kill('SIGKILL');
                log?.('error', `${displayName} timed out after ${timeoutMs}ms; cmd=${displayCommand}`);
                finalizeReject(new Error(`${displayName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        const abortHandler = signal
            ? () => {
                proc.kill('SIGKILL');
                finalizeReject(createAbortError());
            }
            : null;
        if (signal && abortHandler) {
            signal.addEventListener('abort', abortHandler, {once: true});
        }

        proc.on('error', (error) => {
            const message = `${displayName} failed to start: ${error.message}`;
            log?.('error', `${message}; cmd=${displayCommand}`);
            finalizeReject(new Error(message));
        });

        proc.on('close', (code, closeSignal) => {
            const exitCode = typeof code === 'number' ? code : -1;
            if (!allowedExitCodes.includes(exitCode)) {
                const failure = formatCommandFailureMessage(
                    displayName,
                    command,
                    args,
                    exitCode,
                    stdoutTruncated ? `[stdout truncated to ${maxStdoutBytes} bytes]\n${stdout}` : stdout,
                    stderrTruncated ? `[stderr truncated to ${maxStderrBytes} bytes]\n${stderr}` : stderr,
                    closeSignal,
                );
                log?.('error', `${failure.message}; cmd=${failure.displayCommand}`);
                finalizeReject(new Error(failure.message));
                return;
            }

            if (closeSignal) {
                log?.('warn', `${displayName} exited after signal ${closeSignal}; cmd=${displayCommand}`);
            }

            finalizeResolve({
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}
