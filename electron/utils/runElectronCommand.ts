import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { withDefinedCommandOptions } from '@electron/native-tools/withDefinedCommandOptions';

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
    const commandOptions = withDefinedCommandOptions({
        commandLabel: command,
        includeProcessEnv: options.env === undefined,
        windowsHide: false,
    }, options);

    return runNativeCommand(command, args, commandOptions);
}
