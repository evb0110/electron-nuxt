import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

// The diagnostics harnesses build product manifests and launch the real
// sidecar, so they are part of the runnable inventory: every manifest they
// write is root-constrained, and every native invocation carries the same
// root. These scripts need Poppler, the native binary, and a PDF corpus to
// run, so the wiring is pinned at the source rather than by executing them.
// The assertions are per call site: a script that constrained one manifest
// twice and another not at all must fail here.
interface IDiagnosticsScript {
    path: string;
    /** Directory each manifest built by this script is scoped to. */
    scopedRoot: string;
    /** Expression the argv builder passes after `--allowed-path-root`. */
    argvRoot: string;
    /**
     * Set when native launches go through a local helper instead of inline
     * argv, so the scoped root reaches argv through a parameter.
     */
    launcher?: {
        name: string;
        rootArgumentIndex: number;
    };
}

const scripts: IDiagnosticsScript[] = [
    {
        path: 'scripts/diagnostics/scan-cleanup-corpus-verify.mjs',
        scopedRoot: 'fixtureDir',
        argvRoot: 'allowedPathRoot',
        launcher: {
            name: 'runSidecar',
            rootArgumentIndex: 1,
        },
    },
    {
        path: 'scripts/diagnostics/scan-cleanup-preview-harness.mjs',
        scopedRoot: 'pageDirectory',
        argvRoot: 'pageDirectory',
    },
];

const CLOSERS: Record<string, string> = {
    '(': ')',
    '[': ']',
};

/**
 * Return the balanced text that starts at `openIndex`, so a call argument list
 * or array literal can be examined without pulling in a neighbouring one.
 */
function balancedSlice(source: string, openIndex: number) {
    const opener = source[openIndex]!;
    const closer = CLOSERS[opener]!;
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
        const character = source[index];
        if (character === opener) depth += 1;
        else if (character === closer) {
            depth -= 1;
            if (depth === 0) {
                return source.slice(openIndex, index + 1);
            }
        }
    }
    throw new Error(`Unbalanced ${opener} at offset ${String(openIndex)}`);
}

/** Argument text of every call to `callee`, excluding its own declaration. */
function callArguments(source: string, callee: string) {
    const calls: string[] = [];
    const pattern = new RegExp(`\\b${callee}\\s*\\(`, 'gu');
    for (const match of source.matchAll(pattern)) {
        const openIndex = match.index + match[0].length - 1;
        const preceding = source.slice(0, match.index).trimEnd();
        if (preceding.endsWith('function')) continue;
        calls.push(balancedSlice(source, openIndex));
    }
    return calls;
}

/** Split a balanced argument list or array literal into top-level entries. */
function topLevelEntries(balanced: string) {
    const inner = balanced.slice(1, -1);
    const entries: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < inner.length; index += 1) {
        const character = inner[index]!;
        if ('([{'.includes(character)) depth += 1;
        else if (')]}'.includes(character)) depth -= 1;
        else if (character === ',' && depth === 0) {
            entries.push(inner.slice(start, index).trim());
            start = index + 1;
        }
    }
    entries.push(inner.slice(start).trim());
    return entries.filter(entry => entry !== '');
}

/** Every array literal that contains a `'--manifest'` entry. */
function manifestArgvLiterals(source: string) {
    const literals: string[] = [];
    for (let index = source.indexOf('['); index !== -1; index = source.indexOf('[', index + 1)) {
        const literal = balancedSlice(source, index);
        if (!topLevelEntries(literal).includes('\'--manifest\'')) continue;
        literals.push(literal);
        index += literal.length - 1;
    }
    return literals;
}

describe('scan cleanup diagnostics manifest roots', () => {
    it.each(scripts)('$path scopes every manifest and native launch to $scopedRoot', async script => {
        const source = await readFile(resolve(script.path), 'utf8');

        // Geometry-only construction skips path containment entirely, so it has
        // no place in a script that hands its manifest to the native binary.
        expect(source).not.toContain('buildGeometryOnlyNativeScanCleanupManifest');

        const builders = callArguments(source, 'buildRunnableNativeScanCleanupManifest');
        expect(builders.length).toBeGreaterThan(0);
        for (const builder of builders) {
            const roots = topLevelEntries(topLevelEntries(builder)[0]!)
                .filter(entry => entry.startsWith('allowedPathRoot:'));
            expect(roots).toEqual([`allowedPathRoot: ${script.scopedRoot}`]);
        }

        const argvLiterals = manifestArgvLiterals(source);
        expect(argvLiterals.length).toBeGreaterThan(0);
        for (const argv of argvLiterals) {
            const entries = topLevelEntries(argv);
            const flagIndex = entries.indexOf('\'--allowed-path-root\'');
            expect(flagIndex).toBeGreaterThanOrEqual(0);
            expect(entries[flagIndex + 1]).toBe(script.argvRoot);
        }

        if (script.launcher === undefined) {
            // Argv is built at the launch site, so the scoped root must be the
            // expression argv already carries.
            expect(script.argvRoot).toBe(script.scopedRoot);
            // A cloned manifest may be launched again, so launches are not
            // bounded by builders here; each one was checked above.
            expect(argvLiterals.length).toBeGreaterThanOrEqual(builders.length);
            return;
        }

        // The scoped root reaches argv through the launcher's parameter, so the
        // parameter name must be what argv passes and every call must supply
        // the scoped root in that position.
        const [declaration] = source.match(
            new RegExp(`function\\s+${script.launcher.name}\\s*\\([^)]*\\)`, 'u'),
        ) ?? [];
        expect(declaration).toBeDefined();
        const parameters = topLevelEntries(balancedSlice(declaration!, declaration!.indexOf('(')));
        expect(parameters[script.launcher.rootArgumentIndex]).toBe(script.argvRoot);

        const launches = callArguments(source, script.launcher.name);
        expect(launches.length).toBeGreaterThan(0);
        expect(launches).toHaveLength(builders.length);
        for (const launch of launches) {
            expect(topLevelEntries(launch)[script.launcher.rootArgumentIndex]).toBe(script.scopedRoot);
        }
    });
});
