import type { ChildProcess } from 'node:child_process';
import {
    getSessionInfo,
    getSessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import { pruneStaleE2ESessions } from '@scripts/electron-run/electronRunE2ESessionPrune';
import {
    buildE2ESharedRendererEnv,
    getE2ESharedRendererSessionName,
} from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { startNuxtServer } from '@scripts/electron-run/electronRunNuxtServer';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import type {
    ISessionInfo,
    ISessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionTypes';
import {
    getCurrentSessionName,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

const DEFAULT_DEV_SESSION_NAME = 'default';
const DEFAULT_SESSION_STARTING_MAX_AGE_MS = 5 * 60 * 1000;

type TProcessAliveCheck = (pid: number) => boolean;

export interface ILiveDefaultDevSessionBlocker {
    label: string;
    pid: number;
    source: 'ready' | 'starting';
}

export interface ICollectLiveDefaultDevSessionBlockersOptions {
    isAlive?: TProcessAliveCheck;
    nowMs?: number;
    ownPids?: number[];
    sessionInfo: ISessionInfo | null;
    startingInfo: ISessionStartingInfo | null;
    startingMaxAgeMs?: number;
}

function isPositivePid(value: number | null | undefined): value is number {
    return Number.isInteger(value) && Number(value) > 0;
}

function appendLiveProcessBlocker(
    blockers: ILiveDefaultDevSessionBlocker[],
    seenPids: Set<number>,
    options: {
        isAlive: TProcessAliveCheck;
        label: string;
        ownPids: Set<number>;
        pid: number | null | undefined;
        source: ILiveDefaultDevSessionBlocker['source'];
    },
) {
    if (
        !isPositivePid(options.pid)
        || options.ownPids.has(options.pid)
        || seenPids.has(options.pid)
        || !options.isAlive(options.pid)
    ) {
        return;
    }

    seenPids.add(options.pid);
    blockers.push({
        label: options.label,
        pid: options.pid,
        source: options.source,
    });
}

export function collectLiveDefaultDevSessionBlockers(
    options: ICollectLiveDefaultDevSessionBlockersOptions,
): ILiveDefaultDevSessionBlocker[] {
    const blockers: ILiveDefaultDevSessionBlocker[] = [];
    const seenPids = new Set<number>();
    const ownPids = new Set(options.ownPids ?? [
        process.pid,
        process.ppid,
    ]);
    const isAlive = options.isAlive ?? isProcessAlive;

    appendLiveProcessBlocker(blockers, seenPids, {
        isAlive,
        label: 'session manager',
        ownPids,
        pid: options.sessionInfo?.pid,
        source: 'ready',
    });
    appendLiveProcessBlocker(blockers, seenPids, {
        isAlive,
        label: 'Electron app',
        ownPids,
        pid: options.sessionInfo?.electronPid,
        source: 'ready',
    });
    appendLiveProcessBlocker(blockers, seenPids, {
        isAlive,
        label: 'Nuxt dev server',
        ownPids,
        pid: options.sessionInfo?.nuxtPid,
        source: 'ready',
    });

    if (options.startingInfo) {
        const nowMs = options.nowMs ?? Date.now();
        const maxAgeMs = options.startingMaxAgeMs ?? DEFAULT_SESSION_STARTING_MAX_AGE_MS;
        if (nowMs - options.startingInfo.startedAt <= maxAgeMs) {
            appendLiveProcessBlocker(blockers, seenPids, {
                isAlive,
                label: 'starting session manager',
                ownPids,
                pid: options.startingInfo.pid,
                source: 'starting',
            });
            for (const electronPid of options.startingInfo.electronPids) {
                appendLiveProcessBlocker(blockers, seenPids, {
                    isAlive,
                    label: 'starting Electron app',
                    ownPids,
                    pid: electronPid,
                    source: 'starting',
                });
            }
            appendLiveProcessBlocker(blockers, seenPids, {
                isAlive,
                label: 'starting Nuxt dev server',
                ownPids,
                pid: options.startingInfo.nuxtPid,
                source: 'starting',
            });
        }
    }

    return blockers;
}

export function formatLiveDefaultDevSessionError(blockers: ILiveDefaultDevSessionBlocker[]) {
    const detected = blockers
        .map(blocker => `- ${blocker.label} pid ${blocker.pid} (${blocker.source})`)
        .join('\n');
    return [
        `[E2E setup] Live Electron dev session '${DEFAULT_DEV_SESSION_NAME}' in this checkout can interfere with deterministic Electron E2E runs.`,
        detected ? `Detected:\n${detected}` : 'Detected live default-session metadata.',
        `Stop it first with: pnpm electron:run stop --session=${DEFAULT_DEV_SESSION_NAME}`,
        'Alternatively, run Electron E2E from a separate git worktree without a live default session.',
    ].join('\n');
}

function assertNoLiveDefaultDevSessionCanInterfere() {
    const blockers = collectLiveDefaultDevSessionBlockers({
        sessionInfo: getSessionInfo(DEFAULT_DEV_SESSION_NAME),
        startingInfo: getSessionStartingInfo(DEFAULT_DEV_SESSION_NAME),
    });

    if (blockers.length > 0) {
        throw new Error(formatLiveDefaultDevSessionError(blockers));
    }
}

export default async function setup() {
    assertNoLiveDefaultDevSessionCanInterfere();

    const result = await pruneStaleE2ESessions();
    if (result.stale.length === 0) {
        console.log('[E2E setup] No stale e2e sessions found.');
    } else {
        console.log([
            `[E2E setup] Stale e2e sessions: ${result.stale.length}`,
            `[E2E setup] Removed: ${result.removed.length > 0 ? result.removed.join(', ') : 'none'}`,
            `[E2E setup] Refused: ${result.refused.length > 0
                ? result.refused.map(entry => `${entry.name} (${entry.reason})`).join(', ')
                : 'none'}`,
        ].join('\n'));
    }

    const previousSessionName = getCurrentSessionName();
    const sharedRendererSessionName = getE2ESharedRendererSessionName(process.env);
    setCurrentSessionName(sharedRendererSessionName);

    let sharedRendererProcess: ChildProcess | null = null;
    try {
        sharedRendererProcess = await startNuxtServer(false);
        const sharedRendererPort = getNuxtPort();
        Object.assign(process.env, buildE2ESharedRendererEnv(sharedRendererPort));
        console.log(`[E2E setup] Shared renderer ready on http://127.0.0.1:${sharedRendererPort}/electron`);
    } finally {
        setCurrentSessionName(previousSessionName);
    }

    return async () => {
        if (!sharedRendererProcess) {
            return;
        }

        const pid = sharedRendererProcess.pid ?? null;
        if (!pid || !isProcessAlive(pid)) {
            return;
        }

        await killProcessTree(pid, 1200);
        console.log(`[E2E teardown] Stopped shared renderer process ${pid}`);
    };
}
