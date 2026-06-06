import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import type { IProcessResult } from '@electron/native-tools/processResult';

export interface IRunNativeToolCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    commandLabel?: string;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

export async function runNativeToolCommand(
    command: string,
    args: string[],
    options: IRunNativeToolCommandOptions = {},
): Promise<IProcessResult> {
    const {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes,
        signal,
        commandLabel,
        log,
    } = options;

    const commandOptions: IRunCommandOptions = {
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
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
    if (allowedExitCodes !== undefined) {
        commandOptions.allowedExitCodes = allowedExitCodes;
    }
    if (signal !== undefined) {
        commandOptions.signal = signal;
    }
    if (commandLabel !== undefined) {
        commandOptions.commandLabel = commandLabel;
    }
    if (log !== undefined) {
        commandOptions.log = log;
    }

    return runNativeCommand(command, args, commandOptions);
}
