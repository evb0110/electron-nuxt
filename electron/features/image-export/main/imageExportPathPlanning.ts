import { existsSync } from 'fs';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { range } from 'es-toolkit/math';

export function buildImageExportOutputPaths(
    normalizedPath: string,
    pageCount: number,
    outputStem: string,
    outputExtension: string,
) {
    if (pageCount === 1) {
        return [normalizedPath];
    }
    const outputDirectory = dirname(normalizedPath);
    return range(1, pageCount + 1).map(outputIndex =>
        join(outputDirectory, `${outputStem}-${String(outputIndex).padStart(3, '0')}${outputExtension}`),
    );
}

function buildNonConflictingOutputPath(targetPath: string, reservedPaths: Set<string>) {
    const outputDirectory = dirname(targetPath);
    const outputExtension = extname(targetPath);
    const outputStem = basename(targetPath, outputExtension);
    let candidatePath = targetPath;
    let suffix = 1;
    while (reservedPaths.has(candidatePath) || existsSync(candidatePath)) {
        candidatePath = join(outputDirectory, `${outputStem}-${suffix}${outputExtension}`);
        suffix += 1;
    }
    reservedPaths.add(candidatePath);
    return candidatePath;
}

export function resolveOutputPathConflicts(targetPaths: string[], allowSingleOverwrite = true) {
    if (targetPaths.length === 1 && allowSingleOverwrite) {
        return targetPaths;
    }
    const reservedPaths = new Set<string>();
    return targetPaths.map(targetPath => buildNonConflictingOutputPath(targetPath, reservedPaths));
}

export function buildMultiPageTiffOutputPaths(targetPath: string, partCount: number) {
    if (partCount <= 1) {
        return [targetPath];
    }
    const outputDirectory = dirname(targetPath);
    const outputExtension = extname(targetPath) || '.tiff';
    const outputStem = basename(targetPath, outputExtension);
    return range(1, partCount + 1).map(partNumber =>
        join(outputDirectory, `${outputStem}-part-${String(partNumber).padStart(3, '0')}${outputExtension}`),
    );
}
