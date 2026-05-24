const TRACE_FILE_PATH = '/tmp/evb-pdf-annotation-save-trace.jsonl';

type TAnnotationSaveTracePayload =
    | Record<string, unknown>
    | (() => Record<string, unknown>);

export const PDF_ANNOTATION_SAVE_TRACE_FILE_PATH = TRACE_FILE_PATH;

export function isPdfAnnotationSaveTraceEnabled() {
    return false;
}

export function tracePdfAnnotationSaveEvent(
    _event: string,
    _payload?: TAnnotationSaveTracePayload,
) {
    return;
}

export function tracePdfAnnotationSaveDom(
    _event: string,
    _container: HTMLElement | null | undefined,
    _payload?: TAnnotationSaveTracePayload,
) {
    return;
}

export function flushPdfAnnotationSaveTrace() {
    return TRACE_FILE_PATH;
}
