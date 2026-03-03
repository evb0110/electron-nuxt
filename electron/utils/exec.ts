import {runCommand as runNativeCommand} from '@electron/native-tools/command-runner';

type TRunCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

export async function runCommand(
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
    } = {},
): Promise<TRunCommandResult> {
    const {
        cwd,
        env,
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        rejectOnStdoutTruncation,
        allowedExitCodes,
        signal,
    } = options;

    return runNativeCommand(command, args, {
        cwd,
        env,
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        rejectOnStdoutTruncation,
        allowedExitCodes,
        signal,
        commandLabel: command,
        includeProcessEnv: env === undefined,
        windowsHide: false,
    });
}
