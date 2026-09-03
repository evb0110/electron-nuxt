import {initializeRendererFailureReporter} from '@app/utils/failureReporter';
import {hasElectronAPI} from '@app/utils/platform';

export default defineNuxtPlugin(() => {
    if (hasElectronAPI()) {
        return;
    }

    initializeRendererFailureReporter({
        host: 'hosted-browser',
        loadHostedTransport: async () => {
            const {createConfiguredBrowserDiagnosticsTransport} = await import('@app/utils/browserDiagnosticsTransport');
            return createConfiguredBrowserDiagnosticsTransport();
        },
    });
});
