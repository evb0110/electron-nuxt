export type TAnnotationSaveTracePayload =
    | Record<string, unknown>
    | (() => Record<string, unknown>);
