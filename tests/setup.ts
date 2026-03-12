import {
    afterEach,
    beforeEach,
    vi,
} from 'vitest';
import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import { EN_MESSAGE_SCHEMA } from '@i18n-app';
import { flattenObject } from 'es-toolkit/object';

const EN_TRANSLATION_KEYS = new Set(
    Object.entries(flattenObject(EN_MESSAGE_SCHEMA))
        .filter(entry => typeof entry[1] === 'string')
        .map(entry => entry[0]),
);

const translate: TTranslateFn = (key, ...args) => {
    if (!EN_TRANSLATION_KEYS.has(key)) {
        throw new Error(`Unknown i18n key in test: "${key}"`);
    }
    const rawParams = args[0];
    if (typeof rawParams === 'number') {
        return `${key}:${rawParams}`;
    }
    if (rawParams && typeof rawParams === 'object') {
        return `${key}:${JSON.stringify(rawParams)}`;
    }
    return key;
};

const i18nComposer = {
    t: translate,
    setLocale: async (_locale: TLocale) => {},
    loadLocaleMessages: async (_locale: TLocale) => {},
};

vi.mock('vue-i18n', () => ({useI18n: () => i18nComposer}));

let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;
let vueRuntimeMessages: string[] = [];

function formatConsoleArgs(args: unknown[]) {
    return args
        .map(arg => {
            if (typeof arg === 'string') {
                return arg;
            }

            if (arg instanceof Error) {
                return arg.stack ?? arg.message;
            }

            try {
                return JSON.stringify(arg);
            }
            catch {
                return String(arg);
            }
        })
        .join(' ');
}

function isVueRuntimeFailure(message: string) {
    return message.includes('[Vue warn]')
        || message.includes('[Vue error]')
        || message.includes('Unhandled error during execution');
}

beforeEach(() => {
    vueRuntimeMessages = [];

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        const message = formatConsoleArgs(args);
        if (isVueRuntimeFailure(message)) {
            vueRuntimeMessages.push(message);
        }
    });

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const message = formatConsoleArgs(args);
        if (isVueRuntimeFailure(message)) {
            vueRuntimeMessages.push(message);
        }
    });
});

afterEach(() => {
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    consoleWarnSpy = null;
    consoleErrorSpy = null;

    if (vueRuntimeMessages.length === 0) {
        return;
    }

    const failures = vueRuntimeMessages
        .map(message => `- ${message}`)
        .join('\n');
    vueRuntimeMessages = [];
    throw new Error(`Vue runtime warnings/errors are test failures:\n${failures}`);
});
