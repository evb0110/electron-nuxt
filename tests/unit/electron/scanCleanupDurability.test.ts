import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createScanCleanupCacheIdentity,
    writeScanCleanupCacheMetadata,
} from '@scan-cleanup-core/cache';
import {
    SCAN_CLEANUP_SCRATCH_PREFIX,
    sweepStaleScanCleanupScratchDirs,
} from '@scan-cleanup-core/scratchCleanup';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory() {
    const directory = await mkdtemp(join(tmpdir(), 'scan-cleanup-durability-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup durability', () => {
    it('sweeps stale scan-cleanup directories without following symlinks', async () => {
        const parentPath = await createTemporaryDirectory();
        const outsidePath = await createTemporaryDirectory();
        const now = Date.now();
        const stalePath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}stale`);
        const freshPath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}fresh`);
        const unrelatedPath = join(parentPath, 'unrelated-stale');
        const linkPath = join(parentPath, `${SCAN_CLEANUP_SCRATCH_PREFIX}link`);
        await mkdir(stalePath);
        await mkdir(freshPath);
        await mkdir(unrelatedPath);
        await writeFile(join(outsidePath, 'keep.txt'), 'keep', 'utf8');
        await symlink(outsidePath, linkPath, 'dir');
        const staleTime = new Date(now - 120_000);
        await utimes(stalePath, staleTime, staleTime);
        await utimes(unrelatedPath, staleTime, staleTime);

        const log = vi.fn();
        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            log,
            maxAgeMs: 60_000,
            now: () => now,
        })).resolves.toBe(1);

        await expect(readFile(join(outsidePath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
        await expect(access(stalePath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(rm(freshPath, {
            force: true,
            recursive: true,
        })).resolves.toBeUndefined();
        await expect(rm(unrelatedPath, {
            force: true,
            recursive: true,
        })).resolves.toBeUndefined();
        await expect(rm(linkPath, {
            force: true,
            recursive: true,
        })).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(
            'debug',
            `Removed stale scan-cleanup scratch directory "${stalePath}"`,
        );
    });

    it('tolerates parent and per-entry sweep errors', async () => {
        const parentPath = await createTemporaryDirectory();
        const permissionError = Object.assign(new Error('permission denied'), {code: 'EPERM'});
        const log = vi.fn();

        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            fileSystem: {readdir: async () => {
                throw permissionError;
            }},
            log,
        })).resolves.toBe(0);
        await expect(sweepStaleScanCleanupScratchDirs(parentPath, {
            fileSystem: {
                readdir: async () => [{
                    isDirectory: () => true,
                    name: `${SCAN_CLEANUP_SCRATCH_PREFIX}entry-error`,
                }],
                lstat: async () => {
                    throw permissionError;
                },
            },
            log,
        })).resolves.toBe(0);

        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('permission denied'));
    });

    it('includes the existing source SHA-256 in cache identity', () => {
        const oldIdentity = createScanCleanupCacheIdentity({
            sourceMtimeNs: 123_456_789n,
            sourcePath: '/documents/scan.pdf',
            sourceSha256: 'a'.repeat(64),
            sourceSize: 42n,
        });
        const replacementIdentity = createScanCleanupCacheIdentity({
            sourceMtimeNs: 123_456_789n,
            sourcePath: '/documents/scan.pdf',
            sourceSha256: 'b'.repeat(64),
            sourceSize: 42n,
        });
        const cache = new Map([[
            oldIdentity,
            'old result',
        ]]);

        expect(replacementIdentity).not.toBe(oldIdentity);
        expect(cache.get(replacementIdentity)).toBeUndefined();
    });

    it('writes cache metadata through a synced sibling temp file and atomic rename', async () => {
        const openCalls: Array<{
            flags: 'r' | 'w';
            path: string
        }> = [];
        const events: string[] = [];
        const metadataPath = '/cache/scan-cleanup-metadata.json';
        const fileSystem = {
            open: async (path: string, flags: 'r' | 'w') => {
                openCalls.push({
                    flags,
                    path,
                });
                return {
                    close: async () => {
                        events.push(`close:${path}`);
                    },
                    sync: async () => {
                        events.push(`sync:${path}`);
                    },
                    writeFile: async (value: string, encoding: 'utf8') => {
                        events.push(`write:${path}:${encoding}:${value}`);
                    },
                };
            },
            rename: async (sourcePath: string, targetPath: string) => {
                events.push(`rename:${sourcePath}:${targetPath}`);
            },
            unlink: async (path: string) => {
                events.push(`unlink:${path}`);
            },
        };

        await writeScanCleanupCacheMetadata(metadataPath, '{"ok":true}', {fileSystem});

        const temporaryPath = openCalls[0]!.path;
        expect(openCalls[0]).toMatchObject({flags: 'w'});
        expect(temporaryPath).toContain(`.${join('', 'scan-cleanup-metadata.json')}.`);
        expect(openCalls[1]).toEqual({
            flags: 'r',
            path: dirname(metadataPath),
        });
        expect(events).toContain(`write:${temporaryPath}:utf8:{"ok":true}`);
        expect(events).toContain(`sync:${temporaryPath}`);
        expect(events).toContain(`rename:${temporaryPath}:${metadataPath}`);
        expect(events).toContain(`unlink:${temporaryPath}`);
        expect(events.filter(event => event.startsWith('sync:'))).toHaveLength(process.platform === 'win32' ? 1 : 2);
    });
});
