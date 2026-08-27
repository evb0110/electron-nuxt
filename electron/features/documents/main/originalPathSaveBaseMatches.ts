import {stat} from 'fs/promises';
import {getWorkingCopyOriginalFileExpectation} from '@electron/file-access/workingCopyStore';

/**
 * Fences an original-path save without reading the document bytes.
 *
 * A full SHA-256 made every annotation save proportional to the PDF size. The
 * expectation now captures filesystem identity and change timestamps when the
 * source is opened or last published. On POSIX, ctime cannot be restored by an
 * ordinary writer, so same-size and backdated external edits still fail the
 * fence. Older restored registrations may only have size and mtime; those stay
 * compatible without falling back to a whole-document comparison.
 */
export async function originalPathSaveBaseMatches(
    workingPath: string,
    originalPath: string,
    senderWebContentsId: number,
) {
    const expected = getWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!expected) {
        return false;
    }

    const actual = await stat(originalPath, {bigint: true});
    const matches = {
        ctime: expected.ctimeNs === undefined || actual.ctimeNs.toString() === expected.ctimeNs,
        device: expected.deviceId === undefined || actual.dev.toString() === expected.deviceId,
        file: actual.isFile(),
        inode: expected.inode === undefined || actual.ino.toString() === expected.inode,
        mtime: expected.mtimeNs === undefined || actual.mtimeNs.toString() === expected.mtimeNs,
        size: actual.size === BigInt(expected.size),
    };
    if (Object.values(matches).includes(false)) {
        return false;
    }

    return expected.mtimeNs !== undefined
        || Number(actual.mtimeNs) / 1_000_000 === expected.mtimeMs;
}
