import { spawn } from 'child_process';
import {
    formatArgForLog,
    formatCommandFailureMessage,
    createAbortError,
    type IProcessResult,
    type TProcessLog,
} from '@electron/native-tools/processResult';
import {
    getCommandDirectory,
    prependDirectoryToPath,
} from '@electron/native-tools/toolRegistry';
import { getErrorMessage } from '@electron/utils/error';
import { appendTextChunkWithByteCap } from '@electron/native-tools/appendTextChunkWithByteCap';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';

export interface IRunCommandOptions {
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
    const spawnOptions = createDetachedChildProcessSpawnOptions({
        shell: false,
        windowsHide,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    if (context.effectiveCwd !== undefined) {
        spawnOptions.cwd = context.effectiveCwd;
    }
    if (context.effectiveEnv !== undefined) {
        spawnOptions.env = context.effectiveEnv;
    }
    return spawn(command, args, spawnOptions);
}

function killProcessBestEffort(proc: TNativeProcess) {
    try {
        proc.kill('SIGKILL');
    } catch {
        // Process may already be gone.
    }
}

async function terminateNativeProcessBestEffort(proc: TNativeProcess) {
    await terminateDetachedChildProcess(proc, 1_000);
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

        const contextOptions: IRunCommandOptions = {
            defaultCwdToCommandDir,
            prependCommandDirToPath,
            includeProcessEnv,
        };
        if (cwd !== undefined) {
            contextOptions.cwd = cwd;
        }
        if (env !== undefined) {
            contextOptions.env = env;
        }
        if (commandLabel !== undefined) {
            contextOptions.commandLabel = commandLabel;
        }

        const context = createCommandRunContext(command, args, contextOptions);
        const output = createBoundedOutputCapture(maxStdoutBytes, maxStderrBytes);
        let timeoutHandle: NodeJS.Timeout | null = null;
        let forceRejectHandle: NodeJS.Timeout | null = null;
        let pendingTerminationError: Error | null = null;
        let settled = false;
        let stdoutDataHandler: ((data: Buffer) => void) | null = null;
        let stderrDataHandler: ((data: Buffer) => void) | null = null;
        let processErrorHandler: ((error: Error) => void) | null = null;
        let processCloseHandler: ((code: number | null, closeSignal: NodeJS.Signals | null) => void) | null = null;
        const ignoreLateProcessError = () => undefined;

        const cleanupProcessOutput = (targetProc: TNativeProcess, destroyStreams: boolean) => {
            if (stdoutDataHandler) {
                targetProc.stdout?.removeListener('data', stdoutDataHandler);
                stdoutDataHandler = null;
            }
            if (stderrDataHandler) {
                targetProc.stderr?.removeListener('data', stderrDataHandler);
                stderrDataHandler = null;
            }
            if (!destroyStreams) {
                return;
            }
            targetProc.stdout?.unpipe?.();
            targetProc.stderr?.unpipe?.();
            targetProc.stdout?.destroy?.();
            targetProc.stderr?.destroy?.();
        };

        const cleanupProcessHandlers = () => {
            if (!proc) {
                return;
            }
            cleanupProcessOutput(proc, false);
            if (processErrorHandler) {
                proc.removeListener('error', processErrorHandler);
                processErrorHandler = null;
            }
            if (processCloseHandler) {
                proc.removeListener('close', processCloseHandler);
                processCloseHandler = null;
            }
            proc.on('error', ignoreLateProcessError);
        };

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

            cleanupProcessOutput(targetProc, true);
            void terminateNativeProcessBestEffort(targetProc).finally(() => {
                if (pendingTerminationError === error) {
                    finalizeReject(error);
                }
            });

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
            cleanupProcessHandlers();
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

        stdoutDataHandler = output.appendStdout;
        stderrDataHandler = output.appendStderr;
        proc.stdout?.on('data', stdoutDataHandler);
        proc.stderr?.on('data', stderrDataHandler);

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                log?.('error', `${context.displayName} timed out after ${timeoutMs}ms; cmd=${context.displayCommand}`);
                requestTermination(new Error(`${context.displayName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        if (signal?.aborted) {
            requestTermination(createAbortError());
        }

        processErrorHandler = (error) => {
            const message = `${context.displayName} failed to start: ${error.message}`;
            log?.('error', `${message}; cmd=${context.displayCommand}`);
            finalizeReject(new Error(message));
        };
        proc.on('error', processErrorHandler);

        processCloseHandler = (code, closeSignal) => {
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
        };
        proc.on('close', processCloseHandler);
    });
}
