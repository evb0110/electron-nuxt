import { setNuxtPort } from '@scripts/electron-run/electronRunPortConfig';

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
        [E2E_SHARED_RENDERER_ENABLED_ENV]: '1',
        [E2E_SHARED_RENDERER_PORT_ENV]: String(port),
    };
}
