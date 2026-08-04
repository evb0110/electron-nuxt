/* eslint-disable custom/file-naming -- This module is the shared build-manifest boundary. */

import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {
    IScanCleanupWorkerPaths,
    TScanCleanupAssemblerBackend,
    TScanCleanupTransportMode,
} from '@scan-cleanup-core/types';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
} from '@scan-cleanup-core/provenanceStamp';
import type {IScanCleanupStampBuildIds} from '@scan-cleanup-core/provenanceStamp';

export async function buildScanCleanupStampBuildIds({
    paths,
    assemblerBackend,
    transportMode,
}: {
    paths: IScanCleanupWorkerPaths;
    assemblerBackend: TScanCleanupAssemblerBackend;
    transportMode: TScanCleanupTransportMode;
}): Promise<IScanCleanupStampBuildIds> {
    const nativeBinarySha256s: Record<string, string> = {};
    const binaries: Array<[string, string | undefined]> = [
        [
            'scanCleanup',
            paths.scanCleanupBinary,
        ],
        [
            'pdfImageCombine',
            paths.pdfImageCombineBinary,
        ],
        [
            'pdfPageOps',
            paths.pdfPageOpsBinary,
        ],
    ];
    for (const [
        role,
        path,
    ] of binaries) {
        if (path === undefined) continue;
        nativeBinarySha256s[role] = await hashBinaryOrBackendMarker(path, role, assemblerBackend);
    }
    if (Object.keys(nativeBinarySha256s).length === 0) {
        nativeBinarySha256s.assembler = hashText(`assembler:${assemblerBackend}`);
    }
    return {
        coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
        coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
        nativeBinarySha256s,
        assemblerBackend,
        transportMode,
    };
}

async function hashBinaryOrBackendMarker(path: string, role: string, backend: TScanCleanupAssemblerBackend) {
    if (/^__scan_cleanup_cli_[a-z_]+__$/u.test(path)) {
        return hashText(`${role}:${backend}`);
    }
    try {
        return createHash('sha256').update(await readFile(path)).digest('hex');
    } catch (error) {
        throw new Error(
            `Provenance stamp requires a readable ${role} binary at ${path}: `
            + (error instanceof Error ? error.message : String(error)),
        );
    }
}

function hashText(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
