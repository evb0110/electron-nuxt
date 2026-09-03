/* eslint-disable custom/file-naming -- Nitro discovers this exact plugin path. */

import type {H3Event} from 'h3';
import {
    initializeServerFailureReporter,
    type IServerFailureReporter,
} from '@server/utils/serverFailureReporter';

const registeredNitroApps = new WeakSet<object>();

interface INitroDiagnosticsApp {readonly hooks: {hook: (
    name: 'error',
    handler: (error: Error, context: {readonly event?: H3Event}) => void,
) => unknown;};}

export function registerNitroDiagnostics(
    nitroApp: INitroDiagnosticsApp,
    reporter: IServerFailureReporter = initializeServerFailureReporter(),
) {
    if (registeredNitroApps.has(nitroApp)) {
        return;
    }
    registeredNitroApps.add(nitroApp);
    nitroApp.hooks.hook('error', (error, context) => {
        try {
            reporter.captureUncaught(error, context?.event);
        } catch {
            // Diagnostics must never change the HTTP error path.
        }
    });
}

export default function diagnosticsPlugin(nitroApp: INitroDiagnosticsApp) {
    registerNitroDiagnostics(nitroApp);
}
