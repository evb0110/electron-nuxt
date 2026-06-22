interface IStorageLike {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
}

function getBrowserCrypto() {
    return globalThis.crypto ?? null;
}

function createRandomHexFromCrypto(byteCount: number) {
    const cryptoProvider = getBrowserCrypto();
    if (typeof cryptoProvider?.getRandomValues !== 'function') {
        return null;
    }

    try {
        const bytes = new Uint8Array(byteCount);
        cryptoProvider.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

function createDateFallbackId() {
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 14);
    return `${timePart}-${randomPart || '0'}`;
}

function getSessionStorageSafe(): IStorageLike | null {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        return (window as Window & { sessionStorage?: IStorageLike }).sessionStorage ?? null;
    } catch {
        return null;
    }
}

export function safeDecodeURIComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

export function createBrowserSafeId(prefix?: string) {
    const cryptoProvider = getBrowserCrypto();
    let id: string | null = null;

    if (typeof cryptoProvider?.randomUUID === 'function') {
        try {
            id = cryptoProvider.randomUUID();
        } catch {
            id = null;
        }
    }

    id ??= createRandomHexFromCrypto(16) ?? createDateFallbackId();
    return prefix ? `${prefix}-${id}` : id;
}

export function safeGetSessionStorageItem(key: string) {
    const storage = getSessionStorageSafe();
    if (!storage || typeof storage.getItem !== 'function') {
        return null;
    }

    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

export function safeSetSessionStorageItem(key: string, value: string) {
    const storage = getSessionStorageSafe();
    if (!storage || typeof storage.setItem !== 'function') {
        return;
    }

    try {
        storage.setItem(key, value);
    } catch {
        return;
    }
}
