import {
    readdirSync,
    rmSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    getSessionInfo,
    getSessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {
    inspectProcessIdentity,
    killVerifiedSessionProcess,
    matchesSessionProcessIdentity,
    type ISessionProcessIdentityExpectation,
} from '@scripts/electron-run/electronRunProcessIdentity';
import {
    sessionDir,
    sessionsBaseDir,
} from '@scripts/electron-run/electronRunSessionPaths';

const DEFAULT_STALE_E2E_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
const PROCESS_STOP_GRACE_MS = 1_200;

export interface IE2ESessionDirCandidate {
    name: string;
    path: string;
    mtimeMs: number;
}

export interface IStaleE2ESessionPruneResult {
    stale: string[];
    removed: string[];
    refused: Array<{
        name: string;
        reason: string;
    }>;
}

interface ISelectStaleE2ESessionsOptions {
    nowMs?: number;
    maxAgeMs?: number;
}

export function isE2ESessionName(name: string) {
    return name.startsWith('e2e-');
}

export function selectStaleE2ESessionDirs(
    candidates: IE2ESessionDirCandidate[],
    options: ISelectStaleE2ESessionsOptions = {},
) {
    const nowMs = options.nowMs ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_E2E_SESSION_AGE_MS;
    return candidates
        .filter(candidate => isE2ESessionName(candidate.name))
        .filter(candidate => nowMs - candidate.mtimeMs > maxAgeMs)
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function listE2ESessionDirCandidates(): IE2ESessionDirCandidate[] {
    try {
        return readdirSync(sessionsBaseDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && isE2ESessionName(entry.name))
            .map(entry => {
                const path = join(sessionsBaseDir, entry.name);
                return {
                    name: entry.name,
                    path,
                    mtimeMs: statSync(path).mtimeMs,
                };
            });
    } catch {
        return [];
    }
}

async function stopLiveMetadataProcesses(name: string) {
    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);
    const candidates: Array<{
        pid: number | null | undefined;
        expectation: ISessionProcessIdentityExpectation;
    }> = [
        {
            pid: info?.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
        },
        {
            pid: starting?.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
        },
        {
            pid: info?.electronPid,
            expectation: {
                kind: 'electron',
                sessionName: name,
                cdpPort: info?.cdpPort,
            },
        },
        {
            pid: info?.nuxtPid ?? starting?.nuxtPid,
            expectation: {
                kind: 'nuxt',
                sessionName: name,
                nuxtPort: info?.nuxtPort ?? starting?.nuxtPort,
            },
        },
    ];
    for (const electronPid of starting?.electronPids ?? []) {
        const cdpPorts = starting?.cdpPorts.length ? starting.cdpPorts : [null];
        for (const cdpPort of cdpPorts) {
            candidates.push({
                pid: electronPid,
                expectation: {
                    kind: 'electron',
                    sessionName: name,
                    cdpPort,
                    electronUserDataDir: starting?.electronUserDataDir,
                },
            });
        }
    }
    const verifiedOwnedPids = new Set<number>();
    for (const candidate of candidates) {
        const pid = candidate.pid;
        if (!pid || pid === process.pid || pid === process.ppid || !isProcessAlive(pid)) {
            continue;
        }
        const snapshot = inspectProcessIdentity(
            pid,
            candidate.expectation.kind === 'nuxt' ? candidate.expectation.nuxtPort : null,
        );
        if (!snapshot || !matchesSessionProcessIdentity(snapshot, candidate.expectation)) {
            console.warn(`[Session '${name}'] Ignoring stale metadata PID ${pid}: process identity was reused or unrelated.`);
            continue;
        }
        verifiedOwnedPids.add(pid);
        await killVerifiedSessionProcess({
            pid,
            expectation: candidate.expectation,
            graceMs: PROCESS_STOP_GRACE_MS,
        });
    }

    return [...verifiedOwnedPids].filter(pid => isProcessAlive(pid));
}

export async function pruneStaleE2ESessions(options: ISelectStaleE2ESessionsOptions = {}): Promise<IStaleE2ESessionPruneResult> {
    const stale = selectStaleE2ESessionDirs(listE2ESessionDirCandidates(), options);
    const result: IStaleE2ESessionPruneResult = {
        stale: stale.map(candidate => candidate.name),
        removed: [],
        refused: [],
    };

    for (const candidate of stale) {
        const remainingLivePids = await stopLiveMetadataProcesses(candidate.name);
        if (remainingLivePids.length > 0) {
            result.refused.push({
                name: candidate.name,
                reason: `metadata process(es) still alive after stop: ${remainingLivePids.join(', ')}`,
            });
            continue;
        }

        try {
            rmSync(sessionDir(candidate.name), {
                recursive: true,
                force: true,
            });
            result.removed.push(candidate.name);
        } catch (error) {
            result.refused.push({
                name: candidate.name,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return result;
}
