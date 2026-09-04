import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    resolveWindowsTestDataRoot,
    windowsTestHostLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    WINDOWS_TEST_REPORT_USAGE,
    parseWindowsTestReportArgs,
} from '@scripts/windows-test/cli/windowsTestArgs';
import {
    createProcessCliIo,
    isDirectCliInvocation,
    writeCliLines,
} from '@scripts/windows-test/cli/windowsTestCliIo';
import type { IWindowsTestCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import { buildWindowsTestReport } from '@scripts/windows-test/host/report';

export async function runWindowsTestReportCli(
    argv: readonly string[],
    io: IWindowsTestCliIo = createProcessCliIo(),
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    const parsed = parseWindowsTestReportArgs(argv);
    if (!parsed.ok) {
        io.writeError(parsed.error);
        io.writeError(WINDOWS_TEST_REPORT_USAGE);
        return windowsTestExitCodes.usageOrCrash;
    }
    if (parsed.args.help) {
        io.write(WINDOWS_TEST_REPORT_USAGE);
        return windowsTestExitCodes.passed;
    }
    const layout = windowsTestHostLayout(parsed.args.dataRoot ?? resolveWindowsTestDataRoot(env));
    const report = await buildWindowsTestReport({
        runsDir: layout.runsDir,
        runId: parsed.args.runId,
        json: parsed.args.json,
    });
    writeCliLines(io, report.lines);
    return report.exitCode;
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestReportCli(process.argv.slice(2));
}
