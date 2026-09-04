import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';
import {
    nativeDialogRecordIds,
    typeFilePathWithKeyboard,
    waitForDialogWindow,
    waitForDialogWindowToClose,
} from '@scripts/windows-test/guest/cases/nativeDialogs';
import {
    readPdfPageCount,
    waitForFileToSettle,
} from '@scripts/windows-test/guest/cases/printSupport';
import {
    checkpoint,
    numberedFixtureId,
    stageFixtureCopy,
    writeJsonEvidence,
} from '@scripts/windows-test/guest/cases/caseSupport';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import type { IGuestCommandResult } from '@scripts/windows-test/guest/guestRuntime';
import { viewerDefaultTimeouts } from '@scripts/windows-test/guest/viewer/viewerDriver';

const UNICODE_SOURCE_NAME = 'вход-テスト-01.pdf';

const UNICODE_TARGET_PREFIX = 'сохранение-';

const SYSTEM32_ONLY_PATH = 'C:\\Windows\\System32';

const BUNDLED_TOOL_PROBES = [
    ['--version'],
    ['-h'],
] as const;

export async function runWinUi02(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, UNICODE_SOURCE_NAME);
    const targetName = `${UNICODE_TARGET_PREFIX}${UNICODE_SOURCE_NAME}`;
    const target = joinGuestPath(context.separator, context.paths.outputsDir, targetName);
    await context.fs.makeDirectory(context.paths.outputsDir);
    const acceptance = await context.viewer.launchAcceptance();
    try {
        const mainWindow = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.viewerWindow,
            viewerDefaultTimeouts.startupMs,
        );
        await context.nativeUi.sendKeys(mainWindow, '^o');
        const openDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.fileDialog,
            viewerDefaultTimeouts.uiStepMs,
        );
        await typeFilePathWithKeyboard(context, openDialog, source);
        const openDialogClosed = await waitForDialogWindowToClose(
            context,
            nativeDialogRecordIds.fileDialog,
            viewerDefaultTimeouts.uiStepMs,
        );
        context.requireAssertion(
            'ui02.open-dialog-accepted-unicode-path',
            openDialogClosed,
            `The keyboard-only open dialog closed after typing ${UNICODE_SOURCE_NAME}`,
        );

        await checkpoint(context, 'keyboard-only save as');
        await context.nativeUi.sendKeys(mainWindow, '^+s');
        const saveDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.fileDialog,
            viewerDefaultTimeouts.uiStepMs,
        );
        await typeFilePathWithKeyboard(context, saveDialog, target);
        const settled = await waitForFileToSettle(context, target, viewerDefaultTimeouts.operationMs);
        context.requireAssertion(
            'ui02.unicode-save-target-created',
            settled.settled,
            `The Unicode Save As target settled at ${settled.bytes} bytes`,
        );
        const targetPages = await readPdfPageCount(context.fs, target);
        const sourcePages = await readPdfPageCount(context.fs, source);
        context.assert(
            'ui02.unicode-save-page-count',
            targetPages === sourcePages,
            `The Unicode copy has ${targetPages} pages against ${sourcePages} in the source`,
        );
        const outputNames = await context.fs.listNames(context.paths.outputsDir);
        context.assert(
            'ui02.unicode-name-preserved',
            outputNames.includes(targetName),
            `The output directory contains ${outputNames.join(', ')}`,
        );
        await writeJsonEvidence(context, 'win-ui-02-summary.json', {
            source,
            target,
            targetPages,
            outputNames,
        });
    } finally {
        await acceptance.close();
    }
}

export interface IBundledToolProbe {
    executable: string;
    relativePath: string;
    exitCode: number;
    outputBytes: number;
    probeArguments: string[];
}

export function isExecutableName(relativePath: string) {
    return relativePath.toLowerCase().endsWith('.exe');
}

export async function listBundledExecutables(context: ICaseContext) {
    const resourcesDir = joinGuestPath(context.separator, context.installDirectory, 'resources');
    const entries = await context.fs.listFilesRecursively(resourcesDir);
    return entries
        .filter(isExecutableName)
        .map(relativePath => ({
            relativePath,
            absolutePath: joinGuestPath(
                context.separator,
                resourcesDir,
                ...relativePath.split('/'),
            ),
        }));
}

export async function runWinTools01(context: ICaseContext) {
    const executables = await listBundledExecutables(context);
    context.requireAssertion(
        'tools01.bundled-executables-found',
        executables.length > 0,
        `The install directory exposes ${executables.length} bundled executables`,
    );

    const decoyDirectory = joinGuestPath(context.separator, context.paths.outputsDir, 'path-decoy');
    await context.fs.makeDirectory(decoyDirectory);
    const strippedEnvironment = {
        PATH: SYSTEM32_ONLY_PATH,
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
    };

    const probes: IBundledToolProbe[] = [];
    for (const executable of executables) {
        await checkpoint(context, `probe ${executable.relativePath}`);
        let probe: IBundledToolProbe | null = null;
        for (const probeArguments of BUNDLED_TOOL_PROBES) {
            const result = await context.exec.run(executable.absolutePath, probeArguments, {
                env: strippedEnvironment,
                timeoutMs: viewerDefaultTimeouts.uiStepMs,
            }).catch((error: unknown): IGuestCommandResult => {
                // The failure text must not count as output, or a tool that
                // cannot start would pass the loads assertion.
                context.log(`${executable.relativePath} could not be started: ${error instanceof Error ? error.message : String(error)}`);
                return {
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                };
            });
            const outputBytes = result.stdout.length + result.stderr.length;
            probe = {
                executable: executable.absolutePath,
                relativePath: executable.relativePath,
                exitCode: result.exitCode,
                outputBytes,
                probeArguments: [...probeArguments],
            };
            if (outputBytes > 0) {
                break;
            }
        }
        if (probe !== null) {
            probes.push(probe);
        }
        context.assert(
            `tools01.loads.${executable.relativePath}`,
            probe !== null && probe.outputBytes > 0,
            `${executable.relativePath} answered with ${String(probe?.outputBytes ?? 0)} bytes `
            + `and exit code ${String(probe?.exitCode ?? -1)} under a System32-only PATH`,
        );
    }

    const [firstExecutable] = executables;
    if (firstExecutable === undefined) {
        return;
    }
    const decoyName = firstExecutable.relativePath.split('/').pop() ?? firstExecutable.relativePath;
    const decoyPath = joinGuestPath(context.separator, decoyDirectory, decoyName);
    await context.fs.writeText(decoyPath, 'This decoy is not a valid Windows executable image.\r\n');
    const conflictingPathResult = await context.exec.run(decoyName, ['--version'], {
        env: {
            PATH: decoyDirectory,
            SystemRoot: 'C:\\Windows',
            windir: 'C:\\Windows',
        },
        timeoutMs: viewerDefaultTimeouts.uiStepMs,
    }).catch(error => ({
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
    }));
    context.assert(
        'tools01.conflicting-host-path-control-fails',
        conflictingPathResult.exitCode !== 0,
        `Resolving ${decoyName} through a conflicting PATH exited with ${conflictingPathResult.exitCode}`,
    );

    await writeJsonEvidence(context, 'win-tools-01-summary.json', {
        probes,
        decoyName,
        decoyExitCode: conflictingPathResult.exitCode,
    });
}
