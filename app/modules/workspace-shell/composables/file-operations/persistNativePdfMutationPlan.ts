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
import type { INativePdfMutationPlan } from '@app/modules/pdf-viewer/public';

export interface IPersistNativePdfMutationPlanDeps {
    trySavePdfNativeMutations?: (
        mutations: IPdfNativeMutationSet,
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            modifiedAt: string;
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

export interface IPersistNativePdfMutationPlanOptions {
    saveMode: TPdfSaveMode;
    preserveLoadedSource: boolean;
    expectedWorkingPath: TDocumentRef;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    modifiedAt: string;
}

export function persistNativePdfMutationPlan(
    deps: IPersistNativePdfMutationPlanDeps,
    plan: INativePdfMutationPlan,
    opts: IPersistNativePdfMutationPlanOptions,
) {
    if (deps.trySavePdfNativeMutations) {
        return deps.trySavePdfNativeMutations(plan.mutations, opts);
    }
    if (plan.hasMetadataMutations || plan.hasShapeMutations || !deps.trySaveEmbeddedNoteTextUpdates) {
        return Promise.resolve(null);
    }
    return deps.trySaveEmbeddedNoteTextUpdates(plan.noteTextUpdates, {
        ...opts,
        ...(plan.freeTextNotes.length ? {freeTextNotes: plan.freeTextNotes} : {}),
        ...(plan.annotationDeletes.length ? {deletes: plan.annotationDeletes} : {}),
    });
}
