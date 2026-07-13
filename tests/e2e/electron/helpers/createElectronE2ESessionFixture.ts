import {
    afterAll,
    beforeAll,
    beforeEach,
} from 'vitest';
import { stopSingleSession } from '@scripts/electron-run/sessionManager';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { TElectronE2EWindowMode } from '@scripts/electron-run/electronRunLaunchConfig';

type TSessionNameFactory = string | (() => string);

interface IElectronE2ESessionRestartOptions {
    sessionName?: TSessionNameFactory;
    clean?: boolean;
    keepNuxt?: boolean;
    windowMode?: TElectronE2EWindowMode;
}

interface IElectronE2ESessionFixtureControls {
    getSession: () => IElectronE2ESession | null;
    start: (options?: Pick<IElectronE2ESessionRestartOptions, 'sessionName' | 'clean' | 'windowMode'>) => Promise<IElectronE2ESession | null>;
    restart: (options?: IElectronE2ESessionRestartOptions) => Promise<IElectronE2ESession | null>;
    stop: (options?: { preserveArtifacts?: boolean }) => Promise<void>;
}

interface IElectronE2ESessionFixtureOptions {
    sessionName: TSessionNameFactory;
    clean?: boolean;
    timeoutMs?: number;
    windowMode?: TElectronE2EWindowMode;
}

function resolveSessionName(sessionName: TSessionNameFactory) {
    return typeof sessionName === 'function' ? sessionName() : sessionName;
}

function createInfraError(label: string, error: unknown) {
    if (error instanceof Error && error.message.startsWith('[INFRA]')) {
        return error;
    }

    const source = error instanceof Error ? error : new Error(String(error));
    const infraError = new Error(`[INFRA] ${label}\n${source.message}`);
    if (source.stack) {
        infraError.stack = `${infraError.name}: ${infraError.message}\nCaused by: ${source.stack}`;
    }
    return infraError;
}

export function createElectronE2ESessionFixture(options: IElectronE2ESessionFixtureOptions) {
    let session: IElectronE2ESession | null = null;
    let sessionName = resolveSessionName(options.sessionName);
    let bootFailure: Error | null = null;
    let preserveFailureArtifacts = false;

    const controls: IElectronE2ESessionFixtureControls = {
        getSession: () => {
            if (session) {
                return session;
            }
            if (bootFailure) {
                return null;
            }
            throw new Error('Electron E2E session is not initialized; the suite boot hook may not have completed.');
        },
        start: async (startOptions: Pick<IElectronE2ESessionRestartOptions, 'sessionName' | 'clean' | 'windowMode'> = {}) => {
            try {
                await controls.stop();
                sessionName = startOptions.sessionName
                    ? resolveSessionName(startOptions.sessionName)
                    : sessionName;
                const windowMode = startOptions.windowMode ?? options.windowMode;
                session = await startElectronE2ESession(sessionName, {
                    clean: startOptions.clean ?? true,
                    ...(windowMode ? {windowMode} : {}),
                });
                bootFailure = null;
                return session;
            } catch (error) {
                bootFailure = createInfraError('Electron E2E session boot failed.', error);
                throw bootFailure;
            }
        },
        restart: async (restartOptions: IElectronE2ESessionRestartOptions = {}) => {
            const previousSession = controls.getSession();
            if (!previousSession) {
                return null;
            }

            try {
                const clean = restartOptions.clean ?? true;
                const keepNuxt = restartOptions.keepNuxt ?? false;
                await previousSession.browser.disconnect();
                if (clean) {
                    await previousSession.stop({
                        keepNuxt,
                        preserveArtifacts: preserveFailureArtifacts,
                    });
                } else {
                    await stopSingleSession(previousSession.name, {keepNuxt});
                }
                session = null;
                sessionName = restartOptions.sessionName
                    ? resolveSessionName(restartOptions.sessionName)
                    : previousSession.name;
                const windowMode = restartOptions.windowMode ?? options.windowMode;
                session = await controls.start({
                    sessionName,
                    clean,
                    ...(windowMode ? {windowMode} : {}),
                });
                return session;
            } catch (error) {
                bootFailure = createInfraError('Electron E2E session restart failed.', error);
                throw bootFailure;
            }
        },
        stop: async (stopOptions = {}) => {
            await session?.stop(stopOptions);
            session = null;
        },
    };

    beforeAll(async () => {
        try {
            sessionName = resolveSessionName(options.sessionName);
            const windowMode = options.windowMode;
            session = await startElectronE2ESession(sessionName, {
                clean: options.clean ?? true,
                ...(windowMode ? {windowMode} : {}),
            });
            bootFailure = null;
        } catch (error) {
            bootFailure = createInfraError('Electron E2E session boot failed.', error);
            throw bootFailure;
        }
    }, options.timeoutMs);

    beforeEach((context) => {
        context.onTestFailed(async (failureContext) => {
            preserveFailureArtifacts = true;
            try {
                await session?.captureFailureArtifacts(failureContext.task.fullTestName ?? failureContext.task.name);
            } catch (error) {
                console.warn(`[E2E artifacts] Failed to capture failure state: ${error instanceof Error ? error.message : String(error)}`);
            }
        }, 15_000);
    });

    afterAll(async () => {
        await controls.stop({ preserveArtifacts: preserveFailureArtifacts });
    });

    return controls;
}
