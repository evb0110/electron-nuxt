import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    WINDOWS_TEST_STOP_USAGE,
    parseWindowsTestStopArgs,
} from '@scripts/windows-test/cli/windowsTestArgs';
import {
    createProcessCliIo,
    isDirectCliInvocation,
    writeCliLines,
} from '@scripts/windows-test/cli/windowsTestCliIo';
import type { IWindowsTestCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import { requestWindowsTestStopOnHost } from '@scripts/windows-test/host/hostRunner';
import type { IWindowsTestStopHostOptions } from '@scripts/windows-test/host/hostRunner';
import type { IWindowsTestStopResult } from '@scripts/windows-test/host/stopRun';

export type TWindowsTestStopExecutor = (options: IWindowsTestStopHostOptions) => Promise<IWindowsTestStopResult>;

export async function runWindowsTestStopCli(
    argv: readonly string[],
    io: IWindowsTestCliIo = createProcessCliIo(),
    execute: TWindowsTestStopExecutor = requestWindowsTestStopOnHost,
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    const parsed = parseWindowsTestStopArgs(argv);
    if (!parsed.ok) {
        io.writeError(parsed.error);
        io.writeError(WINDOWS_TEST_STOP_USAGE);
        return windowsTestExitCodes.usageOrCrash;
    }
    if (parsed.args.help) {
        io.write(WINDOWS_TEST_STOP_USAGE);
        return windowsTestExitCodes.passed;
    }
    if (parsed.args.runId === null) {
        io.writeError('--run <run id> is required.');
        io.writeError(WINDOWS_TEST_STOP_USAGE);
        return windowsTestExitCodes.usageOrCrash;
    }
    const result = await execute({
        runId: parsed.args.runId,
        reason: parsed.args.reason,
        dataRoot: parsed.args.dataRoot,
        env,
    });
    writeCliLines(io, result.messages);
    return result.exitCode;
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestStopCli(process.argv.slice(2));
}
