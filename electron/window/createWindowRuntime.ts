import { session } from 'electron';
import { setupContentSecurityPolicy } from '@electron/security/csp';
import { getErrorMessage } from '@electron/utils/error';

interface ILogger {warn(message: string): void;}

interface ICreateWindowRuntimeOptions {
    isDev: boolean;
    logger: ILogger;
    logWindowStartup: (phase: string, details?: Record<string, unknown>) => void;
}

function shouldClearDevHttpCache() {
    return process.env.EVB_CLEAR_RENDERER_CACHE === '1';
}

export function createWindowRuntime(options: ICreateWindowRuntimeOptions) {
    let isDevCacheCleared = false;
    let isCspConfigured = false;

    async function ensureReady() {
        const runtimeStart = Date.now();
        if (!isCspConfigured) {
            isCspConfigured = true;
            setupContentSecurityPolicy();
        }

        if (options.isDev && shouldClearDevHttpCache() && !isDevCacheCleared) {
            isDevCacheCleared = true;
            try {
                await session.defaultSession.clearCache();
            } catch (err) {
                options.logger.warn(`Failed to clear HTTP cache: ${getErrorMessage(err)}`);
            }
        } else if (options.isDev && !shouldClearDevHttpCache()) {
            options.logWindowStartup('Dev HTTP cache clear skipped; set EVB_CLEAR_RENDERER_CACHE=1 to force it');
        }

        options.logWindowStartup(`Window runtime ready (step +${Date.now() - runtimeStart}ms)`);
    }

    return {ensureReady};
}
