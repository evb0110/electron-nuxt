const FREE_TEXT_SUBTYPE_LOWER = 'freetext';
const TEXT_SUBTYPE_LOWER = 'text';

export type TPdfCanonicalAnnotationKind = 'sticky-note';

/**
 * The one subtype policy for PDF summaries entering canonical annotation
 * state. `hasNote` keeps point-note presentation separate from ordinary
 * FreeText while both subtypes retain a durable canonical identity.
 */
export function resolvePdfAnnotationCanonicalKind(
    subtype: string | null | undefined,
    hasNote: boolean,
): TPdfCanonicalAnnotationKind | null {
    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
    if (
        normalizedSubtype === FREE_TEXT_SUBTYPE_LOWER
        || (normalizedSubtype === TEXT_SUBTYPE_LOWER && hasNote)
    ) {
        return 'sticky-note';
    }
    return null;
}
