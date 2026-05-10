import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const DEFAULT_SERVER_HOST = normalizeServerHost(process.env.EVB_SERVER_HOST, '127.0.0.1');
const DEFAULT_SERVER_PORT = parsePositiveInt(process.env.EVB_SERVER_PORT, 3235);
const DEFAULT_SERVER_PATH = normalizeServerPath(process.env.EVB_SERVER_PATH, '/electron');
const APP_PROTOCOL_ORIGIN = 'evb-viewer://app';
let runtimeServerHost = DEFAULT_SERVER_HOST;
let runtimeServerPort = DEFAULT_SERVER_PORT;
let runtimeServerPath = DEFAULT_SERVER_PATH;

function parsePositiveInt(raw: string | undefined, fallback: number) {
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

function normalizeServerPath(raw: string | undefined, fallback: string) {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return fallback;
    }

    if (trimmed === '/') {
        return trimmed;
    }

    return trimmed.startsWith('/')
        ? trimmed
        : `/${trimmed}`;
}

function normalizeServerHost(raw: string | undefined, fallback: string) {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return fallback;
    }

    return trimmed;
}

export const config = {
    isDev: !isPackaged,
    isMac: process.platform === 'darwin',

    server: {
        get host() {
            return runtimeServerHost;
        },
        setHost(host: string) {
            runtimeServerHost = normalizeServerHost(host, DEFAULT_SERVER_HOST);
        },
        get port() {
            return runtimeServerPort;
        },
        setPort(port: number) {
            // Keep server URL mutable per-launch so packaged builds can avoid
            // attaching to pre-bound localhost ports owned by other processes.
            runtimeServerPort = parsePositiveInt(String(port), DEFAULT_SERVER_PORT);
        },
        get path() {
            return runtimeServerPath;
        },
        setPath(path: string) {
            runtimeServerPath = normalizeServerPath(path, DEFAULT_SERVER_PATH);
        },
        get url() {
            return `http://${this.host}:${this.port}${this.path}`;
        },
    },

    renderer: {
        protocolOrigin: APP_PROTOCOL_ORIGIN,
        get url() {
            return isPackaged
                ? `${APP_PROTOCOL_ORIGIN}/electron`
                : config.server.url;
        },
        get trustedOrigin() {
            return isPackaged
                ? APP_PROTOCOL_ORIGIN
                : new URL(config.server.url).origin;
        },
        get staticRoot() {
            if (isPackaged) {
                return join(process.resourcesPath, 'app.asar', 'nuxt-output', 'public');
            }
            return join(__dirname, '../nuxt-output/public');
        },
    },

    window: {
        width: 900,
        height: 700,
        title: 'EVB Viewer',
        backgroundColor: '#ffffff',
    },

    updates: {
        metadataUrl: process.env.EVB_UPDATES_METADATA_URL || 'https://evb-viewer.vercel.app/api/releases/latest',
        pollIntervalMs: parsePositiveInt(process.env.EVB_UPDATES_POLL_INTERVAL_MS, 6 * 60 * 60 * 1000),
        initialDelayMs: parsePositiveInt(process.env.EVB_UPDATES_INITIAL_DELAY_MS, 2 * 60 * 1000),
    },

    automation: {
        noFocus: process.env.EVB_AUTOMATION_NO_FOCUS === '1',
        hideWindow: process.env.EVB_AUTOMATION_HIDE_WINDOW
            ? process.env.EVB_AUTOMATION_HIDE_WINDOW === '1'
            : process.env.EVB_AUTOMATION_NO_FOCUS === '1',
    },
} as const;
