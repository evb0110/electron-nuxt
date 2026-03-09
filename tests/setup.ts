import {
    afterEach,
    beforeEach,
    vi,
} from 'vitest';
import { flattenObject } from 'es-toolkit/object';
import enMessages from '@app/locales/en';

const EN_TRANSLATION_KEYS = new Set(
    Object.entries(flattenObject(enMessages))
        .filter(entry => typeof entry[1] === 'string')
        .map(entry => entry[0]),
);

const translate = (key: string) => {
    if (!EN_TRANSLATION_KEYS.has(key)) {
        throw new Error(`Unknown i18n key in test: "${key}"`);
    }
    return key;
};

const i18nComposer = {
    t: translate,
    setLocale: async () => {},
    loadLocaleMessages: async () => {},
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
