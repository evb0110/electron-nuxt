import {
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import type { TDjvuCompactFidelityPreset } from '@contracts/djvuConversionPolicy';
import {
    openDjvuArtifactJob,
    type IDjvuArtifactJob,
} from '@electron/features/djvu/main/djvuArtifactManifest';
import { isRecord } from '@contracts/runtimeGuards';

export interface ICheckpointedCompactPageSpec {
    pageNumber: number;
    manifestLine: string;
    kind: 'bitonal' | 'layered' | 'layered-color' | 'photo';
    reason: string;
    effectivePpi: number;
    jpegQuality?: number;
}

export function openCompactDjvuCheckpointJob(sourcePath: string, pages: number[], preset?: TDjvuCompactFidelityPreset) {
    return openDjvuArtifactJob(sourcePath, pages.map(page => ({
        startPage: page,
        endPage: page,
    })), {
        artifactKind: 'compact-page',
        qualityPreset: preset ?? 'balanced',
        outputExtension: '.json',
    });
}

function decodeSpec(value: unknown): ICheckpointedCompactPageSpec | null {
    if (!isRecord(value)
        || typeof value.pageNumber !== 'number'
        || !Number.isSafeInteger(value.pageNumber)
        || typeof value.manifestLine !== 'string'
        || !isCompactPageKind(value.kind)
        || typeof value.reason !== 'string'
        || typeof value.effectivePpi !== 'number'
        || value.jpegQuality !== undefined && typeof value.jpegQuality !== 'number') {
        return null;
    }
    return {
        pageNumber: value.pageNumber,
        manifestLine: value.manifestLine,
        kind: value.kind,
        reason: value.reason,
        effectivePpi: value.effectivePpi,
        ...(value.jpegQuality === undefined ? {} : {jpegQuality: value.jpegQuality}),
    };
}

function isCompactPageKind(value: unknown): value is ICheckpointedCompactPageSpec['kind'] {
    return value === 'bitonal'
        || value === 'layered'
        || value === 'layered-color'
        || value === 'photo';
}

export async function loadOrBuildCompactDjvuPage(
    job: IDjvuArtifactJob,
    index: number,
    build: () => Promise<ICheckpointedCompactPageSpec>,
) {
    const checkpoint = job.manifest.ranges[index];
    if (!checkpoint) throw new Error(`Missing compact DjVu checkpoint ${index}`);
    if (checkpoint.status === 'verified') {
        const saved = await readFile(checkpoint.outputPath, 'utf8')
            .then(value => decodeSpec(JSON.parse(value)))
            .catch(() => null);
        if (saved) {
            return saved;
        }
    }
    await job.updateRange(index, {
        status: 'running',
        error: undefined,
    });
    try {
        const spec = await build();
        await writeFile(checkpoint.outputPath, JSON.stringify(spec), 'utf8');
        await job.updateRange(index, {
            status: 'verified',
            size: (await stat(checkpoint.outputPath)).size,
            error: undefined,
        });
        return spec;
    } catch (error) {
        await job.updateRange(index, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}
