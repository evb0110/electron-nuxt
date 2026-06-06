import type {
    IPdfConformanceProfile,
    TPdfSaveMode,
} from '@app/types/pdf';

export function shouldForcePdfSaveAs(
    mode: TPdfSaveMode,
    profile: IPdfConformanceProfile | null,
    requiresSaveAsOnFirstSave: boolean,
) {
    if (requiresSaveAsOnFirstSave) {
        return true;
    }
    if (!profile?.isSigned) {
        return false;
    }

    return mode === 'rewrite' || mode === 'save_as_rewrite';
}
