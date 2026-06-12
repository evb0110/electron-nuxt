import { BrowserLogger } from '@app/utils/browserLogger';

const PDF_NAV_LOG_STORAGE_KEY = 'evb-viewer:pdf-nav-log';
const PDF_NAV_LOG_CONSOLE_STORAGE_KEY = 'evb-viewer:pdf-nav-log-console';
const PDF_NAV_LOG_SECTION = 'pdf-nav';
const PDF_NAV_LOG_BUFFER_LIMIT = 5_000;

type TPdfNavLogEntry = {
    message: string;
    args: unknown[];
    loggedAtMs: number;
};

type TPdfNavLogWindow = Window & {
    __pdfNavLog?: boolean;
    __pdfNavLogConsole?: boolean;
    __pdfNavLogBuffer?: TPdfNavLogEntry[];
    __getPdfNavLog?: () => TPdfNavLogEntry[];
    __clearPdfNavLog?: () => void;
};

function getLogWindow() {
    if (typeof window === 'undefined') {
        return null;
    }

    const logWindow = window as TPdfNavLogWindow;
    logWindow.__pdfNavLogBuffer ??= [];
    logWindow.__getPdfNavLog ??= () => [...(logWindow.__pdfNavLogBuffer ?? [])];
    logWindow.__clearPdfNavLog ??= () => {
        logWindow.__pdfNavLogBuffer = [];
    };
    return logWindow;
}

function isPdfNavLogEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    const logWindow = window as TPdfNavLogWindow;
    if (logWindow.__pdfNavLog === true) {
        return true;
    }

    try {
        return window.localStorage.getItem(PDF_NAV_LOG_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function isPdfNavLogConsoleEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    const logWindow = window as TPdfNavLogWindow;
    if (logWindow.__pdfNavLogConsole === true) {
        return true;
    }

    try {
        return window.localStorage.getItem(PDF_NAV_LOG_CONSOLE_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

export function logPdfNav(message: string, ...args: unknown[]) {
    if (!isPdfNavLogEnabled()) {
        return;
    }

    const logWindow = getLogWindow();
    if (!logWindow) {
        return;
    }

    const entry = {
        message,
        args,
        loggedAtMs: typeof performance === 'undefined' ? Date.now() : performance.now(),
    };
    const buffer = logWindow.__pdfNavLogBuffer ?? [];
    buffer.push(entry);
    if (buffer.length > PDF_NAV_LOG_BUFFER_LIMIT) {
        buffer.splice(0, buffer.length - PDF_NAV_LOG_BUFFER_LIMIT);
    }
    logWindow.__pdfNavLogBuffer = buffer;

    if (isPdfNavLogConsoleEnabled()) {
        BrowserLogger.diagnostic(PDF_NAV_LOG_SECTION, message, args.length > 0 ? args : undefined);
    }
}
