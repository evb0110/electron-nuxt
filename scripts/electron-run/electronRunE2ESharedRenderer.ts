import { startNuxtServer } from '@scripts/electron-run/electronRunNuxtServer';
import {
    getNuxtPort,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    getCurrentSessionName,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    buildStrictE2ERunEnv,
    getE2ERunId,
} from '@scripts/electron-run/electronRunRunId';

const TRUTHY_ENV_VALUES = new Set([
    '1',
    'true',
    'yes',
    'on',
]);

export const E2E_SHARED_RENDERER_ENABLED_ENV = 'EVB_E2E_SHARED_RENDERER';
export const E2E_SHARED_RENDERER_PORT_ENV = 'EVB_E2E_SHARED_RENDERER_PORT';

export interface IE2ESharedRendererConfig { port: number; }

function isTruthyEnvValue(value: string | undefined) {
    return value ? TRUTHY_ENV_VALUES.has(value.trim().toLowerCase()) : false;
}

function parsePort(value: string | undefined) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function readE2ESharedRendererConfig(env: NodeJS.ProcessEnv = process.env): IE2ESharedRendererConfig | null {
    if (!isTruthyEnvValue(env[E2E_SHARED_RENDERER_ENABLED_ENV])) {
        return null;
    }

    const port = parsePort(env[E2E_SHARED_RENDERER_PORT_ENV]);
    if (port === null) {
        throw new Error(`${E2E_SHARED_RENDERER_ENABLED_ENV}=1 requires a valid ${E2E_SHARED_RENDERER_PORT_ENV}`);
    }

    return { port };
}

export function applyE2ESharedRendererPort(env: NodeJS.ProcessEnv = process.env) {
    const config = readE2ESharedRendererConfig(env);
    if (!config) {
        return null;
    }

    setNuxtPort(config.port);
    return config;
}

export function buildE2ESharedRendererEnv(port: number): NodeJS.ProcessEnv {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`Cannot build Electron E2E shared renderer env for invalid port: ${port}`);
    }

    return {
        ...buildStrictE2ERunEnv(process.env),
        [E2E_SHARED_RENDERER_ENABLED_ENV]: '1',
        [E2E_SHARED_RENDERER_PORT_ENV]: String(port),
    };
}

export function getE2ESharedRendererSessionName(env: NodeJS.ProcessEnv = process.env) {
    return `e2e-${getE2ERunId(env)}-shared-renderer`;
}

/** Own one renderer server while each scenario keeps its separate Electron process and profile. */
export async function startE2ESharedRenderer() {
    const previousEnv = {...process.env};
    const previousSessionName = getCurrentSessionName();
    const previousPort = getNuxtPort();
    const strictEnv = buildStrictE2ERunEnv(process.env);
    const ownedEnvKeys = [
        ...Object.keys(strictEnv),
        E2E_SHARED_RENDERER_ENABLED_ENV,
        E2E_SHARED_RENDERER_PORT_ENV,
    ];
    const sessionName = getE2ESharedRendererSessionName();
    Object.assign(process.env, strictEnv);
    setCurrentSessionName(sessionName);
    function restoreEnvironment() {
        for (const key of ownedEnvKeys) {
            if (previousEnv[key] === undefined) {
                Reflect.deleteProperty(process.env, key);
            } else {
                process.env[key] = previousEnv[key];
            }
        }
        setNuxtPort(previousPort);
    }
    try {
        const renderer = await startNuxtServer(false);
        const port = getNuxtPort();
        Object.assign(process.env, buildE2ESharedRendererEnv(port));
        let stopPromise: Promise<void> | null = null;
        return {
            sessionName,
            port,
            stop() {
                stopPromise ??= (async () => {
                    try {
                        if (renderer?.pid && isProcessAlive(renderer.pid)) {
                            await killProcessTree(renderer.pid, 1200);
                        }
                    } finally {
                        restoreEnvironment();
                    }
                })();
                return stopPromise;
            },
        };
    } catch (error) {
        restoreEnvironment();
        throw error;
    } finally {
        setCurrentSessionName(previousSessionName);
    }
}
