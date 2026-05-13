import { runNativeCommand } from '@electron/native-tools/commandRunner';
import type { IProcessResult } from '@electron/native-tools/processResult';

interface IRunNativeToolCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowedExitCodes?: number[];
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
        commandLabel,
        log,
    } = options;

    return runNativeCommand(command, args, {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes,
        commandLabel,
        log,
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    });
}
