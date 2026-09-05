import { getErrorMessage } from '@contracts/getErrorMessage';
import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    WINDOWS_TEST_CLI_USAGE,
    parseWindowsTestArgs,
} from '@scripts/windows-test/cli/windowsTestArgs';
import {
    createProcessCliIo,
    isDirectCliInvocation,
    writeCliLines,
} from '@scripts/windows-test/cli/windowsTestCliIo';
import type { IWindowsTestCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import { executeWindowsTestRunOnHost } from '@scripts/windows-test/host/hostRunner';
import type { IWindowsTestHostRunOptions } from '@scripts/windows-test/host/hostRunner';
import { formatWindowsTestRunSummary } from '@scripts/windows-test/host/report';
import type { IWindowsTestRunReport } from '@scripts/windows-test/host/runCoordinator';

export type TWindowsTestRunExecutor = (options: IWindowsTestHostRunOptions) => Promise<IWindowsTestRunReport>;

export async function runWindowsTestCli(
    argv: readonly string[],
    io: IWindowsTestCliIo = createProcessCliIo(),
    execute: TWindowsTestRunExecutor = executeWindowsTestRunOnHost,
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    const parsed = parseWindowsTestArgs(argv);
    if (!parsed.ok) {
        io.writeError(parsed.error);
        io.writeError(WINDOWS_TEST_CLI_USAGE);
        return windowsTestExitCodes.usageOrCrash;
    }
    if (parsed.args.help) {
        io.write(WINDOWS_TEST_CLI_USAGE);
        return windowsTestExitCodes.passed;
    }

    const writeHuman = (line: string) => {
        if (parsed.args.json) {
            io.writeError(line);
        } else {
            io.write(line);
        }
    };
    let report: IWindowsTestRunReport;
    try {
        report = await execute({
            suite: parsed.args.suite,
            tests: parsed.args.tests,
            environment: parsed.args.environment,
            artifact: parsed.args.artifact,
            dataRoot: parsed.args.dataRoot,
            env,
            // The identity of what is under test is printed before any guest
            // work starts, so a passing line can always be traced to a build.
            // Under --json it goes to stderr so stdout stays a single document.
            onIdentity: (identity) => {
                writeHuman(`Windows lane runner ${identity.runnerVersion} testing version ${identity.appVersion} from source ${identity.sourceSha}`);
                writeHuman(`Artifact ${identity.artifactFileName} sha256 ${identity.artifactSha256} on image ${identity.imageId} in environment ${identity.environment}`);
            },
        });
    } catch (error) {
        io.writeError(`The Windows test lane crashed: ${getErrorMessage(error)}`);
        return windowsTestExitCodes.usageOrCrash;
    }

    if (report.summary !== null && parsed.args.json) {
        io.write(JSON.stringify(report.summary, null, 4));
    } else if (report.summary !== null) {
        writeCliLines(io, formatWindowsTestRunSummary(report.summary));
    }
    for (const message of report.messages) {
        writeHuman(message);
    }
    return report.exitCode;
}

if (await isDirectCliInvocation(import.meta.url)) {
    process.exitCode = await runWindowsTestCli(process.argv.slice(2));
}
