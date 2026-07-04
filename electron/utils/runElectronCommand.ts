import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';

export interface IRunCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export async function runElectronCommand(
    command: string,
    args: string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        maxStdoutBytes?: number;
        maxStderrBytes?: number;
        rejectOnStdoutTruncation?: boolean;
        allowedExitCodes?: number[];
        signal?: AbortSignal;
        cancelGroup?: string;
    } = {},
): Promise<IRunCommandResult> {
    const {
        cwd,
        env,
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        rejectOnStdoutTruncation,
        allowedExitCodes,
        signal,
        cancelGroup,
    } = options;

    const commandOptions: IRunCommandOptions = {
        commandLabel: command,
        includeProcessEnv: env === undefined,
        windowsHide: false,
    };
    if (cwd !== undefined) {
        commandOptions.cwd = cwd;
    }
    if (env !== undefined) {
        commandOptions.env = env;
    }
    if (timeoutMs !== undefined) {
        commandOptions.timeoutMs = timeoutMs;
    }
    if (maxStdoutBytes !== undefined) {
        commandOptions.maxStdoutBytes = maxStdoutBytes;
    }
    if (maxStderrBytes !== undefined) {
        commandOptions.maxStderrBytes = maxStderrBytes;
    }
    if (rejectOnStdoutTruncation !== undefined) {
        commandOptions.rejectOnStdoutTruncation = rejectOnStdoutTruncation;
    }
    if (allowedExitCodes !== undefined) {
        commandOptions.allowedExitCodes = allowedExitCodes;
    }
    if (signal !== undefined) {
        commandOptions.signal = signal;
    }
    if (cancelGroup !== undefined) {
        commandOptions.cancelGroup = cancelGroup;
    }

    return runNativeCommand(command, args, commandOptions);
}
