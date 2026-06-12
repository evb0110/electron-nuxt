type TAnnotationSaveTracePayload =
    | Record<string, unknown>
    | (() => Record<string, unknown>);

export function tracePdfAnnotationSaveDom(
    _event: string,
    _container: HTMLElement | null | undefined,
    _payload?: TAnnotationSaveTracePayload,
) {
    return;
}
