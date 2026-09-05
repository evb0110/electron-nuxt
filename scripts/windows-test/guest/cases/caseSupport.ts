import { formatPageMarker } from '@scripts/windows-test/fixtures/fixtureDocumentBuilders';
import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';
import { sha256Hex } from '@scripts/windows-test/guest/guestRuntime';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import { CaseDeadlineError } from '@scripts/windows-test/guest/cases/caseContext';
import { getErrorMessage } from '@contracts/getErrorMessage';

export const numberedFixtureId = 'F01-numbered-12p';

export const metadataFixtureId = 'F02-metadata-6p';

export const fontsFixtureId = 'F04-fonts-languages';

export const numberedFixturePackId = 'F01';

/**
 * Mirrors electron/file-access/documentRevisionSidecar.ts; the guest worker must
 * not import Electron main-process modules into its bundle.
 */
export const revisionSidecarSuffix = '.evb-revision.json';

export const revisionJournalSuffix = '.evb-revision-journal.json';

export function numberedFixtureMarker(pageNumber: number) {
    return formatPageMarker(numberedFixturePackId, pageNumber);
}

export function originalPageAfterDeletion(position: number, deletedOriginalPage: number) {
    return position >= deletedOriginalPage ? position + 1 : position;
}

export async function stageFixtureCopy(context: ICaseContext, fixtureId: string, fileName: string) {
    const target = joinGuestPath(context.separator, context.paths.inputsDir, fileName);
    await context.fs.makeDirectory(context.paths.inputsDir);
    await context.fs.copyFile(context.fixturePath(fixtureId), target);
    return target;
}

export async function fileSha256(context: ICaseContext, filePath: string) {
    return sha256Hex(await context.fs.readBytes(filePath));
}

/**
 * Copy a produced file into the manifest-covered evidence tree when it exists.
 * Cases call this from cleanup paths so a failed operation still leaves the
 * bytes that were produced before the failure. Missing files stay missing and
 * are reported by the host oracle that declared them required.
 */
export async function captureArtifactIfPresent(
    context: ICaseContext,
    sourcePath: string,
    evidenceFileName: string,
) {
    if (!await context.fs.exists(sourcePath)) {
        context.log(`${context.testId}: evidence source ${sourcePath} was not present`);
        return null;
    }
    try {
        await context.captureArtifact(sourcePath, evidenceFileName);
        return evidenceFileName.replaceAll('\\', '/');
    } catch (error) {
        context.log(`${context.testId}: could not capture ${sourcePath}: ${getErrorMessage(error)}`);
        return null;
    }
}

export async function writeJsonEvidence(context: ICaseContext, fileName: string, payload: unknown) {
    const target = context.attachEvidence(fileName);
    await context.fs.makeDirectory(context.paths.evidenceDir);
    await context.fs.writeText(target, JSON.stringify(payload, null, 4));
    return target;
}

export async function checkpoint(context: ICaseContext, step: string) {
    context.log(`${context.testId}: ${step}`);
    await context.throwIfCanceled();
    const remainingMs = context.remainingMs();
    if (remainingMs <= 0) {
        throw new CaseDeadlineError(remainingMs);
    }
}
