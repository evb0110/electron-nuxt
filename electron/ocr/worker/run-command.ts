import {runCommand as runNativeCommand} from '@electron/native-tools/command-runner';
import type { IRunCommandResult } from '@electron/ocr/worker/types';

interface IRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    commandLabel?: string;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

export async function runCommand(
    command: string,
    args: string[],
    options: IRunCommandOptions = {},
): Promise<IRunCommandResult> {
    const {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes,
        signal,
        commandLabel,
        log,
    } = options;

    return runNativeCommand(command, args, {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes,
        signal,
        commandLabel,
        log,
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    });
}
