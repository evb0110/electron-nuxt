import {
    RECENT_FILES_COOKIE_KEY,
    RECENT_FILES_COOKIE_MAX_AGE_SECONDS,
    RECENT_FILES_COOKIE_MAX_ENCODED_LENGTH,
    RECENT_FILES_COOKIE_SSR_LIMIT,
} from '@app/utils/recent-files-persistence';

export const BROWSER_RECENT_FILES_STORAGE_KEY = 'evb-viewer:browser:recent-files';
export const BROWSER_INSTALL_HINT_STORAGE_KEY = 'evb-viewer:web-install-hint-dismissed';
export const BROWSER_INSTALL_HINT_COOKIE_KEY = 'evb_viewer_web_install_hint_dismissed';

const WEB_SSR_BOOTSTRAP_RELOAD_KEY = 'evb-viewer:web-ssr-bootstrap:reloaded';

export function createWebSsrBootstrapScript() {
    const config = JSON.stringify({
        recentCookieName: RECENT_FILES_COOKIE_KEY,
        recentCookieMaxAge: RECENT_FILES_COOKIE_MAX_AGE_SECONDS,
        recentCookieMaxEncodedLength: RECENT_FILES_COOKIE_MAX_ENCODED_LENGTH,
        recentCookieLimit: RECENT_FILES_COOKIE_SSR_LIMIT,
        recentStorageKey: BROWSER_RECENT_FILES_STORAGE_KEY,
        installCookieName: BROWSER_INSTALL_HINT_COOKIE_KEY,
        installCookieMaxAge: RECENT_FILES_COOKIE_MAX_AGE_SECONDS,
        installStorageKey: BROWSER_INSTALL_HINT_STORAGE_KEY,
        reloadKey: WEB_SSR_BOOTSTRAP_RELOAD_KEY,
    });

    return `(() => {
const config = ${config};

function readCookie(name) {
    const cookieString = '; ' + document.cookie;
    const parts = cookieString.split('; ' + name + '=');
    if (parts.length < 2) {
        return null;
    }

    return parts.pop()?.split(';').shift() ?? null;
}

function writeCookie(name, value, maxAge) {
    document.cookie = name + '=' + value + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax';
}

function normalizeRecentFile(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const originalPath = typeof value.originalPath === 'string' ? value.originalPath : null;
    const fileName = typeof value.fileName === 'string' ? value.fileName : null;
    const timestamp = typeof value.timestamp === 'number' ? value.timestamp : null;
    const fileSize = typeof value.fileSize === 'number' ? value.fileSize : undefined;
    if (!originalPath || !fileName || timestamp === null) {
        return null;
    }

    return { originalPath, fileName, timestamp, fileSize };
}

function trimRecentFilesPayload(raw) {
    if (!raw) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!Array.isArray(parsed)) {
        return null;
    }

    const trimmed = [];
    for (const entry of parsed) {
        const normalized = normalizeRecentFile(entry);
        if (!normalized) {
            continue;
        }

        const candidate = trimmed.concat(normalized);
        const payload = JSON.stringify(candidate);
        if (encodeURIComponent(payload).length > config.recentCookieMaxEncodedLength) {
            break;
        }

        trimmed.push(normalized);
        if (trimmed.length >= config.recentCookieLimit) {
            break;
        }
    }

    return trimmed.length > 0 ? JSON.stringify(trimmed) : null;
}

let shouldReload = false;

try {
    if (!readCookie(config.recentCookieName)) {
        const rawRecentFiles = window.localStorage.getItem(config.recentStorageKey);
        const recentFilesPayload = trimRecentFilesPayload(rawRecentFiles);
        if (recentFilesPayload) {
            writeCookie(
                config.recentCookieName,
                encodeURIComponent(recentFilesPayload),
                config.recentCookieMaxAge,
            );
            shouldReload = true;
        }
    }
} catch {
    // Best-effort sync only.
}

try {
    if (
        !readCookie(config.installCookieName)
        && window.localStorage.getItem(config.installStorageKey) === '1'
    ) {
        writeCookie(config.installCookieName, '1', config.installCookieMaxAge);
        shouldReload = true;
    }
} catch {
    // Best-effort sync only.
}

try {
    if (shouldReload) {
        if (window.sessionStorage.getItem(config.reloadKey) !== '1') {
            window.sessionStorage.setItem(config.reloadKey, '1');
            window.location.replace(window.location.href);
        }
    } else {
        window.sessionStorage.removeItem(config.reloadKey);
    }
} catch {
    if (shouldReload) {
        window.location.replace(window.location.href);
    }
}
})();`;
}
