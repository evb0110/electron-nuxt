import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfPersistResult } from '@app/types/pdfUi';
import type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/public';

export interface IPersistNativePdfMutationProjectionDeps {
    trySavePdfNativeMutations?: (
        mutations: IPdfNativeMutationSet,
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            modifiedAt: string;
            verifyBeforeExpose?: (bytes: Uint8Array) => Promise<void>;
            assertBeforeExpose?: () => Promise<void> | void;
        },
    ) => Promise<IPdfPersistResult | null>;
    trySaveEmbeddedNoteTextUpdates?: (
        updates: IPdfNoteTextUpdate[],
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            modifiedAt: string;
            freeTextNotes?: IPdfNativeFreeTextNote[];
            deletes?: IPdfNativeAnnotationDelete[];
        },
    ) => Promise<IPdfPersistResult | null>;
}

export interface IPersistNativePdfMutationProjectionOptions {
    saveMode: TPdfSaveMode;
    preserveLoadedSource: boolean;
    expectedWorkingPath: TDocumentRef;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    modifiedAt: string;
    verifyBeforeExpose?: (bytes: Uint8Array) => Promise<void>;
    assertBeforeExpose?: () => Promise<void> | void;
}

/** Persists a backend projection; it does not own serialization policy. */
export function persistNativePdfMutationProjection(
    deps: IPersistNativePdfMutationProjectionDeps,
    projection: INativePdfMutationProjection,
    opts: IPersistNativePdfMutationProjectionOptions,
) {
    if (deps.trySavePdfNativeMutations) {
        return deps.trySavePdfNativeMutations(projection.mutations, opts);
    }
    if (projection.hasMetadataMutations || projection.hasShapeMutations || !deps.trySaveEmbeddedNoteTextUpdates) {
        return Promise.resolve(null);
    }
    return deps.trySaveEmbeddedNoteTextUpdates(projection.noteTextUpdates, {
        ...opts,
        ...(projection.freeTextNotes.length ? {freeTextNotes: projection.freeTextNotes} : {}),
        ...(projection.annotationDeletes.length ? {deletes: projection.annotationDeletes} : {}),
    });
}
