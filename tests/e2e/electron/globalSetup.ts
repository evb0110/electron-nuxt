import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pruneStaleE2ESessions } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { buildE2ESharedRendererEnv } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { startNuxtServer } from '@scripts/electron-run/electronRunNuxtServer';
import { buildStrictE2ERunEnv } from '@scripts/electron-run/electronRunRunId';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    getCurrentSessionName,
    sessionDir,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import { resolveE2EGlobalSetupSessionName } from '@tests/e2e/electron/resolveE2EGlobalSetupSessionName';

export default async function setup() {
    Object.assign(process.env, buildStrictE2ERunEnv(process.env));

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
    const sharedRendererSessionName = resolveE2EGlobalSetupSessionName(process.env);
    setCurrentSessionName(sharedRendererSessionName);

    let sharedRendererProcess: ChildProcess | null = null;
    try {
        sharedRendererProcess = await startNuxtServer(false);
        const sharedRendererPort = getNuxtPort();
        Object.assign(process.env, buildE2ESharedRendererEnv(sharedRendererPort));
        console.log([
            `[E2E setup] Isolated shared renderer '${sharedRendererSessionName}' ready`,
            `http://127.0.0.1:${sharedRendererPort}/electron`,
        ].join(' at '));
    } catch (error) {
        const pid = sharedRendererProcess?.pid ?? null;
        if (pid && isProcessAlive(pid)) {
            await killProcessTree(pid, 1200);
        }
        throw error;
    } finally {
        setCurrentSessionName(previousSessionName);
    }

    return async () => {
        const pid = sharedRendererProcess?.pid ?? null;
        if (pid && isProcessAlive(pid)) {
            await killProcessTree(pid, 1200);
            console.log(`[E2E teardown] Stopped shared renderer process ${pid}`);
        }
        rmSync(sessionDir(sharedRendererSessionName), {
            recursive: true,
            force: true,
        });
    };
}
