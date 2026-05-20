import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/exec';
import type { IRunCommandResult } from '@electron/ocr/worker/types';

export type IOcrRunCommandOptions = IRunNativeToolCommandOptions;

export async function runOcrCommand(
    command: string,
    args: string[],
    options: IOcrRunCommandOptions = {},
): Promise<IRunCommandResult> {
    return runNativeToolCommand(command, args, options);
}
