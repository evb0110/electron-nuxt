import {
    normalizeCanonicalApplicationModule,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';

const MAX_DEBUG_ID_ENTRIES = 4_096;
const SENTRY_DEBUG_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const REPORTABLE_BUNDLE_ROOTS = new Set([
    '_nuxt',
    'dist-electron',
    'server-bundle',
]);

export interface ISentrySourceMapDebugImage {
    type: 'sourcemap';
    code_file: string;
    debug_id: string;
}

function isReportableBundleModule(value: string) {
    const root = value.split('/', 1)[0];
    return root !== undefined && REPORTABLE_BUNDLE_ROOTS.has(root);
}

function normalizePrivateRuntimePath(value: string): string | null {
    let candidate = value.trim();
    try {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(candidate)) {
            candidate = new URL(candidate).pathname;
        }
        candidate = decodeURIComponent(candidate.split(/[?#]/u, 1)[0] ?? '')
            .replaceAll('\\', '/');
    } catch {
        return null;
    }
    const segments = candidate.split('/').filter(segment => segment.length > 0 && segment !== '.');
    if (
        segments.length === 0
        || segments.some(segment => segment === '..' || hasUnsafeCharacters(segment))
    ) {
        return null;
    }
    return segments.join('/');
}

function moduleSuffixes(module: string) {
    return module.startsWith('server-bundle/')
        ? [
            module,
            module.slice('server-bundle/'.length),
        ]
        : [module];
}

function hasUnsafeCharacters(value: string) {
    return value.split('').some(character => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
    });
}

/**
 * Joins Sentry CLI's runtime filename-to-Debug-ID map to already-sanitized
 * diagnostic frames. Raw runtime paths and injected stack strings never leave
 * this function.
 */
export function buildSentrySourceMapDebugImages(
    frames: readonly CanonicalAppFrame[],
    filenameToDebugId: Readonly<Record<string, string>>,
): ISentrySourceMapDebugImage[] {
    const entries = Object.entries(filenameToDebugId);
    if (entries.length > MAX_DEBUG_ID_ENTRIES) {
        return [];
    }

    const candidates: Array<{
        canonicalModule: string | null;
        debugId: string;
        runtimePath: string;
    }> = [];
    for (const [
        filename,
        debugId,
    ] of entries) {
        if (!SENTRY_DEBUG_ID_PATTERN.test(debugId)) {
            continue;
        }
        const runtimePath = normalizePrivateRuntimePath(filename);
        if (runtimePath === null) {
            continue;
        }
        candidates.push({
            canonicalModule: normalizeCanonicalApplicationModule(filename),
            debugId,
            runtimePath,
        });
    }

    const images: ISentrySourceMapDebugImage[] = [];
    const seenModules = new Set<string>();
    for (const frame of frames) {
        if (seenModules.has(frame.module) || !isReportableBundleModule(frame.module)) {
            continue;
        }
        seenModules.add(frame.module);
        const suffixes = moduleSuffixes(frame.module);
        const matchingDebugIds = new Set(candidates.flatMap(candidate => (
            candidate.canonicalModule === frame.module
            || suffixes.some(suffix => (
                candidate.runtimePath === suffix
                || candidate.runtimePath.endsWith(`/${suffix}`)
            ))
                ? [candidate.debugId]
                : []
        )));
        if (matchingDebugIds.size === 1) {
            images.push({
                type: 'sourcemap',
                code_file: frame.module,
                debug_id: [...matchingDebugIds][0]!,
            });
        }
    }
    return images;
}
