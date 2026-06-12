type TAnnotationSaveTracePayload =
    | Record<string, unknown>
    | (() => Record<string, unknown>);

export function tracePdfAnnotationSaveEvent(
    _event: string,
    _payload?: TAnnotationSaveTracePayload,
) {
    return;
}
