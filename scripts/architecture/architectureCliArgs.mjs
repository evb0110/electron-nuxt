import path from 'node:path';

function findNamedArg(argv, name) {
    return argv.find(argument => argument.startsWith(`--${name}=`)) ?? null;
}

function normalizeRootArg(value) {
    const trimmed = value.trim();
    if (!trimmed || path.isAbsolute(trimmed)) {
        return null;
    }

    const normalized = path.normalize(trimmed).replaceAll('\\', '/').split(path.sep).join('/');
    return normalized && !path.isAbsolute(normalized)
        ? normalized
        : null;
}

export function parseArchitectureRootsArg(argv) {
    const rootArg = findNamedArg(argv, 'roots');
    if (!rootArg) {
        return null;
    }

    return rootArg
        .slice('--roots='.length)
        .split(',')
        .map(normalizeRootArg)
        .filter(Boolean);
}

export function parseArchitectureScopeArg(argv, {defaultScope = 'all'} = {}) {
    const scopeArg = findNamedArg(argv, 'scope');
    if (!scopeArg) {
        return defaultScope;
    }

    const scope = scopeArg.slice('--scope='.length).trim().toLowerCase();
    if (scope === 'all' || scope === 'focused') {
        return scope;
    }

    throw new Error(`Unsupported --scope value: ${scopeArg}`);
}
