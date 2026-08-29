import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeStagedCommitOptions,
} from '@contracts/electronApiDocuments';
import {isRecord} from '@contracts/runtimeGuards';

const MAX_NATIVE_MARKUP_IDENTITY_BINDINGS = 4_096;
const MAX_NATIVE_MARKUP_ANNOTATION_ID_LENGTH = 2_048;
const PDF_NATIVE_IDENTITY_BINDING_REF_PATTERN = /^([1-9]\d*) ([0-9]+) R$/u;

interface IPdfNativeIdentityBindingValidationOptions {errorKind?: 'typeError' | 'error';}

function failIdentityBindingValidation(
    message: string,
    options: IPdfNativeIdentityBindingValidationOptions,
): never {
    throw options.errorKind === 'error' ? new Error(message) : new TypeError(message);
}

/** Strictly decode the bounded identity report emitted by native markup. */
export function normalizePdfNativeAnnotationIdentityBindings(
    value: unknown,
    label = 'identityBindings',
    options: IPdfNativeIdentityBindingValidationOptions = {},
): IPdfNativeAnnotationIdentityBinding[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > MAX_NATIVE_MARKUP_IDENTITY_BINDINGS) {
        failIdentityBindingValidation(
            `${label} must be an array with at most ${MAX_NATIVE_MARKUP_IDENTITY_BINDINGS} items`,
            options,
        );
    }
    const annotationIds = new Set<string>();
    const pdfRefs = new Set<string>();
    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            failIdentityBindingValidation(`${label}[${index}] must be an object`, options);
        }
        const keys = Object.keys(entry).sort();
        if (keys.length !== 2 || keys[0] !== 'annotationId' || keys[1] !== 'pdfRef') {
            failIdentityBindingValidation(
                `${label}[${index}] must contain only annotationId and pdfRef`,
                options,
            );
        }
        if (
            typeof entry.annotationId !== 'string'
            || entry.annotationId.trim().length === 0
            || entry.annotationId.length > MAX_NATIVE_MARKUP_ANNOTATION_ID_LENGTH
        ) {
            failIdentityBindingValidation(
                `${label}[${index}].annotationId must be a bounded non-empty string`,
                options,
            );
        }
        const annotationId = entry.annotationId.trim();
        if (annotationIds.has(annotationId)) {
            failIdentityBindingValidation(`${label} contains a duplicate annotation identity`, options);
        }
        annotationIds.add(annotationId);
        if (typeof entry.pdfRef !== 'string') {
            failIdentityBindingValidation(
                `${label}[${index}].pdfRef must be a canonical PDF object reference`,
                options,
            );
        }
        const pdfRef = entry.pdfRef.trim();
        const match = PDF_NATIVE_IDENTITY_BINDING_REF_PATTERN.exec(pdfRef);
        if (!match) {
            failIdentityBindingValidation(
                `${label}[${index}].pdfRef must use the canonical N G R form`,
                options,
            );
        }
        const objectNumber = Number(match[1]);
        const generationNumber = Number(match[2]);
        if (!Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generationNumber)) {
            failIdentityBindingValidation(
                `${label}[${index}].pdfRef must contain safe integer object numbers`,
                options,
            );
        }
        if (pdfRefs.has(pdfRef)) {
            failIdentityBindingValidation(`${label} contains a duplicate PDF object reference`, options);
        }
        pdfRefs.add(pdfRef);
        return {
            annotationId,
            pdfRef,
        };
    });
}

export function appendPdfNativeAnnotationIdentityBindings(
    options: IPdfNativeStagedCommitOptions,
    value: unknown,
    label: string,
): IPdfNativeStagedCommitOptions {
    if (!isRecord(value) || value.identityBindings === undefined) {
        return options;
    }
    return {
        ...options,
        identityBindings: normalizePdfNativeAnnotationIdentityBindings(
            value.identityBindings,
            `${label}.identityBindings`,
        ),
    };
}
