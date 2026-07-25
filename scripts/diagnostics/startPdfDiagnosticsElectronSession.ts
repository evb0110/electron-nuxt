import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

export type {IElectronE2ESession};

export async function startPdfDiagnosticsElectronSession(
    scenarioName: string,
): Promise<IElectronE2ESession> {
    return startElectronE2ESession(`diagnostics-${scenarioName}-${Date.now()}`);
}
