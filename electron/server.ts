import {
    spawn,
    type ChildProcess,
} from 'child_process';
import { retry } from 'es-toolkit/function';
import {
    delay,
    withTimeout,
} from 'es-toolkit/promise';
import { config } from '@electron/config';
import {
    SERVER_HEALTH_MAX_ATTEMPTS,
    SERVER_HEALTH_RETRY_MS,
    SERVER_POLL_INTERVAL_MS,
    SERVER_READY_TIMEOUT_MS,
} from '@electron/config/constants';
import {
    clearOwnershipMarker as clearOwnershipMarkerFile,
    readOwnershipMarker,
    writeOwnershipMarker as writeOwnershipMarkerFile,
    type IServerOwnershipMarker,
} from '@electron/server/ownership';
import { readProcessCommandLine } from '@electron/server/process-command';
import { reserveLocalPort } from '@electron/server/ports';
import {
    isServerRunning as checkServerRunning,
    isTrustedRuntimeServer as checkTrustedRuntimeServer,
} from '@electron/server/health';
import { createLogger } from '@electron/utils/logger';
import { terminateProcessTree } from '@electron/utils/process-tree';
import { getErrorMessage } from '@electron/utils/error';
import { isTimeoutError } from '@contracts/timeout-error';

const logger = createLogger('server');

let nuxtProcess: ChildProcess | null = null;
let serverReady: Promise<void> | null = null;
let usingExternalServer = false;
let stoppingServerPromise: Promise<void> | null = null;
const HAS_FIXED_SERVER_PORT = Boolean(process.env.EVB_SERVER_PORT?.trim());
const WAIT_FOR_EXTERNAL_DEV_SERVER = process.env.EVB_WAIT_FOR_EXTERNAL_DEV_SERVER === '1';
function parseIntegerEnv(
    rawValue: string | undefined,
    {
        fallback,
        min,
        max,
    }: {
        fallback: number;
        min: number;
        max?: number;
    },
) {
    const normalized = rawValue?.trim();
    if (!normalized) {
        return fallback;
    }
    if (!/^\d+(?:_\d+)*$/.test(normalized)) {
        return fallback;
    }

    const parsed = Number.parseInt(normalized.replaceAll('_', ''), 10);
    if (!Number.isFinite(parsed) || parsed < min) {
        return fallback;
    }

    if (typeof max === 'number') {
        return Math.min(parsed, max);
    }

    return parsed;
}
const SERVER_ISOLATED_PORT_RETRIES = (() => {
    return parseIntegerEnv(process.env.EVB_SERVER_ISOLATED_PORT_RETRIES, {
        fallback: 8,
        min: 1,
    });
})();
const SERVER_HEALTH_FETCH_TIMEOUT_MS = (() => {
    return parseIntegerEnv(process.env.EVB_SERVER_HEALTH_FETCH_TIMEOUT_MS, {
        fallback: 4_000,
        min: 500,
    });
})();
const SERVER_STOP_GRACE_MS = (() => {
    return parseIntegerEnv(process.env.EVB_SERVER_STOP_GRACE_MS, {
        fallback: 2_500,
        min: 500,
    });
})();

function writeOwnershipMarker(pid: number) {
    writeOwnershipMarkerFile(pid, {
        entryPath: config.server.entryPath,
        port: config.server.port,
    }, message => logger.warn(message));
}

function clearOwnershipMarker() {
    clearOwnershipMarkerFile(message => logger.warn(message));
}

async function isServerRunning() {
    return checkServerRunning(config.server.url, SERVER_HEALTH_FETCH_TIMEOUT_MS);
}

async function isTrustedRuntimeServer() {
    return checkTrustedRuntimeServer(config.server.url, SERVER_HEALTH_FETCH_TIMEOUT_MS);
}

export function shouldWaitForExternalDevServer(options: {
    isDev?: boolean;
    hasFixedServerPort?: boolean;
    waitForExternalDevServer?: boolean;
} = {}) {
    return (options.isDev ?? config.isDev)
        && (options.hasFixedServerPort ?? HAS_FIXED_SERVER_PORT)
        && (options.waitForExternalDevServer ?? WAIT_FOR_EXTERNAL_DEV_SERVER);
}

async function waitForExternalDevServer(startTime: number) {
    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await isServerRunning() && await isTrustedRuntimeServer()) {
            logger.info(`Using externally managed Nuxt dev server (+${Date.now() - startTime}ms)`);
            usingExternalServer = true;
            serverReady = Promise.resolve();
            return;
        }
        await delay(SERVER_POLL_INTERVAL_MS);
    }

    throw new Error(`External Nuxt dev server did not become ready at ${config.server.url}`);
}

async function configureRuntimeServerPort() {
    if (config.isDev || HAS_FIXED_SERVER_PORT) {
        return;
    }

    for (let attempt = 1; attempt <= SERVER_ISOLATED_PORT_RETRIES; attempt += 1) {
        const candidatePort = await reserveLocalPort();
        config.server.setPort(candidatePort);

        // Packaged builds must only trust servers spawned by this process.
        if (!await isServerRunning()) {
            logger.info(
                `Selected isolated runtime server port ${candidatePort} `
                + `(attempt ${attempt}/${SERVER_ISOLATED_PORT_RETRIES})`,
            );
            return;
        }
    }

    throw new Error('Unable to find an isolated runtime server port');
}

function isOwnedRuntimeServerCommandLine(
    commandLine: string,
    marker: IServerOwnershipMarker,
) {
    return (
        commandLine.length > 0
        && marker.entryPath === config.server.entryPath
        && commandLine.includes(marker.entryPath)
    );
}

async function reclaimOwnedRuntimeServerOrphan() {
    if (config.isDev) {
        return;
    }

    const marker = readOwnershipMarker();
    if (!marker) {
        return;
    }

    if (marker.entryPath !== config.server.entryPath) {
        logger.warn('Discarding stale runtime server ownership marker for a different entry path');
        clearOwnershipMarker();
        return;
    }

    const commandLine = await readProcessCommandLine(marker.pid);
    if (!commandLine) {
        clearOwnershipMarker();
        return;
    }

    if (!isOwnedRuntimeServerCommandLine(commandLine, marker)) {
        logger.warn(`Discarding stale runtime server ownership marker for pid ${marker.pid}; process command line no longer matches`);
        clearOwnershipMarker();
        return;
    }

    logger.warn(
        `Reclaiming orphaned runtime server process pid=${marker.pid}`
        + `${marker.port ? ` port=${marker.port}` : ''}`,
    );
    await terminateProcessTree(marker.pid, {
        graceMs: SERVER_STOP_GRACE_MS,
        preferProcessGroup: process.platform !== 'win32',
    });
    clearOwnershipMarker();
}

export async function startServer() {
    if (stoppingServerPromise) {
        await stoppingServerPromise;
    }

    const startTime = Date.now();
    if (nuxtProcess && nuxtProcess.exitCode !== null) {
        nuxtProcess = null;
        clearOwnershipMarker();
    }

    // If we previously spawned the server, treat it as internal even though it answers on localhost.
    if (nuxtProcess && nuxtProcess.exitCode === null) {
        usingExternalServer = false;
        if (!serverReady) {
            serverReady = Promise.resolve();
        }
        logger.info(`Nuxt server already owned by this process (+${Date.now() - startTime}ms)`);
        return;
    }

    await reclaimOwnedRuntimeServerOrphan();
    await configureRuntimeServerPort();

    const serverRunning = await isServerRunning();
    if (serverRunning) {
        if (config.isDev) {
            const marker = readOwnershipMarker();
            if (marker && marker.entryPath === config.server.entryPath) {
                // Dev sessions may leave stale markers behind during HMR restarts.
                // Never kill marker PIDs unless we spawned them in this process.
                clearOwnershipMarker();
            }
        }
    }

    if (serverRunning) {
        if (config.isDev) {
            if (!await isTrustedRuntimeServer()) {
                clearOwnershipMarker();
                throw new Error(`Refusing to attach to untrusted runtime server at ${config.server.url}`);
            }

            logger.info('Nuxt server already running, connecting...');
            usingExternalServer = true;
            serverReady = Promise.resolve();
            logger.info(`Using existing Nuxt server (+${Date.now() - startTime}ms)`);
            return;
        }

        if (!HAS_FIXED_SERVER_PORT) {
            // A race may bind the selected ephemeral port between probe and spawn.
            // Retry with a fresh isolated port instead of trusting that process.
            await configureRuntimeServerPort();
        } else {
            clearOwnershipMarker();
            throw new Error(`Refusing to attach to pre-existing runtime server at ${config.server.url}`);
        }
    }

    if (shouldWaitForExternalDevServer()) {
        logger.info(`Waiting for externally managed Nuxt dev server at ${config.server.url}...`);
        await waitForExternalDevServer(startTime);
        return;
    }

    logger.info('Starting Nuxt server...');
    usingExternalServer = false;
    // Use definite assignment assertion - resolveReady is guaranteed to be assigned
    // by the Promise constructor before any code that uses it can execute
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    let readySettled = false;
    serverReady = new Promise<void>((resolve, reject) => {
        resolveReady = () => {
            if (readySettled) {
                return;
            }
            readySettled = true;
            resolve();
        };
        rejectReady = (err) => {
            if (readySettled) {
                return;
            }
            readySettled = true;
            reject(err);
        };
    });

    if (config.isDev) {
        const pnpmCommand = process.platform === 'win32'
            ? 'pnpm.cmd'
            : 'pnpm';
        nuxtProcess = spawn(pnpmCommand, [
            'run',
            'dev:nuxt',
        ], {
            shell: false,
            detached: process.platform !== 'win32',
            stdio: [
                'inherit',
                'pipe',
                'inherit',
            ],
        });
    } else {
        nuxtProcess = spawn(process.execPath, [config.server.entryPath], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                EVB_VIEWER_NUXT_INTERNAL: '1',
                PORT: String(config.server.port),
            },
            detached: process.platform !== 'win32',
            stdio: [
                'inherit',
                'pipe',
                'inherit',
            ],
        });
    }

    if (nuxtProcess.pid) {
        writeOwnershipMarker(nuxtProcess.pid);
    }

    nuxtProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        process.stdout.write(output);

        if (output.includes('Local:') || output.includes('Listening')) {
            resolveReady();
        }
    });

    // Fallback: don't rely solely on log output for readiness (Nuxt output format may change).
    void (async () => {
        while (!readySettled && nuxtProcess && nuxtProcess.exitCode === null) {
            if (await isServerRunning()) {
                resolveReady();
                return;
            }
            await delay(SERVER_POLL_INTERVAL_MS);
        }
    })();

    nuxtProcess.on('error', (err) => {
        logger.error(`Failed to start Nuxt server: ${getErrorMessage(err)}`);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
    });

    nuxtProcess.on('exit', (code, signal) => {
        nuxtProcess = null;
        clearOwnershipMarker();

        if (readySettled || usingExternalServer) {
            return;
        }

        rejectReady(new Error(`[Electron] Nuxt process exited before ready (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`));
    });
}

export function waitForServer() {
    if (!serverReady) {
        throw new Error('Server was not started');
    }
    const readyPromise = serverReady;

    const verifyHealth = async () => {
        let attempt = 0;
        try {
            await retry(async () => {
                attempt += 1;
                try {
                    const response = await fetch(config.server.url, {
                        method: 'HEAD',
                        signal: AbortSignal.timeout(SERVER_HEALTH_FETCH_TIMEOUT_MS),
                    });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                } catch (error) {
                    logger.debug(`Server health check attempt ${attempt}/${SERVER_HEALTH_MAX_ATTEMPTS} failed: ${
                        getErrorMessage(error)
                    }`);
                    throw error;
                }
            }, {
                retries: SERVER_HEALTH_MAX_ATTEMPTS,
                delay: (retryAttempt) => (
                    retryAttempt + 1 < SERVER_HEALTH_MAX_ATTEMPTS
                        ? SERVER_HEALTH_RETRY_MS
                        : 0
                ),
            });
            logger.info('Server verified ready');
            return;
        } catch {
            // fall through
        }

        throw new Error('Server stdout detected but HTTP health check failed');
    };

    return (async () => {
        try {
            try {
                await withTimeout(async () => {
                    await readyPromise;
                }, SERVER_READY_TIMEOUT_MS);
            } catch (error) {
                if (isTimeoutError(error)) {
                    throw new Error(`Server failed to start within ${SERVER_READY_TIMEOUT_MS / 1000}s`);
                }
                throw error;
            }
            await verifyHealth();
        } catch (err) {
            if (nuxtProcess && !usingExternalServer) {
                await stopServer();
            }
            if (!usingExternalServer) {
                clearOwnershipMarker();
            }

            throw err;
        }
    })();
}

export async function stopServer() {
    if (stoppingServerPromise) {
        return stoppingServerPromise;
    }

    stoppingServerPromise = (async () => {
        if (nuxtProcess && nuxtProcess.exitCode === null) {
            logger.info('Stopping internally-managed Nuxt server');
            const processToStop = nuxtProcess;
            const pid = processToStop.pid;

            if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
                await terminateProcessTree(pid, {
                    graceMs: SERVER_STOP_GRACE_MS,
                    preferProcessGroup: process.platform !== 'win32',
                });
            } else {
                try {
                    processToStop.kill('SIGTERM');
                } catch {
                    // Ignore if process already exited.
                }
            }

            nuxtProcess = null;
            clearOwnershipMarker();
            return;
        }

        if (!usingExternalServer) {
            clearOwnershipMarker();
        }
    })();

    try {
        await stoppingServerPromise;
    } finally {
        stoppingServerPromise = null;
    }
}
