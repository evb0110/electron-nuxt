import { session } from 'electron';
import {
    startServer,
    stopServer,
    waitForServer,
} from '@electron/server';
import { setupContentSecurityPolicy } from '@electron/security/csp';
import { getErrorMessage } from '@electron/utils/error';

interface ILogger {warn(message: string): void;}

interface ICreateWindowRuntimeOptions {
    isDev: boolean;
    logger: ILogger;
    logWindowStartup: (phase: string, details?: Record<string, unknown>) => void;
}

export function createWindowRuntime(options: ICreateWindowRuntimeOptions) {
    let serverReadyPromise: Promise<void> | null = null;
    let isDevCacheCleared = false;
    let isCspConfigured = false;

    return {
        async ensureReady() {
            const runtimeStart = Date.now();
            if (!isCspConfigured) {
                isCspConfigured = true;
                setupContentSecurityPolicy();
            }

            if (options.isDev && !isDevCacheCleared) {
                isDevCacheCleared = true;
                try {
                    await session.defaultSession.clearCache();
                } catch (err) {
                    options.logger.warn(`Failed to clear HTTP cache: ${getErrorMessage(err)}`);
                }
            }

            for (let attempt = 1; attempt <= 2; attempt += 1) {
                if (!serverReadyPromise) {
                    const pendingServerReady = (async () => {
                        const serverBootStart = Date.now();
                        options.logWindowStartup('Ensuring Nuxt runtime server is ready');
                        await startServer();
                        options.logWindowStartup(`Nuxt runtime process ensured (step +${Date.now() - serverBootStart}ms)`);
                    })();
                    serverReadyPromise = pendingServerReady.catch((error) => {
                        serverReadyPromise = null;
                        throw error;
                    });
                }

                try {
                    await serverReadyPromise;
                    await waitForServer();
                    options.logWindowStartup(`Nuxt runtime server is healthy (step +${Date.now() - runtimeStart}ms)`);
                    options.logWindowStartup(`Window runtime ready (step +${Date.now() - runtimeStart}ms)`);
                    return;
                } catch (error) {
                    serverReadyPromise = null;
                    if (attempt >= 2) {
                        throw error;
                    }

                    options.logger.warn(
                        `Runtime server health check failed; restarting before retry: ${
                            getErrorMessage(error)
                        }`,
                    );
                    await stopServer();
                }
            }
        },
        resetServerPromise() {
            serverReadyPromise = null;
        },
    };
}
