import type { ChildProcess } from 'node:child_process';
import { pruneStaleE2ESessions } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { buildE2ESharedRendererEnv } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { startNuxtServer } from '@scripts/electron-run/electronRunNuxtServer';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    getCurrentSessionName,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

const SHARED_RENDERER_SESSION_NAME = 'e2e-shared-renderer';

export default async function setup() {
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
    setCurrentSessionName(SHARED_RENDERER_SESSION_NAME);

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
