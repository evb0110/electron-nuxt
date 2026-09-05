import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    WINDOWS_TEST_DOCTOR_USAGE,
    parseWindowsTestDoctorArgs,
} from '@scripts/windows-test/cli/windowsTestArgs';
import {
    createProcessCliIo,
    isDirectCliInvocation,
    writeCliLines,
} from '@scripts/windows-test/cli/windowsTestCliIo';
import type { IWindowsTestCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import type { IWindowsTestDoctorReport } from '@scripts/windows-test/host/doctor';
import { resolveWindowsTestLauncher } from '@scripts/windows-test/host/doctor';
import { createProcessCommandRunner } from '@scripts/windows-test/host/utmctlClient';
import { runWindowsTestDoctorOnHost } from '@scripts/windows-test/host/hostRunner';
import type { IWindowsTestDoctorHostOptions } from '@scripts/windows-test/host/hostRunner';

export type TWindowsTestDoctorExecutor = (options: IWindowsTestDoctorHostOptions) => Promise<IWindowsTestDoctorReport>;

export function formatWindowsTestDoctorReport(report: IWindowsTestDoctorReport) {
    const lines = report.checks.map(check => `${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}${check.ok ? '' : ` Remedy: ${check.remedy}`}`);
    lines.push(report.ok
        ? 'The Windows test host is ready.'
        : 'The Windows test host is not ready; fix the failing checks above before running the lane.');
    return lines;
}

export async function runWindowsTestDoctorCli(
    argv: readonly string[],
    io: IWindowsTestCliIo = createProcessCliIo(),
    execute: TWindowsTestDoctorExecutor = runWindowsTestDoctorOnHost,
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    const parsed = parseWindowsTestDoctorArgs(argv);
    if (!parsed.ok) {
        io.writeError(parsed.error);
        io.writeError(WINDOWS_TEST_DOCTOR_USAGE);
        return windowsTestExitCodes.usageOrCrash;
    }
    if (parsed.args.help) {
        io.write(WINDOWS_TEST_DOCTOR_USAGE);
        return windowsTestExitCodes.passed;
    }
    const report = await execute({
        dataRoot: parsed.args.dataRoot,
        env,
        launcherPath: await resolveWindowsTestLauncher(env, createProcessCommandRunner()),
    });
    if (parsed.args.json) {
        io.write(JSON.stringify(report, null, 4));
    } else {
        writeCliLines(io, formatWindowsTestDoctorReport(report));
    }
    return report.ok ? windowsTestExitCodes.passed : windowsTestExitCodes.infrastructureFailed;
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestDoctorCli(process.argv.slice(2));
}
