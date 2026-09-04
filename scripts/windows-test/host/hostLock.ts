import {
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { ownershipMatches } from '@scripts/windows-test/host/hostProcessIdentity';

export interface IHostLockOwner {
    hostId: string;
    pid: number;
    startTime: string;
    acquiredAt: string;
}

export interface IHostLockHandle {
    lockDirectory: string;
    owner: IHostLockOwner;
    release(): Promise<void>;
}

export interface IHostLockDependencies {
    hostId: string;
    pid: number;
    probe: IHostProcessIdentityProbe;
    nowIso(): string;
    sleep(milliseconds: number): Promise<void>;
}

export interface IHostLockOptions {
    attempts?: number;
    retryDelayMs?: number;
}

export class HostLockBusyError extends Error {
    readonly owner: IHostLockOwner | null;

    constructor(lockDirectory: string, owner: IHostLockOwner | null) {
        super(owner === null
            ? `Windows test host lock ${lockDirectory} is held by another process.`
            : `Windows test host lock ${lockDirectory} is held by pid ${owner.pid} on ${owner.hostId} since ${owner.acquiredAt}.`);
        this.name = 'HostLockBusyError';
        this.owner = owner;
    }
}

/**
 * A competitor that created the directory a moment ago may not have renamed
 * its owner file into place yet; a directory this young without an owner is
 * treated as held rather than stale.
 */
const OWNER_FILE_GRACE_MS = 5_000;

function ownerFile(lockDirectory: string) {
    return path.join(lockDirectory, 'owner.json');
}

async function writeOwnerFile(lockDirectory: string, owner: IHostLockOwner) {
    const target = ownerFile(lockDirectory);
    const staging = `${target}.${owner.pid}.tmp`;
    await writeFile(staging, `${JSON.stringify(owner, null, 4)}\n`, 'utf8');
    await rename(staging, target);
}

async function lockDirectoryAgeMs(lockDirectory: string) {
    const stats = await stat(lockDirectory).catch(() => null);
    return stats === null ? Number.POSITIVE_INFINITY : Date.now() - stats.mtimeMs;
}

export function isHostLockOwner(value: unknown): value is IHostLockOwner {
    return isRecord(value)
        && typeof value.hostId === 'string'
        && typeof value.pid === 'number'
        && Number.isInteger(value.pid)
        && typeof value.startTime === 'string'
        && typeof value.acquiredAt === 'string';
}

export async function readHostLockOwner(lockDirectory: string): Promise<IHostLockOwner | null> {
    const file = ownerFile(lockDirectory);
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Cannot read the host lock owner ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`The host lock owner ${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); inspect and remove it by hand.`);
    }
    if (!isHostLockOwner(parsed)) {
        throw new Error(`The host lock owner ${file} does not match the owner schema; inspect and remove it by hand.`);
    }
    return parsed;
}

async function tryCreateLockDirectory(lockDirectory: string) {
    try {
        await mkdir(lockDirectory);
        return true;
    } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
        if (code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

export async function acquireHostLock(
    lockDirectory: string,
    dependencies: IHostLockDependencies,
    options: IHostLockOptions = {},
): Promise<IHostLockHandle> {
    const attempts = options.attempts ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 100;
    await mkdir(path.dirname(lockDirectory), {recursive: true});

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await tryCreateLockDirectory(lockDirectory)) {
            const startTime = await dependencies.probe.startTime(dependencies.pid);
            if (startTime === null) {
                await rm(lockDirectory, {
                    force: true,
                    recursive: true,
                });
                throw new Error(`Cannot record the host lock owner: the start time of pid ${dependencies.pid} is unavailable.`);
            }
            const owner: IHostLockOwner = {
                hostId: dependencies.hostId,
                pid: dependencies.pid,
                startTime,
                acquiredAt: dependencies.nowIso(),
            };
            await writeOwnerFile(lockDirectory, owner);
            return {
                lockDirectory,
                owner,
                release: async () => {
                    await rm(lockDirectory, {
                        force: true,
                        recursive: true,
                    });
                },
            };
        }

        const existing = await readHostLockOwner(lockDirectory);
        if (existing === null && await lockDirectoryAgeMs(lockDirectory) < OWNER_FILE_GRACE_MS) {
            if (attempt + 1 < attempts) {
                await dependencies.sleep(retryDelayMs);
                continue;
            }
            throw new HostLockBusyError(lockDirectory, null);
        }
        const stale = existing === null || !ownershipMatches({
            alive: dependencies.probe.isAlive(existing.pid),
            observedStartTime: await dependencies.probe.startTime(existing.pid),
        }, existing.startTime);
        if (stale) {
            await rm(lockDirectory, {
                force: true,
                recursive: true,
            });
            continue;
        }
        if (attempt + 1 < attempts) {
            await dependencies.sleep(retryDelayMs);
            continue;
        }
        throw new HostLockBusyError(lockDirectory, existing);
    }

    throw new HostLockBusyError(lockDirectory, await readHostLockOwner(lockDirectory));
}

export async function withHostLock<T>(
    lockDirectory: string,
    dependencies: IHostLockDependencies,
    action: (handle: IHostLockHandle) => Promise<T>,
    options: IHostLockOptions = {},
) {
    const handle = await acquireHostLock(lockDirectory, dependencies, options);
    try {
        return await action(handle);
    } finally {
        await handle.release();
    }
}
