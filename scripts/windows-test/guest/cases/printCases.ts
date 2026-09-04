import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';
import {
    cancelFileDialogIfPresent,
    cancelPrintDialog,
    commitFileDialog,
    confirmPrintDialog,
    fillFileDialogPath,
    findDialogWindow,
    nativeDialogRecordIds,
    refuseOverwrite,
    selectPrintToPdfPrinter,
    waitForDialogControl,
    waitForDialogWindow,
    waitForDialogWindowToClose,
} from '@scripts/windows-test/guest/cases/nativeDialogs';
import {
    readPdfPageCount,
    readPrintJobs,
    waitForFileToSettle,
    waitForPrintQueueDrain,
} from '@scripts/windows-test/guest/cases/printSupport';
import {
    checkpoint,
    fileSha256,
    numberedFixtureId,
    stageFixtureCopy,
    writeJsonEvidence,
} from '@scripts/windows-test/guest/cases/caseSupport';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import {
    viewerDefaultTimeouts,
    type IViewerSession,
} from '@scripts/windows-test/guest/viewer/viewerDriver';

const PRINT_CANCEL_SETTLE_MS = 3_000;

export interface IPrintToPdfOutcome {
    outputPath: string;
    bytes: number;
    pageCount: number;
    queueDrained: boolean;
}

export async function printToPdf(
    context: ICaseContext,
    session: IViewerSession,
    outputPath: string,
): Promise<IPrintToPdfOutcome> {
    await session.driver.printDocumentCommand();
    const printDialog = await waitForDialogWindow(
        context,
        nativeDialogRecordIds.printDialog,
        viewerDefaultTimeouts.printReadinessMs,
    );
    await selectPrintToPdfPrinter(context, printDialog, viewerDefaultTimeouts.uiStepMs);
    await confirmPrintDialog(context, printDialog, viewerDefaultTimeouts.uiStepMs);

    const outputDialog = await waitForDialogWindow(
        context,
        nativeDialogRecordIds.printOutputDialog,
        viewerDefaultTimeouts.printReadinessMs,
    );
    await fillFileDialogPath(context, outputDialog, outputPath, viewerDefaultTimeouts.uiStepMs);
    await commitFileDialog(context, outputDialog, viewerDefaultTimeouts.uiStepMs);

    const drain = await waitForPrintQueueDrain(context, viewerDefaultTimeouts.printReadinessMs);
    const settled = await waitForFileToSettle(context, outputPath, viewerDefaultTimeouts.printReadinessMs);
    return {
        outputPath,
        bytes: settled.bytes,
        pageCount: settled.settled ? await readPdfPageCount(context.fs, outputPath) : 0,
        queueDrained: drain.drained,
    };
}

function assertPrintOutput(
    context: ICaseContext,
    prefix: string,
    outcome: IPrintToPdfOutcome,
    expectedPageCount: number,
) {
    context.assert(
        `${prefix}.queue-drained`,
        outcome.queueDrained,
        `The Microsoft Print to PDF queue drained within the readiness ceiling for ${outcome.outputPath}`,
    );
    context.requireAssertion(
        `${prefix}.output-exists`,
        outcome.bytes > 0,
        `${outcome.outputPath} settled at ${outcome.bytes} bytes`,
    );
    context.assert(
        `${prefix}.output-page-count`,
        outcome.pageCount === expectedPageCount,
        `${outcome.outputPath} has ${outcome.pageCount} pages, expected ${expectedPageCount}`,
    );
}

export async function runWinPrint01(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, 'win-print-01-source.pdf');
    await context.fs.makeDirectory(context.paths.outputsDir);
    const coldOutput = joinGuestPath(context.separator, context.paths.outputsDir, 'win-print-01-cold.pdf');
    const warmOutput = joinGuestPath(context.separator, context.paths.outputsDir, 'win-print-01-warm.pdf');
    const session = await context.viewer.openInstrumented(source);
    try {
        const sourcePages = await session.driver.totalPages();
        context.requireAssertion(
            'print01.source-page-count',
            sourcePages > 1,
            `The numbered fixture opened with ${sourcePages} pages`,
        );

        await checkpoint(context, 'cold print');
        const cold = await printToPdf(context, session, coldOutput);
        assertPrintOutput(context, 'print01.cold', cold, sourcePages);

        await checkpoint(context, 'warm repeat print');
        const warm = await printToPdf(context, session, warmOutput);
        assertPrintOutput(context, 'print01.warm', warm, sourcePages);
        context.assert(
            'print01.warm-repeat-matches-cold-page-count',
            warm.pageCount === cold.pageCount,
            `The warm repeat produced ${warm.pageCount} pages against ${cold.pageCount} in the cold run`,
        );
        await writeJsonEvidence(context, 'win-print-01-summary.json', {
            source,
            sourcePages,
            cold,
            warm,
        });
    } finally {
        await session.close();
    }
}

export async function runWinPrint02(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, 'win-print-02-source.pdf');
    await context.fs.makeDirectory(context.paths.outputsDir);
    const output = joinGuestPath(context.separator, context.paths.outputsDir, 'win-print-02-after-edits.pdf');
    const session = await context.viewer.openInstrumented(source);
    let expectedPages = 0;
    try {
        const initialPages = await session.driver.totalPages();
        const firstDelete = await session.driver.deletePage(3);
        context.requireAssertion(
            'print02.first-delete',
            firstDelete.success,
            `Deleting page 3 reported ${firstDelete.errorCode ?? 'success'}`,
        );
        const firstSave = await session.driver.save();
        context.requireAssertion(
            'print02.first-save',
            firstSave.success,
            `The first save reported ${firstSave.errorCode ?? 'success'}`,
        );

        await checkpoint(context, 'second edit');
        const secondDelete = await session.driver.deletePage(5);
        context.requireAssertion(
            'print02.second-delete',
            secondDelete.success,
            `Deleting position 5 reported ${secondDelete.errorCode ?? 'success'}`,
        );
        const secondSave = await session.driver.save();
        context.requireAssertion(
            'print02.second-save',
            secondSave.success,
            `The second save reported ${secondSave.errorCode ?? 'success'}`,
        );
        expectedPages = initialPages - 2;

        await checkpoint(context, 'print the edited document');
        const printed = await printToPdf(context, session, output);
        assertPrintOutput(context, 'print02.printed', printed, expectedPages);
        await writeJsonEvidence(context, 'win-print-02-summary.json', {
            source,
            initialPages,
            expectedPages,
            printed,
        });
    } finally {
        await session.close();
    }

    await checkpoint(context, 'reopen after printing');
    const reopened = await context.viewer.openInstrumented(source);
    try {
        const reopenedPages = await reopened.driver.totalPages();
        context.assert(
            'print02.reopened-page-count',
            reopenedPages === expectedPages,
            `The reopened document reported ${reopenedPages} pages, expected ${expectedPages}`,
        );
        const onDiskPages = await readPdfPageCount(context.fs, source);
        context.assert(
            'print02.on-disk-page-count',
            onDiskPages === expectedPages,
            `The saved source contains ${onDiskPages} pages, expected ${expectedPages}`,
        );
    } finally {
        await reopened.close();
    }
}

export async function runWinPrint07(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, 'win-print-07-source.pdf');
    await context.fs.makeDirectory(context.paths.outputsDir);
    const strayOutput = joinGuestPath(context.separator, context.paths.outputsDir, 'win-print-07-stray.pdf');
    const protectedOutput = joinGuestPath(context.separator, context.paths.outputsDir, 'win-print-07-existing.pdf');
    await context.fs.copyFile(source, protectedOutput);
    const protectedHash = await fileSha256(context, protectedOutput);
    const session = await context.viewer.openInstrumented(source);
    const ownedPid = session.process.pid;
    try {
        await checkpoint(context, 'cancel the in-app print flow');
        await session.driver.printDocumentCommand();
        await session.driver.pressKeys(['Escape']);
        await context.clock.sleep(PRINT_CANCEL_SETTLE_MS);
        context.assert(
            'print07.app-flow-canceled',
            !await session.driver.isPreparingPrint(),
            'The workspace stopped reporting an in-flight print preparation after Escape',
        );

        await checkpoint(context, 'cancel the native print dialog');
        await session.driver.printDocumentCommand();
        const printDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.printDialog,
            viewerDefaultTimeouts.printReadinessMs,
        );
        await cancelPrintDialog(context, printDialog, viewerDefaultTimeouts.uiStepMs);
        const printDialogClosed = await waitForDialogWindowToClose(
            context,
            nativeDialogRecordIds.printDialog,
            viewerDefaultTimeouts.uiStepMs,
        );
        context.assert(
            'print07.native-print-dialog-canceled',
            printDialogClosed,
            'The native print dialog closed after Cancel',
        );

        await checkpoint(context, 'cancel the print output dialog');
        await session.driver.printDocumentCommand();
        const secondPrintDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.printDialog,
            viewerDefaultTimeouts.printReadinessMs,
        );
        await selectPrintToPdfPrinter(context, secondPrintDialog, viewerDefaultTimeouts.uiStepMs);
        await confirmPrintDialog(context, secondPrintDialog, viewerDefaultTimeouts.uiStepMs);
        const outputDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.printOutputDialog,
            viewerDefaultTimeouts.printReadinessMs,
        );
        await fillFileDialogPath(context, outputDialog, strayOutput, viewerDefaultTimeouts.uiStepMs);
        const cancelControl = await waitForDialogControl(
            context,
            outputDialog,
            nativeDialogRecordIds.cancelButton,
            viewerDefaultTimeouts.uiStepMs,
        );
        await context.nativeUi.invoke(cancelControl);
        await context.clock.sleep(PRINT_CANCEL_SETTLE_MS);
        context.assert(
            'print07.no-stray-output-after-cancel',
            !await context.fs.exists(strayOutput),
            `${strayOutput} was never created after cancelling the output dialog`,
        );

        await checkpoint(context, 'refuse an overwrite');
        await session.driver.printDocumentCommand();
        const thirdPrintDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.printDialog,
            viewerDefaultTimeouts.printReadinessMs,
        );
        await selectPrintToPdfPrinter(context, thirdPrintDialog, viewerDefaultTimeouts.uiStepMs);
        await confirmPrintDialog(context, thirdPrintDialog, viewerDefaultTimeouts.uiStepMs);
        const overwriteDialog = await waitForDialogWindow(
            context,
            nativeDialogRecordIds.printOutputDialog,
            viewerDefaultTimeouts.printReadinessMs,
        );
        await fillFileDialogPath(context, overwriteDialog, protectedOutput, viewerDefaultTimeouts.uiStepMs);
        await commitFileDialog(context, overwriteDialog, viewerDefaultTimeouts.uiStepMs);
        await refuseOverwrite(context, viewerDefaultTimeouts.uiStepMs);
        const stillOpen = await findDialogWindow(context, nativeDialogRecordIds.printOutputDialog);
        if (stillOpen !== null) {
            const cancelAfterRefusal = await waitForDialogControl(
                context,
                stillOpen,
                nativeDialogRecordIds.cancelButton,
                viewerDefaultTimeouts.uiStepMs,
            );
            await context.nativeUi.invoke(cancelAfterRefusal);
        }
        await context.clock.sleep(PRINT_CANCEL_SETTLE_MS);
        context.assert(
            'print07.overwrite-refusal-preserved-file',
            await fileSha256(context, protectedOutput) === protectedHash,
            `${protectedOutput} kept its original bytes after the overwrite refusal`,
        );

        const remainingJobs = await readPrintJobs(context);
        context.assert(
            'print07.no-print-jobs-left',
            remainingJobs.length === 0,
            `The spooler still lists ${remainingJobs.length} jobs after the cancellations`,
        );
        await writeJsonEvidence(context, 'win-print-07-summary.json', {
            strayOutput,
            protectedOutput,
            protectedHash,
            remainingJobs,
        });
    } finally {
        // A failure mid-flow can leave the native output dialog open, which
        // would block the next case; dismissing it is best effort.
        await cancelFileDialogIfPresent(context, viewerDefaultTimeouts.uiStepMs).catch(() => false);
        await session.close();
    }

    const orphanWindow = await context.nativeUi.findWindow({ processId: ownedPid });
    context.assert(
        'print07.no-orphan-windows',
        orphanWindow === null,
        `Process ${ownedPid} left no window behind after the owned shutdown`,
    );
}
