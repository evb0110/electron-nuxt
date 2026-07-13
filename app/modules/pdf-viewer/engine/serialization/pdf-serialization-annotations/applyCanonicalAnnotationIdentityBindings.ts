import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFString,
} from 'pdf-lib';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import {iterateAnnotationRefDicts} from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/iterateAnnotationRefDicts';
import {
    formatPdfJsAnnotationRef,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';

function refKey(value: string | null | undefined) {
    const ref = parsePdfJsAnnotationRef(value);
    return ref ? `${ref.objectNumber}:${ref.generationNumber}` : null;
}

function expectedPdfSubtype(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim();
    return subtype && subtype.toLowerCase() !== 'typewriter' ? subtype : 'FreeText';
}

/** Exact AnnotationStorage serialization order captured before saveDocument. */
export interface ICanonicalAnnotationIdentityBinding {
    readonly annotationId: string;
    readonly pdfRef: string;
}

export interface ICanonicalAnnotationIdentityBindingEvidence {
    readonly newPdfJsAnnotationEditorOrder?: readonly string[];
    /** Annotation refs present before PDF.js materialized the current editors. */
    readonly preexistingPdfAnnotationRefs?: readonly string[];
    readonly onIdentityBound?: ((binding: ICanonicalAnnotationIdentityBinding) => void) | undefined;
}

function annotationName(dict: {get(key: PDFName): unknown}) {
    const value = dict.get(PDFName.of('NM'));
    return value instanceof PDFString || value instanceof PDFHexString
        ? value.decodeText()
        : null;
}

/**
 * Binds newly materialized PDF annotations to their canonical app IDs without
 * geometry matching. Existing refs are excluded first; each remaining
 * page/subtype bucket must match the canonical creation bucket exactly.
 */
export function applyCanonicalAnnotationIdentityBindings(
    doc: PDFDocument,
    comments: readonly IAnnotationCommentSummary[],
    program: readonly IBackendAnnotationMutation[],
    evidence: ICanonicalAnnotationIdentityBindingEvidence = {},
) {
    const bindings = program
        .filter(mutation => mutation.operation === 'bind-identities')
        .filter((mutation) => {
            const identity = mutation.fields.identity;
            return typeof identity === 'object'
                && identity !== null
                && !Reflect.get(identity, 'pdfRef');
        });
    const bindIds = new Set<string>(bindings.map(mutation => mutation.annotationId));
    const expected = comments.filter(comment => (
        Boolean(comment.appAnnotationId)
        && bindIds.has(comment.appAnnotationId!)
        && comment.source !== 'shape'
    ));
    bindings.forEach((binding) => {
        if (expected.some(comment => comment.appAnnotationId === binding.annotationId)) {
            return;
        }
        const pageIndex = binding.fields.pageIndex;
        const kind = binding.fields.kind;
        const identity = binding.fields.identity;
        if (typeof pageIndex !== 'number' || (kind !== 'sticky-note' && kind !== 'text-markup')) {
            return;
        }
        expected.push({
            id: binding.annotationId,
            appAnnotationId: binding.annotationId,
            stableKey: `src:editor:${pageIndex}:${binding.annotationId}`,
            pageIndex,
            pageNumber: pageIndex + 1,
            text: '',
            ...(kind === 'text-markup' && typeof binding.fields.subtype === 'string'
                ? {subtype: binding.fields.subtype}
                : {subtype: 'FreeText'}),
            author: null,
            modifiedAt: null,
            color: null,
            uid: typeof identity === 'object' && identity !== null
                && typeof Reflect.get(identity, 'pdfjsUid') === 'string'
                ? Reflect.get(identity, 'pdfjsUid') as string
                : null,
            annotationId: null,
            source: 'editor',
            hasNote: kind === 'sticky-note',
            markerRect: null,
        });
    });
    if (expected.length === 0) {
        return false;
    }

    const knownRefs = new Set(comments
        .map(comment => refKey(comment.annotationId))
        .filter((value): value is string => Boolean(value)));
    evidence.preexistingPdfAnnotationRefs?.forEach((value) => {
        const key = refKey(value);
        if (key) knownRefs.add(key);
    });
    bindings.forEach((binding) => {
        const refs = binding.fields.knownPdfRefs;
        if (!Array.isArray(refs)) {
            return;
        }
        refs.forEach((value) => {
            if (typeof value === 'string') {
                const key = refKey(value);
                if (key) knownRefs.add(key);
            }
        });
    });
    const expectedByBucket = new Map<string, IAnnotationCommentSummary[]>();
    expected.forEach((comment) => {
        const key = `${comment.pageIndex}:${expectedPdfSubtype(comment)}`;
        expectedByBucket.set(key, [
            ...(expectedByBucket.get(key) ?? []),
            comment,
        ]);
    });

    let modified = false;
    expectedByBucket.forEach((bucketExpected, key) => {
        const [
            pageIndexText,
            subtype,
        ] = key.split(':');
        const page = doc.getPages()[Number(pageIndexText)];
        const annots = page?.node.Annots();
        const allCandidates = annots
            ? Array.from(iterateAnnotationRefDicts(doc, annots))
                .filter(({
                    ref,
                    dict,
                }) => (
                    !knownRefs.has(`${ref.objectNumber}:${ref.generationNumber}`)
                    && dict.get(PDFName.of('Subtype')) === PDFName.of(subtype!)
                ))
            : [];
        const expectedIds = new Set(bucketExpected
            .map(comment => comment.appAnnotationId)
            .filter((value): value is string => Boolean(value)));
        const alreadyBoundIds = new Set(allCandidates
            .map(({dict}) => annotationName(dict))
            .filter((value): value is string => typeof value === 'string' && expectedIds.has(value)));
        allCandidates.forEach(({
            dict,
            ref,
        }) => {
            const boundAnnotationId = annotationName(dict);
            if (!boundAnnotationId || !alreadyBoundIds.has(boundAnnotationId)) {
                return;
            }
            evidence.onIdentityBound?.({
                annotationId: boundAnnotationId,
                pdfRef: formatPdfJsAnnotationRef(ref),
            });
        });
        const pendingExpected = bucketExpected.filter(comment => (
            !comment.appAnnotationId || !alreadyBoundIds.has(comment.appAnnotationId)
        ));
        const candidates = allCandidates.filter(({dict}) => {
            const name = annotationName(dict);
            return !name || !alreadyBoundIds.has(name);
        });
        if (candidates.length !== pendingExpected.length) {
            throw new Error(
                `Canonical annotation identity binding mismatch for ${key}: expected ${pendingExpected.length}, found ${candidates.length}`,
            );
        }
        let expectedInSerializationOrder = pendingExpected;
        if (pendingExpected.length > 1) {
            const editorOrder = evidence.newPdfJsAnnotationEditorOrder ?? [];
            const orderIndexByUid = new Map<string, number>();
            editorOrder.forEach((uid, index) => {
                if (orderIndexByUid.has(uid)) {
                    throw new Error(`Duplicate PDF.js editor serialization identity ${uid}`);
                }
                orderIndexByUid.set(uid, index);
            });
            const ordered = pendingExpected.map((comment) => {
                const uid = comment.uid;
                const orderIndex = uid ? orderIndexByUid.get(uid) : undefined;
                if (orderIndex === undefined) {
                    throw new Error(
                        `Canonical annotation identity binding is ambiguous for ${key}: missing explicit PDF.js editor order`,
                    );
                }
                return {
                    comment,
                    orderIndex,
                };
            }).sort((left, right) => left.orderIndex - right.orderIndex);
            if (new Set(ordered.map(item => item.orderIndex)).size !== ordered.length) {
                throw new Error(`Canonical annotation identity binding has duplicate order evidence for ${key}`);
            }
            expectedInSerializationOrder = ordered.map(item => item.comment);
        }
        candidates.forEach(({
            dict,
            ref,
        }, index) => {
            const annotationId = expectedInSerializationOrder[index]?.appAnnotationId;
            if (!annotationId) {
                throw new Error(`Canonical annotation identity is missing for ${key}`);
            }
            dict.set(PDFName.of('NM'), PDFHexString.fromText(annotationId));
            evidence.onIdentityBound?.({
                annotationId,
                pdfRef: formatPdfJsAnnotationRef(ref),
            });
            modified = true;
        });
    });
    return modified;
}

export async function bindCanonicalAnnotationIdentitiesInBytes(
    bytes: Uint8Array,
    comments: readonly IAnnotationCommentSummary[],
    program: readonly IBackendAnnotationMutation[],
    evidence: ICanonicalAnnotationIdentityBindingEvidence = {},
) {
    if (!program.some(mutation => mutation.operation === 'bind-identities')) {
        return bytes;
    }
    const doc = await PDFDocument.load(bytes, {updateMetadata: false});
    if (!applyCanonicalAnnotationIdentityBindings(doc, comments, program, evidence)) {
        return bytes;
    }
    return new Uint8Array(await doc.save());
}
