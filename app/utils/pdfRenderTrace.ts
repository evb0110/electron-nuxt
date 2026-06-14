import { BrowserLogger } from '@app/utils/browserLogger';

const PDF_RENDER_TRACE_STORAGE_KEY = 'evb-viewer:pdf-render-trace';
const PDF_RENDER_TRACE_CONSOLE_STORAGE_KEY = 'evb-viewer:pdf-render-trace-console';
const PDF_RENDER_TRACE_SECTION = 'pdf-render-trace';
const PDF_RENDER_TRACE_BUFFER_LIMIT = 20_000;

type TPdfRenderTracePayload = Record<string, unknown> | (() => Record<string, unknown>);
export interface IPdfRenderTraceEntry {
    event: string;
    payload: Record<string, unknown>;
}

type TPdfRenderTraceWindow = Window & {
    __pdfRenderTrace?: boolean;
    __pdfRenderTraceConsole?: boolean;
    __pdfRenderTraceBuffer?: IPdfRenderTraceEntry[];
    __getPdfRenderTrace?: () => IPdfRenderTraceEntry[];
    __clearPdfRenderTrace?: () => void;
};

function resolvePayload(payload: TPdfRenderTracePayload | undefined) {
    if (!payload) {
        return {};
    }

    return typeof payload === 'function' ? payload() : payload;
}

export function isPdfRenderTraceEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    const traceWindow = window as TPdfRenderTraceWindow;
    if (traceWindow.__pdfRenderTrace === true) {
        return true;
    }

    try {
        return window.localStorage.getItem(PDF_RENDER_TRACE_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function isPdfRenderTraceConsoleEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    const traceWindow = window as TPdfRenderTraceWindow;
    if (traceWindow.__pdfRenderTraceConsole === true) {
        return true;
    }

    try {
        return window.localStorage.getItem(PDF_RENDER_TRACE_CONSOLE_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function getTraceWindow() {
    if (typeof window === 'undefined') {
        return null;
    }

    const traceWindow = window as TPdfRenderTraceWindow;
    traceWindow.__pdfRenderTraceBuffer ??= [];
    traceWindow.__getPdfRenderTrace ??= () => [...(traceWindow.__pdfRenderTraceBuffer ?? [])];
    traceWindow.__clearPdfRenderTrace ??= () => {
        traceWindow.__pdfRenderTraceBuffer = [];
    };
    return traceWindow;
}

function pushTraceEntry(entry: IPdfRenderTraceEntry) {
    const traceWindow = getTraceWindow();
    if (!traceWindow) {
        return;
    }

    const buffer = traceWindow.__pdfRenderTraceBuffer ?? [];
    buffer.push(entry);
    if (buffer.length > PDF_RENDER_TRACE_BUFFER_LIMIT) {
        buffer.splice(0, buffer.length - PDF_RENDER_TRACE_BUFFER_LIMIT);
    }
    traceWindow.__pdfRenderTraceBuffer = buffer;
}

export function logPdfRenderTrace(
    event: string,
    payload?: TPdfRenderTracePayload,
) {
    if (!isPdfRenderTraceEnabled()) {
        return;
    }

    const tracePayload = {
        traceAtMs: typeof performance === 'undefined' ? Date.now() : performance.now(),
        ...resolvePayload(payload),
    };

    pushTraceEntry({
        event,
        payload: tracePayload,
    });

    if (!isPdfRenderTraceConsoleEnabled()) {
        return;
    }

    BrowserLogger.warn(PDF_RENDER_TRACE_SECTION, event, tracePayload);
}
