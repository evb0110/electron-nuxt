import { isMarkupSubtype } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/isMarkupSubtype';

const MARKUP_SUBTYPE_OVERRIDE_BLOCKLIST: ReadonlySet<string> = new Set([
    'Highlight',
    'Ink',
    'Typewriter',
]);

export function resolveMarkupSubtypeOverrideRegistration(
    annotationId: string | null,
    resolvedSubtype: string | null | undefined,
) {
    if (!annotationId || !resolvedSubtype) {
        return null;
    }
    if (MARKUP_SUBTYPE_OVERRIDE_BLOCKLIST.has(resolvedSubtype)) {
        return null;
    }
    if (!isMarkupSubtype(resolvedSubtype)) {
        return null;
    }
    return {
        annotationId,
        subtype: resolvedSubtype,
    };
}
