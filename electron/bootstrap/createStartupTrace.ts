import type { ILogger } from '@electron/utils/createLogger';
import { randomUUID } from 'node:crypto';

export function createStartupTrace(logger: ILogger) {
    const startupStartedAt = Date.now();
    const startupSessionId = `${startupStartedAt}-${randomUUID()}`;
    const enabled = process.env.EVB_STARTUP_TRACE === '1';

    function log(phase: string) {
        if (!enabled) {
            return;
        }

        const now = Date.now();
        const elapsedMs = now - startupStartedAt;
        const message = `[startup] ${phase} (+${elapsedMs}ms)`;
        logger.info(message);
        console.info(`[${new Date(now).toISOString()}] [main] ${message}`, {
            startupSessionId,
            elapsedMs,
        });
    }

    return {
        enabled,
        log,
    };
}
