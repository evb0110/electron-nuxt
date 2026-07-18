import { createHash } from 'node:crypto';
import {
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';

export type TDjvuArtifactRangeStatus = 'pending' | 'running' | 'verified' | 'failed';

export interface IDjvuArtifactRange {
    startPage: number;
    endPage: number;
    outputPath: string;
    status: TDjvuArtifactRangeStatus;
    size?: number;
    error?: string | undefined;
}

interface IDjvuArtifactManifest {
    version: 1;
    fingerprint: string;
    sourcePath: string;
    createdAtMs: number;
    updatedAtMs: number;
    ranges: IDjvuArtifactRange[];
}

export interface IDjvuArtifactJob {
    directory: string;
    manifestPath: string;
    manifest: IDjvuArtifactManifest;
    cleanup?(): Promise<void>;
    updateRange(index: number, update: Partial<IDjvuArtifactRange>): Promise<void>;
}

const JOB_ROOT = join(tmpdir(), 'evb-djvu-artifact-jobs');
const STALE_JOB_MS = 7 * 24 * 60 * 60 * 1_000;

async function writeManifest(path: string, manifest: IDjvuArtifactManifest) {
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, JSON.stringify(manifest), 'utf8');
    await rename(tempPath, path);
}

function decodeManifest(value: unknown): IDjvuArtifactManifest | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || typeof value.fingerprint !== 'string'
        || typeof value.sourcePath !== 'string'
        || typeof value.createdAtMs !== 'number'
        || typeof value.updatedAtMs !== 'number'
        || !Array.isArray(value.ranges)
    ) {
        return null;
    }
    const ranges: IDjvuArtifactRange[] = [];
    for (const range of value.ranges) {
        if (
            !isRecord(range)
            || !Number.isSafeInteger(range.startPage)
            || !Number.isSafeInteger(range.endPage)
            || typeof range.outputPath !== 'string'
            || ![
                'pending',
                'running',
                'verified',
                'failed',
            ].includes(String(range.status))
        ) {
            return null;
        }
        ranges.push({
            startPage: Number(range.startPage),
            endPage: Number(range.endPage),
            outputPath: range.outputPath,
            status: range.status === 'running' || range.status === 'verified' || range.status === 'failed'
                ? range.status
                : 'pending',
            ...(typeof range.size === 'number' ? {size: range.size} : {}),
            ...(typeof range.error === 'string' ? {error: range.error} : {}),
        });
    }
    return {
        version: 1,
        fingerprint: value.fingerprint,
        sourcePath: value.sourcePath,
        createdAtMs: value.createdAtMs,
        updatedAtMs: value.updatedAtMs,
        ranges,
    };
}

export async function openDjvuArtifactJob(
    sourcePath: string,
    pageRanges: ReadonlyArray<{
        startPage: number;
        endPage: number
    }>,
    options: {
        subsample?: number;
        artifactKind?: 'pdf-range' | 'compact-page';
        qualityPreset?: string;
        outputExtension?: '.pdf' | '.json';
    },
): Promise<IDjvuArtifactJob> {
    const source = await stat(sourcePath);
    const fingerprint = createHash('sha256')
        .update(`${sourcePath}\0${source.size}\0${source.mtimeMs}\0${options.subsample ?? 1}\0${options.artifactKind ?? 'pdf-range'}\0${options.qualityPreset ?? ''}\0`)
        .update(JSON.stringify(pageRanges))
        .digest('hex');
    const directory = join(JOB_ROOT, fingerprint);
    const manifestPath = join(directory, 'manifest.json');
    await mkdir(directory, {recursive: true});
    let manifest = await readFile(manifestPath, 'utf8')
        .then(value => decodeManifest(JSON.parse(value)))
        .catch(() => null);
    if (!manifest || manifest.fingerprint !== fingerprint) {
        const now = Date.now();
        manifest = {
            version: 1,
            fingerprint,
            sourcePath,
            createdAtMs: now,
            updatedAtMs: now,
            ranges: pageRanges.map(range => ({
                ...range,
                outputPath: join(directory, `pages-${range.startPage}-${range.endPage}${options.outputExtension ?? '.pdf'}`),
                status: 'pending',
            })),
        };
        await writeManifest(manifestPath, manifest);
    } else {
        for (const range of manifest.ranges) {
            if (range.status === 'running') range.status = 'pending';
            if (range.status === 'verified') {
                const artifact = await stat(range.outputPath).catch(() => null);
                if (!artifact || artifact.size !== range.size || artifact.size <= 0) range.status = 'pending';
            }
        }
        manifest.updatedAtMs = Date.now();
        await writeManifest(manifestPath, manifest);
    }
    let writeChain = Promise.resolve();
    return {
        directory,
        manifestPath,
        manifest,
        async cleanup() {
            await writeChain;
            await rm(directory, {
                force: true,
                recursive: true,
            });
        },
        async updateRange(index, update) {
            const range = manifest.ranges[index];
            if (!range) throw new Error(`Unknown DjVu artifact range ${index}`);
            Object.assign(range, update);
            manifest.updatedAtMs = Date.now();
            writeChain = writeChain.then(() => writeManifest(manifestPath, manifest));
            await writeChain;
        },
    };
}

export async function pruneStaleDjvuArtifactJobs(now = Date.now()) {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(JOB_ROOT, {withFileTypes: true}).catch(() => []);
    const jobDirectories = entries.filter(entry => entry.isDirectory());
    const retained: Array<{
        directory: string;
        mtimeMs: number
    }> = [];
    await Promise.all(jobDirectories.map(async (entry) => {
        const directory = join(JOB_ROOT, entry.name);
        const info = await stat(join(directory, 'manifest.json')).catch(() => null);
        if (!info || now - info.mtimeMs > STALE_JOB_MS) {
            await rm(directory, {
                force: true,
                recursive: true,
            });
            return;
        }
        retained.push({
            directory,
            mtimeMs: info.mtimeMs,
        });
    }));
    retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(retained.slice(32).map(entry => rm(entry.directory, {
        force: true,
        recursive: true,
    })));
}
