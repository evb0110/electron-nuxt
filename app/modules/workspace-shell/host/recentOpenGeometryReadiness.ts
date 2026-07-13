import { readPrevalidatedTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/public/openGeometry';
import { readPrevalidatedTrustedDjvuOpenGeometry } from '@app/modules/djvu-viewer/public/openGeometry';

export type TRecentOpenGeometryState = 'pending' | 'ready' | 'cold-fallback';

const states = shallowRef<ReadonlyMap<string, TRecentOpenGeometryState>>(new Map());
const exactGeometryFingerprints = new Map<string, string>();

function writeState(path: string, state: TRecentOpenGeometryState) {
    const next = new Map(states.value);
    next.set(path, state);
    states.value = next;
}

/**
 * Marks the bounded paths being prepared. Geometry readiness is diagnostic:
 * opening a Recent file remains a valid command even on the cold path.
 */
export function beginRecentOpenGeometryPrewarm(paths: Iterable<string>) {
    for (const path of paths) {
        exactGeometryFingerprints.delete(path);
        writeState(path, 'pending');
    }
}

function readCachedExactGeometry(path: string) {
    if (/\.pdf$/iu.test(path)) {
        return readPrevalidatedTrustedPdfOpenGeometry(path, 1);
    }
    if (/\.djvu?$/iu.test(path)) {
        return readPrevalidatedTrustedDjvuOpenGeometry(path, 1);
    }
    return null;
}

function getGeometryFingerprint(geometry: NonNullable<ReturnType<typeof readCachedExactGeometry>>) {
    return [
        geometry.documentId,
        geometry.pageNumber,
        geometry.pageCount,
        geometry.width,
        geometry.height,
        geometry.rotation,
        geometry.size,
        geometry.modifiedAt,
    ].join(':');
}

export function settleRecentOpenGeometryPrewarm(
    path: string,
    state: Exclude<TRecentOpenGeometryState, 'pending'>,
) {
    const geometry = state === 'ready' ? readCachedExactGeometry(path) : null;
    if (!geometry) {
        exactGeometryFingerprints.delete(path);
        writeState(path, 'cold-fallback');
        return;
    }
    exactGeometryFingerprints.set(path, getGeometryFingerprint(geometry));
    writeState(path, 'ready');
}

export function readRecentOpenExactGeometry(path: string, sourceRevision?: {
    modifiedAt: number | undefined;
    size: number | undefined;
}) {
    if (readRecentOpenGeometryState(path) !== 'ready') {
        return null;
    }
    const geometry = readCachedExactGeometry(path);
    const preparedFingerprint = exactGeometryFingerprints.get(path);
    if (!geometry || preparedFingerprint !== getGeometryFingerprint(geometry)) {
        return null;
    }
    return sourceRevision && (
        sourceRevision.size !== geometry.size
        || sourceRevision.modifiedAt !== geometry.modifiedAt
    ) ? null : geometry;
}

export function readRecentOpenGeometryState(path: string): TRecentOpenGeometryState {
    return states.value.get(path) ?? 'cold-fallback';
}

export function isRecentOpenGeometryActionable(path: string) {
    return readRecentOpenGeometryState(path) !== 'pending';
}

export function isRecentOpenGeometryExactFrameReady(path: string) {
    return readRecentOpenExactGeometry(path) !== null;
}
