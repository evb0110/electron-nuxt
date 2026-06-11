import {
    afterAll,
    it,
} from 'vitest';
import { stopSingleSession } from '@scripts/electron-run/sessionManager';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';

type TSessionNameFactory = string | (() => string);

interface IElectronE2ESessionRestartOptions {
    sessionName?: TSessionNameFactory;
    clean?: boolean;
    keepNuxt?: boolean;
}

interface IElectronE2ESessionFixtureControls {
    getSession: () => IElectronE2ESession | null;
    start: (options?: Pick<IElectronE2ESessionRestartOptions, 'sessionName' | 'clean'>) => Promise<IElectronE2ESession | null>;
    restart: (options?: IElectronE2ESessionRestartOptions) => Promise<IElectronE2ESession | null>;
    stop: () => Promise<void>;
}

interface IElectronE2ESessionFixtureOptions {
    sessionName: TSessionNameFactory;
    title?: string;
    clean?: boolean;
    timeoutMs?: number;
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

    const controls: IElectronE2ESessionFixtureControls = {
        getSession: () => {
            if (session) {
                return session;
            }
            if (bootFailure) {
                return null;
            }
            throw new Error('Electron E2E session is not initialized; the [INFRA] boot test may not have run yet.');
        },
        start: async (startOptions: Pick<IElectronE2ESessionRestartOptions, 'sessionName' | 'clean'> = {}) => {
            if (bootFailure) {
                return null;
            }

            try {
                await controls.stop();
                sessionName = startOptions.sessionName
                    ? resolveSessionName(startOptions.sessionName)
                    : sessionName;
                session = await startElectronE2ESession(sessionName, {clean: startOptions.clean ?? true});
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
                previousSession.browser.disconnect();
                await stopSingleSession(previousSession.name, {keepNuxt: restartOptions.keepNuxt ?? false});
                session = null;
                sessionName = restartOptions.sessionName
                    ? resolveSessionName(restartOptions.sessionName)
                    : previousSession.name;
                session = await controls.start({
                    sessionName,
                    clean: restartOptions.clean ?? true,
                });
                return session;
            } catch (error) {
                bootFailure = createInfraError('Electron E2E session restart failed.', error);
                throw bootFailure;
            }
        },
        stop: async () => {
            await session?.stop();
            session = null;
        },
    };

    it(options.title ?? '[INFRA] boots an Electron session', async () => {
        try {
            sessionName = resolveSessionName(options.sessionName);
            session = await startElectronE2ESession(sessionName, {clean: options.clean ?? true});
        } catch (error) {
            bootFailure = createInfraError('Electron E2E session boot failed.', error);
            throw bootFailure;
        }
    }, options.timeoutMs);

    afterAll(async () => {
        await controls.stop();
    });

    return controls;
}
