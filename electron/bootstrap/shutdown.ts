import { withTimeout } from 'es-toolkit/promise';

function parseIntEnv(name: string, fallback: number, minimum: number, maximum?: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    if (typeof maximum === 'number') {
        return Math.min(parsed, maximum);
    }
    return parsed;
}

export const SHUTDOWN_TOTAL_TIMEOUT_MS = parseIntEnv('EVB_SHUTDOWN_TIMEOUT_MS', 20_000, 3_000);
export const SHUTDOWN_STEP_TIMEOUT_MS = parseIntEnv('EVB_SHUTDOWN_STEP_TIMEOUT_MS', 8_000, 1_000, SHUTDOWN_TOTAL_TIMEOUT_MS);
export const GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS = parseIntEnv('EVB_GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS', 3_000, 0);

interface ILogger {error(message: string): void;}

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
                const timeout = error instanceof Error && error.name === 'TimeoutError';
                logger.error(
                    timeout
                        ? `Shutdown step timed out (${step.label}, ${SHUTDOWN_STEP_TIMEOUT_MS}ms)`
                        : `Shutdown step failed (${step.label}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }, SHUTDOWN_TOTAL_TIMEOUT_MS);
}

export function createShutdownCoordinator(options: ICreateShutdownCoordinatorOptions) {
    let gracefulShutdownPromise: Promise<void> | null = null;
    let gracefulQuitForceTimer: NodeJS.Timeout | null = null;
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
            if (error instanceof Error && error.name === 'TimeoutError') {
                options.logger.error(`Global shutdown cleanup timed out after ${SHUTDOWN_TOTAL_TIMEOUT_MS}ms`);
                return;
            }
            options.logger.error(`Global shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
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
        requestGracefulQuit() {
            if (isQuittingAfterCleanup) {
                return;
            }
            if (!gracefulShutdownPromise) {
                gracefulShutdownPromise = performCleanup().catch((error) => {
                    options.logger.error(`Graceful shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
                });
            }

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
                options.app.quit();
            });
        },
    };
}
