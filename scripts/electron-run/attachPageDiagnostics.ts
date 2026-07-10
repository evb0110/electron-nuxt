import type {
    ConsoleMessage,
    JSHandle,
    Page,
} from 'puppeteer-core';
import type { ISessionState } from '@scripts/electron-run/electronRunSessionTypes';

const MAX_CONSOLE_MESSAGES = 400;
const MAX_CONSOLE_ARG_TEXT_LENGTH = 2000;
const MAX_DEVTOOLS_EVENTS = 1200;

function pushBounded<T>(collection: T[], item: T, maxSize: number) {
    collection.push(item);
    if (collection.length > maxSize) {
        collection.splice(0, collection.length - maxSize);
    }
}

function boundConsoleArgText(text: string) {
    if (text.length <= MAX_CONSOLE_ARG_TEXT_LENGTH) {
        return text;
    }
    return `${text.slice(0, MAX_CONSOLE_ARG_TEXT_LENGTH)}...`;
}

function stringifyConsoleArgValue(value: unknown) {
    try {
        const text = typeof value === 'string'
            ? value
            : JSON.stringify(value);
        return boundConsoleArgText(text ?? String(value));
    } catch {
        return boundConsoleArgText(String(value));
    }
}

async function serializeConsoleArg(arg: JSHandle, fallbackText: string) {
    try {
        return stringifyConsoleArgValue(await arg.jsonValue());
    } catch {
        return boundConsoleArgText(fallbackText);
    }
}

async function formatConsoleMessage(msg: ConsoleMessage) {
    const text = msg.text();
    try {
        const serializedArgs = await Promise.all(
            msg.args().map(arg => serializeConsoleArg(arg, text)),
        );
        if (serializedArgs.length === 0) {
            return text;
        }
        return `${text} ${serializedArgs.join(' ')}`;
    } catch {
        return text;
    }
}

export function attachPageDiagnostics(page: Page) {
    const consoleMessages: ISessionState['consoleMessages'] = [];
    const devtoolsEvents: ISessionState['devtoolsEvents'] = [];
    const pushConsoleMessage = (entry: ISessionState['consoleMessages'][number]) => {
        pushBounded(consoleMessages, entry, MAX_CONSOLE_MESSAGES);
        pushBounded(devtoolsEvents, {
            kind: 'console',
            timestamp: entry.timestamp,
            level: entry.type,
            text: entry.text,
        }, MAX_DEVTOOLS_EVENTS);
    };
    const pushDevtoolsEvent = (entry: ISessionState['devtoolsEvents'][number]) => {
        pushBounded(devtoolsEvents, entry, MAX_DEVTOOLS_EVENTS);
    };
    type TConsoleEntry = ISessionState['consoleMessages'][number];

    page.on('console', (msg) => {
        void (async () => {
            try {
                const entry: TConsoleEntry = {
                    type: msg.type(),
                    text: await formatConsoleMessage(msg),
                    timestamp: Date.now(),
                };
                pushConsoleMessage(entry);
                console.log(`[${entry.type.toUpperCase()}] ${entry.text}`);
            } catch {
                const entry: TConsoleEntry = {
                    type: msg.type(),
                    text: msg.text(),
                    timestamp: Date.now(),
                };
                pushConsoleMessage(entry);
                console.log(`[${entry.type.toUpperCase()}] ${entry.text}`);
            }
        })();
    });
    page.on('request', (request) => {
        pushDevtoolsEvent({
            kind: 'request',
            timestamp: Date.now(),
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            isNavigationRequest: request.isNavigationRequest(),
        });
    });
    page.on('response', (response) => {
        pushDevtoolsEvent({
            kind: 'response',
            timestamp: Date.now(),
            url: response.url(),
            status: response.status(),
            ok: response.ok(),
            fromCache: response.fromCache(),
            fromServiceWorker: response.fromServiceWorker(),
            resourceType: response.request().resourceType(),
            method: response.request().method(),
        });
    });
    page.on('requestfailed', (request) => {
        pushDevtoolsEvent({
            kind: 'requestfailed',
            timestamp: Date.now(),
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            failureText: request.failure()?.errorText ?? 'unknown request failure',
        });
    });
    page.on('error', (error) => {
        const entry: TConsoleEntry = {
            type: 'error',
            text: `[PAGE ERROR] ${error.message}`,
            timestamp: Date.now(),
        };
        pushConsoleMessage(entry);
        pushDevtoolsEvent({
            kind: 'error',
            timestamp: entry.timestamp,
            text: entry.text,
        });
        console.log(`[ERROR] ${error.message}`);
    });
    page.on('pageerror', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const entry: TConsoleEntry = {
            type: 'error',
            text: `[PAGE CRASH] ${message}`,
            timestamp: Date.now(),
        };
        pushConsoleMessage(entry);
        pushDevtoolsEvent({
            kind: 'pageerror',
            timestamp: entry.timestamp,
            text: message,
        });
        console.log(`[ERROR] ${message}`);
    });

    return {
        consoleMessages,
        devtoolsEvents,
    };
}
