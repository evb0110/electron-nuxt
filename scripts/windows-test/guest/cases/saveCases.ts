import { getErrorMessage } from '@contracts/getErrorMessage';
import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';
import { saveThroughFileDialog } from '@scripts/windows-test/guest/cases/nativeDialogs';
import {
    readPdfPageCount,
    waitForFileToSettle,
} from '@scripts/windows-test/guest/cases/printSupport';
import {
    checkpoint,
    captureArtifactIfPresent,
    fileSha256,
    metadataFixtureId,
    numberedFixtureId,
    numberedFixtureMarker,
    originalPageAfterDeletion,
    revisionJournalSuffix,
    revisionSidecarSuffix,
    stageFixtureCopy,
    writeJsonEvidence,
} from '@scripts/windows-test/guest/cases/caseSupport';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import type { IGuestCommandResult } from '@scripts/windows-test/guest/guestRuntime';
import {
    viewerDefaultTimeouts,
    type IViewerSession,
} from '@scripts/windows-test/guest/viewer/viewerDriver';

const FIRST_DELETED_PAGE = 3;

const SECOND_DELETED_POSITION = 5;

const SAVE_08_MAX_RECOVERY_ATTEMPTS = 3;

export async function runWinSave01(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, 'win-save-01-source.pdf');
    await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-01/source-before.pdf');
    const session = await context.viewer.openInstrumented(source);
    let initialPages = 0;
    try {
        initialPages = await session.driver.totalPages();
        context.requireAssertion(
            'save01.initial-page-count',
            initialPages > SECOND_DELETED_POSITION,
            `The numbered fixture opened with ${initialPages} pages`,
        );

        await checkpoint(context, 'first delete');
        const firstDelete = await session.driver.deletePage(FIRST_DELETED_PAGE);
        context.requireAssertion(
            'save01.first-delete',
            firstDelete.success,
            `Deleting page ${FIRST_DELETED_PAGE} reported ${firstDelete.errorCode ?? 'success'}`,
        );
        const firstSave = await session.driver.save();
        context.requireAssertion(
            'save01.first-save',
            firstSave.success,
            `The first save reported ${firstSave.errorCode ?? 'success'}`,
        );
        context.assert(
            'save01.page-count-after-first-save',
            firstSave.pageCount === initialPages - 1,
            `The toolbar reported ${String(firstSave.pageCount)} pages after the first save`,
        );

        await checkpoint(context, 'second delete');
        const staleToken = await session.driver.documentRevisionToken();
        const secondDelete = await session.driver.deletePage(SECOND_DELETED_POSITION);
        context.requireAssertion(
            'save01.second-delete',
            secondDelete.success,
            `Deleting position ${SECOND_DELETED_POSITION} reported ${secondDelete.errorCode ?? 'success'}`,
        );
        const staleAttempt = await session.driver.deletePageUsingRevisionToken(1, staleToken);
        context.assert(
            'save01.stale-revision-rejected',
            !staleAttempt.success,
            `A delete replayed with the pre-delete revision token reported ${staleAttempt.errorCode ?? 'success'}`,
        );

        const secondSave = await session.driver.save();
        context.requireAssertion(
            'save01.second-save',
            secondSave.success,
            `The second save reported ${secondSave.errorCode ?? 'success'}`,
        );
        await session.driver.captureScreenshot(context.attachEvidence('win-save-01-after-saves.png'));
        context.assert(
            'save01.no-renderer-failures',
            session.driver.rendererFailures().length === 0,
            session.driver.rendererFailures().join(' | ') || 'The renderer logged no errors',
        );
    } finally {
        try {
            await session.close();
        } finally {
            await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-01/source-after.pdf');
        }
    }

    await checkpoint(context, 'reopen in a fresh process');
    const reopened = await context.viewer.openInstrumented(source);
    try {
        const reopenedPages = await reopened.driver.totalPages();
        context.assert(
            'save01.reopened-page-count',
            reopenedPages === initialPages - 2,
            `The reopened document reported ${reopenedPages} pages, expected ${initialPages - 2}`,
        );
        const onDiskPages = await readPdfPageCount(context.fs, source);
        context.assert(
            'save01.on-disk-page-count',
            onDiskPages === initialPages - 2,
            `The saved file contains ${onDiskPages} pages, expected ${initialPages - 2}`,
        );

        const deletedMarkers = [
            numberedFixtureMarker(FIRST_DELETED_PAGE),
            numberedFixtureMarker(originalPageAfterDeletion(SECOND_DELETED_POSITION, FIRST_DELETED_PAGE)),
        ];
        for (const marker of deletedMarkers) {
            const matches = await reopened.driver.countTextMatches(source, marker);
            context.assert(
                `save01.deleted-marker-absent.${marker}`,
                matches === 0,
                `${marker} still matched ${matches} times after the deletions`,
            );
        }
        const survivorMarker = numberedFixtureMarker(1);
        const survivorMatches = await reopened.driver.countTextMatches(source, survivorMarker);
        context.assert(
            'save01.survivor-marker-present',
            survivorMatches > 0,
            `${survivorMarker} matched ${survivorMatches} times`,
        );
        await writeJsonEvidence(context, 'win-save-01-summary.json', {
            initialPages,
            reopenedPages,
            onDiskPages,
            deletedMarkers,
        });
    } finally {
        await reopened.close();
    }
}

export async function runWinSave02(context: ICaseContext) {
    const source = await stageFixtureCopy(context, metadataFixtureId, 'win-save-02-source.pdf');
    const target = joinGuestPath(context.separator, context.paths.outputsDir, 'win-save-02-copy.pdf');
    await context.fs.makeDirectory(context.paths.outputsDir);
    await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-02/source-before.pdf');
    const session = await context.viewer.openInstrumented(source);
    try {
        const firstAnnotation = await session.driver.createAnnotation('EVB-WIN-SAVE-02-A');
        context.requireAssertion(
            'save02.first-annotation-created',
            firstAnnotation > 0,
            `The editor reported ${firstAnnotation} free text editors after the first annotation`,
        );
        const firstSave = await session.driver.save();
        context.requireAssertion(
            'save02.first-save',
            firstSave.success,
            `The first save reported ${firstSave.errorCode ?? 'success'}`,
        );

        await checkpoint(context, 'second annotation');
        const secondAnnotation = await session.driver.createAnnotation('EVB-WIN-SAVE-02-B');
        context.requireAssertion(
            'save02.second-annotation-created',
            secondAnnotation > firstAnnotation,
            `The editor reported ${secondAnnotation} free text editors after the second annotation`,
        );
        const secondSave = await session.driver.save();
        context.requireAssertion(
            'save02.second-save',
            secondSave.success,
            `The second save reported ${secondSave.errorCode ?? 'success'}`,
        );

        const sourceHashBeforeSaveAs = await fileSha256(context, source);
        await checkpoint(context, 'save as through the native picker');
        await session.driver.requestSaveAsCommand();
        await saveThroughFileDialog(context, {
            filePath: target,
            timeoutMs: viewerDefaultTimeouts.uiStepMs,
        });
        const settled = await waitForFileToSettle(context, target, viewerDefaultTimeouts.operationMs);
        context.requireAssertion(
            'save02.save-as-produced-a-file',
            settled.settled,
            `The Save As target settled at ${settled.bytes} bytes`,
        );
        const sourceHashAfterSaveAs = await fileSha256(context, source);
        context.assert(
            'save02.source-untouched-by-save-as',
            sourceHashBeforeSaveAs === sourceHashAfterSaveAs,
            `The source hash moved from ${sourceHashBeforeSaveAs} to ${sourceHashAfterSaveAs}`,
        );
        const targetPages = await readPdfPageCount(context.fs, target);
        const sourcePages = await readPdfPageCount(context.fs, source);
        context.assert(
            'save02.save-as-page-count',
            targetPages === sourcePages,
            `The Save As copy has ${targetPages} pages against ${sourcePages} in the source`,
        );
        await writeJsonEvidence(context, 'win-save-02-summary.json', {
            sourceHashBeforeSaveAs,
            sourceHashAfterSaveAs,
            targetBytes: settled.bytes,
            targetPages,
        });
    } finally {
        try {
            await session.close();
        } finally {
            await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-02/source-after.pdf');
            await captureArtifactIfPresent(context, target, 'artifacts/WIN-SAVE-02/target.pdf');
        }
    }
}

export async function runWinSave04(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, 'win-save-04-source.pdf');
    await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-04/source-before.pdf');
    const readyFile = joinGuestPath(context.separator, context.paths.outputsDir, 'win-save-04-handle-ready.txt');
    await context.fs.makeDirectory(context.paths.outputsDir);
    await context.fs.remove(readyFile);
    const originalHash = await fileSha256(context, source);
    const originalPages = await readPdfPageCount(context.fs, source);

    const holdSeconds = 30;
    // The helper outlives most of the case, so a rejection before the await
    // below must be caught here or it kills the worker as an unhandled one.
    const holdRun = context.powerShell.run('hold-file-handle.ps1', [
        '-Path',
        source,
        '-DurationSeconds',
        String(holdSeconds),
        '-ReadyFile',
        readyFile,
    ]).catch((error: unknown): IGuestCommandResult => ({
        exitCode: -1,
        stdout: '',
        stderr: getErrorMessage(error),
    }));
    let session: IViewerSession | null = null;
    try {
        session = await context.viewer.openInstrumented(source);
        const handleReady = await waitForFileToSettle(context, readyFile, viewerDefaultTimeouts.uiStepMs);
        context.requireAssertion(
            'save04.exclusive-handle-held',
            handleReady.exists,
            'The helper script reported an open exclusive handle on the source file',
        );

        const deleted = await session.driver.deletePage(2);
        context.requireAssertion(
            'save04.delete-page',
            deleted.success,
            `Deleting page 2 reported ${deleted.errorCode ?? 'success'}`,
        );
        const blockedSave = await session.driver.save();
        context.assert(
            'save04.save-denied-while-handle-held',
            !blockedSave.success,
            `The save under a held handle reported ${blockedSave.errorCode ?? 'success'}`,
        );
        const hashUnderDenial = await fileSha256(context, source);
        context.assert(
            'save04.source-not-truncated',
            hashUnderDenial === originalHash,
            'The denied save left the source bytes unchanged',
        );

        await checkpoint(context, 'release the handle');
        const holdResult = await holdRun;
        context.assert(
            'save04.handle-released',
            holdResult.exitCode === 0,
            `hold-file-handle.ps1 exited with ${holdResult.exitCode}: ${holdResult.stderr.trim()}`,
        );
        const retriedSave = await session.driver.save();
        context.requireAssertion(
            'save04.save-succeeds-after-release',
            retriedSave.success,
            `The retried save reported ${retriedSave.errorCode ?? 'success'}`,
        );
        const finalPages = await readPdfPageCount(context.fs, source);
        context.assert(
            'save04.page-count-after-recovery',
            finalPages === originalPages - 1,
            `The recovered file has ${finalPages} pages, expected ${originalPages - 1}`,
        );
        await writeJsonEvidence(context, 'win-save-04-summary.json', {
            originalHash,
            hashUnderDenial,
            originalPages,
            finalPages,
            blockedSaveError: blockedSave.errorCode,
        });
    } finally {
        try {
            if (session !== null) {
                await session.close();
            }
        } finally {
            try {
                await holdRun;
            } finally {
                await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-04/source-after.pdf');
            }
        }
    }
}

export async function runWinSave08(context: ICaseContext) {
    const source = await stageFixtureCopy(context, numberedFixtureId, 'win-save-08-source.pdf');
    await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-08/source-before.pdf');
    let sidecarPath: string | null = null;
    let journalPath: string | null = null;
    const session = await context.viewer.openInstrumented(source);
    try {
        const workingCopyPath = await session.driver.workingCopyPath();
        sidecarPath = `${workingCopyPath}${revisionSidecarSuffix}`;
        journalPath = `${workingCopyPath}${revisionJournalSuffix}`;

        const seedDelete = await session.driver.deletePage(2);
        context.requireAssertion(
            'save08.seed-delete',
            seedDelete.success,
            `The seeding delete reported ${seedDelete.errorCode ?? 'success'}`,
        );
        const seedSave = await session.driver.save();
        context.requireAssertion(
            'save08.seed-save',
            seedSave.success,
            `The seeding save reported ${seedSave.errorCode ?? 'success'}`,
        );
        context.assert(
            'save08.sidecar-written',
            await context.fs.exists(sidecarPath),
            `The revision sidecar ${sidecarPath} exists after the first save`,
        );

        await checkpoint(context, 'corrupt the revision sidecar');
        await context.fs.writeText(sidecarPath, '{"sidecarVersion": "corrupt"');
        await context.fs.writeText(journalPath, 'not-json');
        const corruptRecovery = await recoverBySaving(context, session.driver, 3);
        context.assert(
            'save08.recovers-from-corrupt-sidecar',
            corruptRecovery.succeeded,
            `Recovery from a corrupt sidecar took ${corruptRecovery.attempts} attempts`,
        );
        context.assert(
            'save08.corrupt-recovery-is-bounded',
            corruptRecovery.attempts <= SAVE_08_MAX_RECOVERY_ATTEMPTS,
            `Recovery used ${corruptRecovery.attempts} of ${SAVE_08_MAX_RECOVERY_ATTEMPTS} allowed attempts`,
        );

        await checkpoint(context, 'remove the revision sidecar and journals');
        await context.fs.remove(sidecarPath);
        await context.fs.remove(journalPath);
        const missingRecovery = await recoverBySaving(context, session.driver, 4);
        context.assert(
            'save08.recovers-from-missing-sidecar',
            missingRecovery.succeeded,
            `Recovery from a missing sidecar took ${missingRecovery.attempts} attempts`,
        );
        context.assert(
            'save08.sidecar-recreated',
            await context.fs.exists(sidecarPath),
            `The revision sidecar ${sidecarPath} exists again after recovery`,
        );
        await writeJsonEvidence(context, 'win-save-08-summary.json', {
            sidecarPath,
            journalPath,
            corruptRecovery,
            missingRecovery,
        });
    } finally {
        try {
            await session.close();
        } finally {
            await captureArtifactIfPresent(context, source, 'artifacts/WIN-SAVE-08/source-after.pdf');
            if (sidecarPath !== null) {
                await captureArtifactIfPresent(context, sidecarPath, 'artifacts/WIN-SAVE-08/revision-sidecar.json');
            }
            if (journalPath !== null) {
                await captureArtifactIfPresent(context, journalPath, 'artifacts/WIN-SAVE-08/revision-journal.json');
            }
        }
    }
}

interface IRecoveryOutcome {
    succeeded: boolean;
    attempts: number;
    errors: string[];
}

async function recoverBySaving(
    context: ICaseContext,
    driver: Awaited<ReturnType<ICaseContext['viewer']['openInstrumented']>>['driver'],
    pageToDelete: number,
): Promise<IRecoveryOutcome> {
    const errors: string[] = [];
    for (let attempt = 1; attempt <= SAVE_08_MAX_RECOVERY_ATTEMPTS; attempt += 1) {
        await checkpoint(context, `recovery attempt ${attempt}`);
        const deleted = await driver.deletePage(pageToDelete);
        if (!deleted.success) {
            errors.push(`attempt ${attempt} delete: ${deleted.errorCode ?? 'unknown'}`);
            continue;
        }
        const saved = await driver.save();
        if (saved.success) {
            return {
                succeeded: true,
                attempts: attempt,
                errors,
            };
        }
        errors.push(`attempt ${attempt} save: ${saved.errorCode ?? 'unknown'}`);
    }
    return {
        succeeded: false,
        attempts: SAVE_08_MAX_RECOVERY_ATTEMPTS,
        errors,
    };
}
