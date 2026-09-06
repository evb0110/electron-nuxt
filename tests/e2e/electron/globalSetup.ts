import { rmSync } from 'node:fs';
import { pruneStaleE2ESessions } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { startE2ESharedRenderer } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { buildStrictE2ERunEnv } from '@scripts/electron-run/electronRunRunId';
import { sessionDir } from '@scripts/electron-run/electronRunSessionPaths';

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

    const renderer = await startE2ESharedRenderer();
    console.log(`[E2E setup] Isolated shared renderer '${renderer.sessionName}' ready at http://127.0.0.1:${renderer.port}/electron`);

    return async () => {
        await renderer.stop();
        rmSync(sessionDir(renderer.sessionName), {
            recursive: true,
            force: true,
        });
    };
}
