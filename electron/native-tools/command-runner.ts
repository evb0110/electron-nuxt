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
import { terminateProcessTree } from '@electron/utils/process-tree';
import { getErrorMessage } from '@electron/utils/error';
import { appendTextChunkWithByteCap } from '@electron/native-tools/output-buffer';
import { parseIntegerEnv } from '@electron/utils/env';

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
    rejectOnStdoutTruncation?: boolean;
}

const DEFAULT_MAX_STDOUT_BYTES = parseIntegerEnv('EVB_NATIVE_TOOL_MAX_STDOUT_BYTES', 262_144, 1_024);
const DEFAULT_MAX_STDERR_BYTES = parseIntegerEnv('EVB_NATIVE_TOOL_MAX_STDERR_BYTES', 262_144, 1_024);

type TNativeProcess = ReturnType<typeof spawn>;

interface ICommandRunContext {
    effectiveCwd: string | undefined;
    effectiveEnv: NodeJS.ProcessEnv | undefined;
    displayName: string;
    displayCommand: string;
}

function createCommandRunContext(command: string, args: string[], options: IRunCommandOptions): ICommandRunContext {
    const {
        cwd,
        env,
        commandLabel,
        defaultCwdToCommandDir = false,
        prependCommandDirToPath = false,
        includeProcessEnv = true,
    } = options;
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
    return {
        effectiveCwd,
        effectiveEnv,
        displayName: commandLabel ?? command,
        displayCommand: `${command} ${args.map(formatArgForLog).join(' ')}`.trim(),
    };
}

function createBoundedOutputCapture(maxStdoutBytes: number, maxStderrBytes: number) {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    return {
        appendStdout(data: Buffer) {
            const appended = appendTextChunkWithByteCap(stdout, data, maxStdoutBytes);
            stdout = appended.text;
            stdoutTruncated = stdoutTruncated || appended.truncated;
        },
        appendStderr(data: Buffer) {
            const appended = appendTextChunkWithByteCap(stderr, data, maxStderrBytes);
            stderr = appended.text;
            stderrTruncated = stderrTruncated || appended.truncated;
        },
        snapshot() {
            return {
                stdout,
                stderr,
                stdoutTruncated,
                stderrTruncated,
            };
        },
    };
}

function spawnNativeProcess(
    command: string,
    args: string[],
    context: ICommandRunContext,
    windowsHide: boolean,
) {
    return spawn(command, args, {
        cwd: context.effectiveCwd,
        env: context.effectiveEnv,
        shell: false,
        windowsHide,
        detached: process.platform !== 'win32',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
}

function killProcessBestEffort(proc: TNativeProcess) {
    try {
        proc.kill('SIGKILL');
    } catch {
        // Process may already be gone.
    }
}

function terminateNativeProcessBestEffort(proc: TNativeProcess) {
    const pid = proc.pid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
        void terminateProcessTree(pid, {
            graceMs: 1_000,
            preferProcessGroup: process.platform !== 'win32',
        });
        return;
    }
    try {
        proc.kill('SIGTERM');
    } catch {
        // Process may already be gone.
    }
}

function getTruncatedOutputMessage(label: 'stdout' | 'stderr', truncated: boolean, maxBytes: number, text: string) {
    return truncated
        ? `[${label} truncated to ${maxBytes} bytes]\n${text}`
        : text;
}

export async function runNativeCommand(
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
        rejectOnStdoutTruncation = false,
    } = options;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }

        let proc: TNativeProcess | null = null;
        let abortHandler: (() => void) | null = null;

        const context = createCommandRunContext(command, args, {
            cwd,
            env,
            commandLabel,
            defaultCwdToCommandDir,
            prependCommandDirToPath,
            includeProcessEnv,
        });
        const output = createBoundedOutputCapture(maxStdoutBytes, maxStderrBytes);
        let timeoutHandle: NodeJS.Timeout | null = null;
        let forceRejectHandle: NodeJS.Timeout | null = null;
        let pendingTerminationError: Error | null = null;
        let settled = false;

        const requestTermination = (error: Error) => {
            if (settled || pendingTerminationError) {
                return;
            }
            pendingTerminationError = error;
            const targetProc = proc;
            if (!targetProc) {
                finalizeReject(error);
                return;
            }

            terminateNativeProcessBestEffort(targetProc);

            forceRejectHandle = setTimeout(() => {
                finalizeReject(error);
            }, 3_000);
            forceRejectHandle.unref?.();
        };

        const finalize = (complete: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (forceRejectHandle) {
                clearTimeout(forceRejectHandle);
                forceRejectHandle = null;
            }
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            complete();
        };

        const finalizeReject = (error: Error) => {
            finalize(() => {
                reject(error);
            });
        };

        const finalizeResolve = (result: IProcessResult) => {
            finalize(() => {
                resolve(result);
            });
        };

        if (signal) {
            abortHandler = () => {
                requestTermination(createAbortError());
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }
        if (settled) {
            return;
        }

        try {
            proc = spawnNativeProcess(command, args, context, windowsHide);
        } catch (error) {
            const message = `${context.displayName} failed to start: ${getErrorMessage(error)}`;
            log?.('error', `${message}; cmd=${context.displayCommand}`);
            finalizeReject(new Error(message));
            return;
        }
        if (settled) {
            killProcessBestEffort(proc);
            return;
        }

        proc.stdout?.on('data', output.appendStdout);
        proc.stderr?.on('data', output.appendStderr);

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                log?.('error', `${context.displayName} timed out after ${timeoutMs}ms; cmd=${context.displayCommand}`);
                requestTermination(new Error(`${context.displayName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        if (signal?.aborted) {
            requestTermination(createAbortError());
        }

        proc.on('error', (error) => {
            const message = `${context.displayName} failed to start: ${error.message}`;
            log?.('error', `${message}; cmd=${context.displayCommand}`);
            finalizeReject(new Error(message));
        });

        proc.on('close', (code, closeSignal) => {
            if (pendingTerminationError) {
                finalizeReject(pendingTerminationError);
                return;
            }

            const exitCode = typeof code === 'number' ? code : -1;
            const outputSnapshot = output.snapshot();
            if (!allowedExitCodes.includes(exitCode)) {
                const failure = formatCommandFailureMessage(
                    context.displayName,
                    command,
                    args,
                    exitCode,
                    getTruncatedOutputMessage('stdout', outputSnapshot.stdoutTruncated, maxStdoutBytes, outputSnapshot.stdout),
                    getTruncatedOutputMessage('stderr', outputSnapshot.stderrTruncated, maxStderrBytes, outputSnapshot.stderr),
                    closeSignal,
                );
                log?.('error', `${failure.message}; cmd=${failure.displayCommand}`);
                finalizeReject(new Error(failure.message));
                return;
            }
            if (rejectOnStdoutTruncation && outputSnapshot.stdoutTruncated) {
                const message = `${context.displayName} stdout exceeded ${maxStdoutBytes} bytes`;
                log?.('error', `${message}; cmd=${context.displayCommand}`);
                finalizeReject(new Error(message));
                return;
            }

            if (closeSignal) {
                log?.('warn', `${context.displayName} exited after signal ${closeSignal}; cmd=${context.displayCommand}`);
            }

            finalizeResolve({
                stdout: outputSnapshot.stdout,
                stderr: outputSnapshot.stderr,
                exitCode,
            });
        });
    });
}
