import type { ChildProcess } from 'node:child_process';
import { delay } from 'es-toolkit/promise';
import { pruneStaleE2ESessions } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { buildE2ESharedRendererEnv } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import {
    getElectronAppUrl,
    startNuxtServer,
} from '@scripts/electron-run/electronRunNuxtServer';
import { isReusableNuxtResponse } from '@scripts/electron-run/isReusableNuxtResponse';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    getCurrentSessionName,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

const SHARED_RENDERER_SESSION_NAME = 'e2e-shared-renderer';
const SHARED_RENDERER_WARMUP_TIMEOUT_MS = 60_000;
const SHARED_RENDERER_WARMUP_REQUEST_TIMEOUT_MS = 2_000;
const SHARED_RENDERER_WARMUP_STABLE_POLLS = 2;
const DYNAMIC_IMPORT_FAILURE_MARKER = 'Failed to fetch dynamically imported module';

async function sampleSharedRenderer() {
    try {
        const res = await fetch(getElectronAppUrl(), {
            method: 'GET',
            signal: AbortSignal.timeout(SHARED_RENDERER_WARMUP_REQUEST_TIMEOUT_MS),
        });
        const body = await res.text();
        return {
            ok: res.status === 200
                && isReusableNuxtResponse({
                    poweredBy: res.headers.get('x-powered-by'),
                    body,
                })
                && !body.includes(DYNAMIC_IMPORT_FAILURE_MARKER),
            status: res.status,
            bodySnippet: body.trim().replace(/\s+/g, ' ').slice(0, 180),
        };
    } catch (error) {
        return {
            ok: false,
            status: null,
            bodySnippet: error instanceof Error ? error.message : String(error),
        };
    }
}

async function warmSharedRenderer() {
    const start = Date.now();
    let stablePolls = 0;
    let lastSample: Awaited<ReturnType<typeof sampleSharedRenderer>> | null = null;

    while (Date.now() - start < SHARED_RENDERER_WARMUP_TIMEOUT_MS) {
        lastSample = await sampleSharedRenderer();
        if (lastSample.ok) {
            stablePolls += 1;
            if (stablePolls >= SHARED_RENDERER_WARMUP_STABLE_POLLS) {
                return;
            }
        } else {
            stablePolls = 0;
        }
        await delay(500);
    }

    throw new Error(
        `Shared Electron E2E renderer did not warm within ${Math.round(SHARED_RENDERER_WARMUP_TIMEOUT_MS / 1000)}s`
        + ` (last status=${lastSample?.status ?? 'unknown'}, body="${lastSample?.bodySnippet ?? ''}")`,
    );
}

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
        await warmSharedRenderer();
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
