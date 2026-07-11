import { spawn } from 'child_process';
import {
    formatArgForLog,
    formatCommandFailureMessage,
    createAbortError,
    type IProcessResult,
    type TProcessLog,
} from '@electron/native-tools/processResult';
import { abortErrorFromSignal } from '@electron/utils/abort';
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
import { createLogger } from '@electron/utils/createLogger';
import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';

export interface IRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    log?: TProcessLog;
    defaultCwdToCommandDir?: boolean;
    prependCommandDirToPath?: boolean;
    includeProcessEnv?: boolean;
    windowsHide?: boolean;
    rejectOnStdoutTruncation?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    terminationGraceMs?: number;
}

const DEFAULT_MAX_STDOUT_BYTES = parseIntegerEnv('EVB_NATIVE_TOOL_MAX_STDOUT_BYTES', 262_144, 1_024);
const DEFAULT_MAX_STDERR_BYTES = parseIntegerEnv('EVB_NATIVE_TOOL_MAX_STDERR_BYTES', 262_144, 1_024);
const DEFAULT_TERMINATION_GRACE_MS = parseIntegerEnv('EVB_NATIVE_TOOL_TERMINATION_GRACE_MS', 1_000, 250);
const nativeProcessTelemetryLog = createLogger('native-process-telemetry');
let activeNativeProcessCount = 0;
const DEFAULT_NATIVE_COMMAND_TIMEOUT_MS = parseIntegerEnv(
    'EVB_NATIVE_COMMAND_TIMEOUT_MS',
    15 * 60 * 1_000,
    1_000,
);

type TNativeProcess = ReturnType<typeof spawn>;
type TCancelGroupHandler = () => void;

const activeCancelGroups = new Map<string, Set<TCancelGroupHandler>>();

interface ICommandRunContext {
    effectiveCwd: string | undefined;
    effectiveEnv: NodeJS.ProcessEnv | undefined;
    displayName: string;
    displayCommand: string;
}

class NativeToolError extends Error {
    constructor(readonly code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'NativeToolError';
    }
}

function parseNativeErrorEnvelope(stderr: string): NativeToolError | null {
    const lines = stderr.trim().split(/\r?\n/u).reverse();
    for (const line of lines) {
        try {
            const value: unknown = JSON.parse(line);
            if (isNativeErrorEnvelope(value)) {
                return new NativeToolError(value.code, value.message);
            }
        } catch {
            // Native progress and third-party diagnostics are allowed alongside the final envelope.
        }
    }
    return null;
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

async function terminateNativeProcessBestEffort(proc: TNativeProcess, graceMs: number) {
    await terminateDetachedChildProcess(proc, graceMs);
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
        timeoutMs = DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
        maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
        allowedExitCodes = [0],
        signal,
        cancelGroup,
        commandLabel,
        log,
        defaultCwdToCommandDir = false,
        prependCommandDirToPath = false,
        includeProcessEnv = true,
        windowsHide = true,
        rejectOnStdoutTruncation = false,
        onStdout,
        onStderr,
        terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    } = options;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortErrorFromSignal(signal));
            return;
        }

        let proc: TNativeProcess | null = null;
        let abortHandler: (() => void) | null = null;
        let cancelGroupHandler: TCancelGroupHandler | null = null;

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
        let terminationPromise: Promise<void> | null = null;
        let settled = false;
        let processAdmitted = false;
        const startedAt = performance.now();
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
            terminationPromise = terminateNativeProcessBestEffort(targetProc, terminationGraceMs).catch(() => undefined);
            void terminationPromise.finally(() => {
                if (pendingTerminationError === error) {
                    finalizeReject(error);
                }
            });

            forceRejectHandle = setTimeout(() => {
                finalizeReject(error);
            }, terminationGraceMs + 2_000);
            forceRejectHandle.unref?.();
        };

        const finalize = (complete: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (processAdmitted) {
                processAdmitted = false;
                activeNativeProcessCount = Math.max(0, activeNativeProcessCount - 1);
                nativeProcessTelemetryLog.debug(
                    `Native process settled: command=${context.displayName} durationMs=${Math.round(performance.now() - startedAt)} active=${activeNativeProcessCount}`,
                );
            }
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
            if (cancelGroup && cancelGroupHandler) {
                unregisterCancelGroupHandler(cancelGroup, cancelGroupHandler);
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
                requestTermination(abortErrorFromSignal(signal));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }
        if (cancelGroup) {
            cancelGroupHandler = () => {
                requestTermination(createAbortError());
            };
            registerCancelGroupHandler(cancelGroup, cancelGroupHandler);
        }
        if (settled) {
            return;
        }

        try {
            proc = spawnNativeProcess(command, args, context, windowsHide);
            processAdmitted = true;
            activeNativeProcessCount += 1;
            nativeProcessTelemetryLog.debug(
                `Native process spawned: command=${context.displayName} active=${activeNativeProcessCount}`,
            );
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

        stdoutDataHandler = (data: Buffer) => {
            output.appendStdout(data);
            onStdout?.(data.toString());
        };
        stderrDataHandler = (data: Buffer) => {
            output.appendStderr(data);
            onStderr?.(data.toString());
        };
        proc.stdout?.on('data', stdoutDataHandler);
        proc.stderr?.on('data', stderrDataHandler);

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                log?.('error', `${context.displayName} timed out after ${timeoutMs}ms; cmd=${context.displayCommand}`);
                requestTermination(new Error(`${context.displayName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        if (signal?.aborted) {
            requestTermination(abortErrorFromSignal(signal));
        }

        processErrorHandler = (error) => {
            const message = `${context.displayName} failed to start: ${error.message}`;
            log?.('error', `${message}; cmd=${context.displayCommand}`);
            finalizeReject(new Error(message));
        };
        proc.on('error', processErrorHandler);

        processCloseHandler = (code, closeSignal) => {
            if (pendingTerminationError) {
                const terminationError = pendingTerminationError;
                void (terminationPromise ?? Promise.resolve()).finally(() => {
                    if (pendingTerminationError === terminationError) {
                        finalizeReject(terminationError);
                    }
                });
                return;
            }

            const exitCode = typeof code === 'number' ? code : -1;
            const outputSnapshot = output.snapshot();
            if (!allowedExitCodes.includes(exitCode)) {
                const structuredError = parseNativeErrorEnvelope(outputSnapshot.stderr);
                if (structuredError) {
                    finalizeReject(structuredError);
                    return;
                }
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

function registerCancelGroupHandler(cancelGroup: string, handler: TCancelGroupHandler) {
    const handlers = activeCancelGroups.get(cancelGroup) ?? new Set<TCancelGroupHandler>();
    handlers.add(handler);
    activeCancelGroups.set(cancelGroup, handlers);
}

function unregisterCancelGroupHandler(cancelGroup: string, handler: TCancelGroupHandler) {
    const handlers = activeCancelGroups.get(cancelGroup);
    if (!handlers) {
        return;
    }
    handlers.delete(handler);
    if (handlers.size === 0) {
        activeCancelGroups.delete(cancelGroup);
    }
}

export function cancelNativeCommandGroup(cancelGroup: string) {
    const handlers = activeCancelGroups.get(cancelGroup);
    if (!handlers || handlers.size === 0) {
        return false;
    }
    for (const handler of Array.from(handlers)) {
        handler();
    }
    return true;
}
