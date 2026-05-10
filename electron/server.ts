import { config } from '@electron/config';

const HAS_FIXED_SERVER_PORT = Boolean(process.env.EVB_SERVER_PORT?.trim());
const WAIT_FOR_EXTERNAL_DEV_SERVER = process.env.EVB_WAIT_FOR_EXTERNAL_DEV_SERVER === '1';

export function shouldWaitForExternalDevServer(options: {
    isDev?: boolean;
    hasFixedServerPort?: boolean;
    waitForExternalDevServer?: boolean;
} = {}) {
    return (options.isDev ?? config.isDev)
        && (options.hasFixedServerPort ?? HAS_FIXED_SERVER_PORT)
        && (options.waitForExternalDevServer ?? WAIT_FOR_EXTERNAL_DEV_SERVER);
}

export function startServer() {
    if (!shouldWaitForExternalDevServer()) {
        return;
    }
}

export function waitForServer() {
}

export function stopServer() {
}
