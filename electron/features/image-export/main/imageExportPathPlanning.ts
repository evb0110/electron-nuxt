import { existsSync } from 'fs';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { range } from 'es-toolkit/math';

export const MAX_PATH_COMPONENT_BYTES = 255;

function getUtf8ByteLength(value: string) {
    return Buffer.byteLength(value, 'utf8');
}

export function truncateUtf8PathComponent(value: string, maxBytes = MAX_PATH_COMPONENT_BYTES) {
    if (maxBytes < 0) {
        throw new Error('Path component byte budget must not be negative');
    }

    let byteLength = 0;
    let result = '';
    for (const character of value) {
        const characterByteLength = getUtf8ByteLength(character);
        if (byteLength + characterByteLength > maxBytes) {
            break;
        }
        result += character;
        byteLength += characterByteLength;
    }
    return result;
}

export function buildOutputPathWithSuffix(targetPath: string, suffix: string) {
    const outputDirectory = dirname(targetPath);
    const outputExtension = extname(targetPath);
    const outputStem = basename(targetPath, outputExtension);
    const suffixWithExtension = `${suffix}${outputExtension}`;
    const suffixByteLength = getUtf8ByteLength(suffixWithExtension);
    if (suffixByteLength > MAX_PATH_COMPONENT_BYTES) {
        throw new Error('Output filename suffix exceeds the filesystem component limit');
    }
    const boundedStem = truncateUtf8PathComponent(
        outputStem,
        MAX_PATH_COMPONENT_BYTES - suffixByteLength,
    );
    return join(outputDirectory, `${boundedStem}${suffixWithExtension}`);
}

function buildNonConflictingOutputPath(targetPath: string, reservedPaths: Set<string>) {
    const boundedTargetPath = buildOutputPathWithSuffix(targetPath, '');
    let candidatePath = boundedTargetPath;
    let suffix = 1;
    while (reservedPaths.has(candidatePath) || existsSync(candidatePath)) {
        candidatePath = buildOutputPathWithSuffix(boundedTargetPath, `-${suffix}`);
        suffix += 1;
    }
    reservedPaths.add(candidatePath);
    return candidatePath;
}

export function resolveOutputPathConflicts(targetPaths: string[], allowSingleOverwrite = true) {
    if (targetPaths.length === 1 && allowSingleOverwrite) {
        return targetPaths.map(targetPath => buildOutputPathWithSuffix(targetPath, ''));
    }
    const reservedPaths = new Set<string>();
    return targetPaths.map(targetPath => buildNonConflictingOutputPath(targetPath, reservedPaths));
}

export function buildMultiPageTiffOutputPaths(targetPath: string, partCount: number) {
    if (partCount <= 1) {
        return [buildOutputPathWithSuffix(targetPath, '')];
    }
    return range(1, partCount + 1).map(partNumber =>
        buildOutputPathWithSuffix(
            targetPath,
            `-part-${String(partNumber).padStart(3, '0')}`,
        ),
    );
}
