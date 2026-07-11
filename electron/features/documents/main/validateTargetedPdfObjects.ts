import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const TARGETED_OBJECT_MAX_BUFFER = 1024 * 1024;

type TExecFile = typeof execFileAsync;

function qpdfObjectArgument(ref: string) {
    const match = /^(\d+) (\d+) R$/u.exec(ref);
    if (!match) {
        throw new Error(`Invalid changed PDF object reference: ${ref}`);
    }
    return `--show-object=${match[1]},${match[2]}`;
}

export async function validateTargetedPdfObjects(
    pdfPath: string,
    validationBinary: string,
    changedObjectRefs: readonly string[],
    run: TExecFile = execFileAsync,
) {
    for (const ref of changedObjectRefs) {
        const result = await run(validationBinary, [
            qpdfObjectArgument(ref),
            pdfPath,
        ], {
            timeout: 60_000,
            maxBuffer: TARGETED_OBJECT_MAX_BUFFER,
            windowsHide: true,
        });
        const output = result.stdout.trim();
        if (!output || output === 'null') {
            throw new Error(`Changed PDF object ${ref} is missing from the staged output xref`);
        }
    }
}
