import { vi } from 'vitest';
import enMessages from '@app/locales/en';
import type { TLocale } from '@app/i18n/locales';

interface IMessageNode {[key: string]: IMessageNode | string;}

const collectMessageKeys = (
    node: IMessageNode,
    prefix = '',
    keys: Set<string> = new Set(),
) => {
    for (const [
        key,
        value,
    ] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            keys.add(path);
            continue;
        }
        collectMessageKeys(value, path, keys);
    }
    return keys;
};

const EN_TRANSLATION_KEYS = collectMessageKeys(enMessages as IMessageNode);

const translate = (key: string) => {
    if (!EN_TRANSLATION_KEYS.has(key)) {
        throw new Error(`Unknown i18n key in test: "${key}"`);
    }
    return key;
};

async function setLocale(_locale: TLocale) {
    return;
}

async function loadLocaleMessages(_locale: TLocale) {
    return;
}

vi.stubGlobal('useI18n', () => ({
    t: translate,
    setLocale,
    loadLocaleMessages,
}));

vi.stubGlobal('useTypedI18n', () => ({
    t: translate,
    setLocale,
    loadLocaleMessages,
}));
