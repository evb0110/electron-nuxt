import type { TDocumentRef } from '@contracts/documentRef';

export interface IPdfRasterSourcePagePixels {
    width: number;
    height: number;
}

export interface ITrustedRasterDjvuPdfDisplayProfile {
    kind: 'trusted-raster-djvu';
    sourcePagePixels: ReadonlyArray<IPdfRasterSourcePagePixels | null>;
}

export type TPdfRasterDisplayProfile = ITrustedRasterDjvuPdfDisplayProfile;

export interface IPdfRasterDisplayProfileOpenOptions {rasterDisplayProfile?: TPdfRasterDisplayProfile | null | undefined;}

const registeredRasterDisplayProfiles = new Map<TDocumentRef, TPdfRasterDisplayProfile>();

function normalizePositivePixelDimension(value: unknown) {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value > 0
        ? Math.max(1, Math.round(value))
        : null;
}

export function normalizePdfRasterSourcePagePixels(value: {
    width?: unknown;
    height?: unknown;
}): IPdfRasterSourcePagePixels | null {
    const width = normalizePositivePixelDimension(value.width);
    const height = normalizePositivePixelDimension(value.height);
    if (width === null || height === null) {
        return null;
    }
    return {
        width,
        height,
    };
}

export function resolvePdfRasterSourceMaxPixels(
    profile: TPdfRasterDisplayProfile | null | undefined,
    pageNumber: number,
) {
    if (!profile || profile.kind !== 'trusted-raster-djvu') {
        return null;
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return null;
    }

    const pagePixels = normalizePdfRasterSourcePagePixels(
        profile.sourcePagePixels[pageNumber - 1] ?? {},
    );
    return pagePixels ? pagePixels.width * pagePixels.height : null;
}

export function registerPdfRasterDisplayProfile(
    documentRef: TDocumentRef | null | undefined,
    profile: TPdfRasterDisplayProfile | null | undefined,
) {
    if (!documentRef || !profile) {
        return;
    }
    registeredRasterDisplayProfiles.set(documentRef, profile);
}

export function resolveRegisteredPdfRasterDisplayProfile(
    ...documentRefs: Array<TDocumentRef | null | undefined>
): TPdfRasterDisplayProfile | null {
    for (const documentRef of documentRefs) {
        if (!documentRef) {
            continue;
        }
        const profile = registeredRasterDisplayProfiles.get(documentRef);
        if (profile) {
            return profile;
        }
    }
    return null;
}

export function clearRegisteredPdfRasterDisplayProfilesForTests() {
    registeredRasterDisplayProfiles.clear();
}
