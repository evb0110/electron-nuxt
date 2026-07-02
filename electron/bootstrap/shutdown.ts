import type { ILogger } from '@electron/utils/createLogger';
import { withTimeout } from 'es-toolkit/promise';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

const SHUTDOWN_TOTAL_TIMEOUT_MS = parseIntegerEnv('EVB_SHUTDOWN_TIMEOUT_MS', 20_000, 3_000);
const SHUTDOWN_STEP_TIMEOUT_MS = parseIntegerEnv('EVB_SHUTDOWN_STEP_TIMEOUT_MS', 8_000, 1_000, SHUTDOWN_TOTAL_TIMEOUT_MS);
const GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS = parseIntegerEnv('EVB_GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS', 3_000, 0);

interface IAppLike {
    exit(code: number): void;
    quit(): void;
}

interface IShutdownStep {
    label: string;
    run: () => Promise<void> | void;
}

interface ICreateShutdownCoordinatorOptions {
    app: IAppLike;
    logger: ILogger;
    runCleanupSteps: () => Promise<void>;
}

interface IGracefulQuitOptions { afterCleanup?: () => void }

export function runShutdownSteps(
    logger: ILogger,
    steps: IShutdownStep[],
) {
    return withTimeout(async () => {
        for (const step of steps) {
            try {
                await withTimeout(async () => {
                    await step.run();
                }, SHUTDOWN_STEP_TIMEOUT_MS);
            } catch (error) {
                const timeout = isTimeoutError(error);
                logger.error(
                    timeout
                        ? `Shutdown step timed out (${step.label}, ${SHUTDOWN_STEP_TIMEOUT_MS}ms)`
                        : `Shutdown step failed (${step.label}): ${getErrorMessage(error)}`,
                );
            }
        }
    }, SHUTDOWN_TOTAL_TIMEOUT_MS);
}

export function createShutdownCoordinator(options: ICreateShutdownCoordinatorOptions) {
    let gracefulShutdownPromise: Promise<void> | null = null;
    let gracefulQuitForceTimer: NodeJS.Timeout | null = null;
    let gracefulQuitAfterCleanup: (() => void) | null = null;
    let isQuittingAfterCleanup = false;
    let isFatalShutdownInProgress = false;

    function clearGracefulQuitForceTimer() {
        if (!gracefulQuitForceTimer) {
            return;
        }
        clearTimeout(gracefulQuitForceTimer);
        gracefulQuitForceTimer = null;
    }

    async function performCleanup() {
        try {
            await options.runCleanupSteps();
        } catch (error) {
            if (isTimeoutError(error)) {
                options.logger.error(`Global shutdown cleanup timed out after ${SHUTDOWN_TOTAL_TIMEOUT_MS}ms`);
                return;
            }
            options.logger.error(`Global shutdown cleanup failed: ${getErrorMessage(error)}`);
        }
    }

    return {
        clearGracefulQuitForceTimer,
        isFatalShutdownInProgress: () => isFatalShutdownInProgress,
        isQuittingAfterCleanup: () => isQuittingAfterCleanup,
        async performCleanup() {
            await performCleanup();
        },
        requestFatalShutdown(reason: string, exitCode = 1) {
            if (isFatalShutdownInProgress) {
                return;
            }

            isFatalShutdownInProgress = true;
            options.logger.error(reason);
            void (async () => {
                try {
                    await performCleanup();
                } finally {
                    options.app.exit(exitCode);
                }
            })();
        },
        requestGracefulQuit(quitOptions?: IGracefulQuitOptions) {
            if (isQuittingAfterCleanup) {
                return;
            }
            if (quitOptions?.afterCleanup) {
                gracefulQuitAfterCleanup = quitOptions.afterCleanup;
            }
            gracefulShutdownPromise ??= performCleanup().catch((error) => {
                options.logger.error(`Graceful shutdown cleanup failed: ${getErrorMessage(error)}`);
            });

            if (!gracefulQuitForceTimer) {
                gracefulQuitForceTimer = setTimeout(() => {
                    options.logger.error(`Graceful quit exceeded deadline (${SHUTDOWN_TOTAL_TIMEOUT_MS + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS}ms); forcing exit`);
                    isQuittingAfterCleanup = true;
                    options.app.exit(1);
                }, SHUTDOWN_TOTAL_TIMEOUT_MS + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS);
                gracefulQuitForceTimer.unref?.();
            }

            void gracefulShutdownPromise.then(() => {
                clearGracefulQuitForceTimer();
                if (isQuittingAfterCleanup) {
                    return;
                }
                isQuittingAfterCleanup = true;
                const afterCleanup = gracefulQuitAfterCleanup;
                gracefulQuitAfterCleanup = null;
                if (afterCleanup) {
                    try {
                        afterCleanup();
                    } catch (error) {
                        options.logger.error(`Graceful quit post-cleanup action failed: ${getErrorMessage(error)}`);
                        options.app.quit();
                    }
                    return;
                }
                options.app.quit();
            });
        },
    };
}
