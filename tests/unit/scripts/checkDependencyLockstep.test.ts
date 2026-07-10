import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    checkDependencyLockstep,
    parsePnpmLockfile,
    versionRangeIncludesVersion,
    type IDependencyLockstepInput,
} from '@scripts/checkDependencyLockstep';

const DEFAULT_OVERRIDES = {
    '@babel/core': '7.29.6',
    '@nuxt/cli': '3.36.1',
    '@tiptap/y-tiptap': '3.0.4',
    '@vue/compiler-sfc': '3.5.35',
    '@eslint/config-inspector@^1.0.0>esbuild': '0.28.1',
    'bundle-require@^5.0.0>esbuild': '0.28.1',
    'fast-uri': '3.1.2',
    'fast-xml-builder': '1.1.7',
    'fontless@^0.2.0>esbuild': '0.28.1',
    'js-yaml': '4.2.0',
    'launch-editor': '2.14.1',
    'minimatch@^10.0.0>brace-expansion': '5.0.7',
    'shell-quote': '1.8.4',
    tar: '7.5.19',
    'tsx@^4.0.0>esbuild': '0.28.1',
    'vite@^7.0.0>esbuild': '0.28.1',
    ws: '8.21.0',
};

function createPackageJson(overrides: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
    pnpmOverrides?: Record<string, string>;
} = {}): IDependencyLockstepInput['packageJson'] {
    return {
        dependencies: {
            '@intlify/core': '11.4.4',
            '@intlify/core-base': '11.4.4',
            '@intlify/message-compiler': '11.4.4',
            '@intlify/shared': '11.4.4',
            '@vue/compiler-core': '3.5.35',
            '@vue/compiler-dom': '3.5.35',
            '@vue/compiler-ssr': '3.5.35',
            '@vue/devtools-api': '8.1.2',
            '@vue/reactivity': '3.5.35',
            '@vue/runtime-core': '3.5.35',
            '@vue/runtime-dom': '3.5.35',
            '@vue/server-renderer': '3.5.35',
            '@vue/shared': '3.5.35',
            vue: '3.5.35',
            ...overrides.dependencies,
        },
        devDependencies: {
            '@nuxt/eslint': '^1.15.2',
            eslint: '^9.39.4',
            nuxt: '4.4.8',
            typescript: '^5.9.3',
            'vue-i18n': '^11.4.4',
            'vue-tsc': '3.3.3',
            ...overrides.devDependencies,
        },
        packageManager: overrides.packageManager ?? 'pnpm@10.32.1',
        pnpm: {overrides: {
            ...DEFAULT_OVERRIDES,
            ...overrides.pnpmOverrides,
        }},
    };
}

function createLandingPackageJson(overrides: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
    pnpmOverrides?: Record<string, string>;
} = {}): IDependencyLockstepInput['packageJson'] {
    return {
        dependencies: {
            nuxt: '4.4.8',
            'vue-i18n': '^11.4.4',
            ...overrides.dependencies,
        },
        devDependencies: {
            '@nuxt/eslint': '1.15.2',
            eslint: '^9.39.4',
            typescript: '^5.9.3',
            'vue-tsc': '^3.3.3',
            ...overrides.devDependencies,
        },
        packageManager: overrides.packageManager ?? 'pnpm@10.32.1',
        pnpm: {overrides: {
            ...DEFAULT_OVERRIDES,
            ...overrides.pnpmOverrides,
        }},
    };
}

function createLockfile(overrides: Record<string, string> = {}) {
    const lockfileOverrides = {
        ...DEFAULT_OVERRIDES,
        ...overrides,
    };
    const overrideLines = Object.entries(lockfileOverrides)
        .map(([
            packageName,
            version,
        ]) => `  '${packageName}': ${version}`)
        .join('\n');
    const resolvedPackages = new Map<string, string>();
    for (const [
        overrideKey,
        version,
    ] of Object.entries(DEFAULT_OVERRIDES)) {
        const target = overrideKey.split('>').at(-1) ?? overrideKey;
        const versionSeparator = target.startsWith('@')
            ? target.indexOf('@', target.indexOf('/') + 1)
            : target.indexOf('@');
        const packageName = versionSeparator === -1 ? target : target.slice(0, versionSeparator);

        resolvedPackages.set(packageName, version);
    }
    const packageLines = [...resolvedPackages]
        .map(([
            packageName,
            version,
        ]) => `  '${packageName}@${version}':\n    resolution: {integrity: sha512-test}`)
        .join('\n\n');

    return parsePnpmLockfile(`
lockfileVersion: '9.0'

overrides:
${overrideLines}

packages:

${packageLines}
`);
}

function runCheck(packageOverrides: Parameters<typeof createPackageJson>[0] = {}) {
    return checkDependencyLockstep({
        landingLockfile: createLockfile(packageOverrides.pnpmOverrides),
        landingPackageJson: createLandingPackageJson(packageOverrides),
        lockfile: createLockfile(packageOverrides.pnpmOverrides),
        packageJson: createPackageJson(packageOverrides),
    });
}

describe('dependency lockstep check', () => {
    it('accepts the current Vue, intlify, vue-i18n, and override policy shape', () => {
        expect(runCheck()).toEqual([]);
    });

    it('rejects a partial Vue family bump', () => {
        expect(runCheck({dependencies: {'@vue/runtime-dom': '3.5.36'}})).toContain('@vue/runtime-dom must match dependencies.vue (3.5.35), received "3.5.36".');
    });

    it('rejects a Vue compiler-sfc override that drifts from the root Vue pin', () => {
        expect(runCheck({pnpmOverrides: {'@vue/compiler-sfc': '3.5.36'}})).toEqual(expect.arrayContaining([
            'pnpm.overrides.@vue/compiler-sfc must match dependencies.vue (3.5.35), received "3.5.36".',
            'pnpm.overrides.@vue/compiler-sfc pins 3.5.36, but pnpm-lock.yaml resolves @vue/compiler-sfc at 3.5.35.',
        ]));
    });

    it('rejects intlify pins that drift from the runtime anchor', () => {
        expect(runCheck({dependencies: {'@intlify/message-compiler': '11.4.5'}})).toContain('@intlify/message-compiler must match @intlify/core (11.4.4), received "11.4.5".');
    });

    it('rejects vue-i18n ranges that exclude the intlify runtime pin', () => {
        expect(runCheck({devDependencies: {'vue-i18n': '^11.5.0'}})).toContain('vue-i18n range "^11.5.0" must include intlify runtime 11.4.4.');
    });

    it('rejects overrides that are not resolved in the lockfile graph', () => {
        expect(runCheck({pnpmOverrides: {'@stale/package': '1.0.0'}})).toContain('pnpm.overrides.@stale/package targets @stale/package, but that package is not resolved in either pnpm-lock.yaml or landing/pnpm-lock.yaml.');
    });

    it('rejects landing package manager and override drift from the root package', () => {
        expect(checkDependencyLockstep({
            landingLockfile: createLockfile(),
            landingPackageJson: createLandingPackageJson({
                packageManager: 'pnpm@10.32.2',
                pnpmOverrides: {'@nuxt/cli': '3.36.2'},
            }),
            lockfile: createLockfile(),
            packageJson: createPackageJson(),
        })).toEqual(expect.arrayContaining([
            'landing/package.json packageManager must match root package.json (pnpm@10.32.1), received "pnpm@10.32.2".',
            'landing/package.json pnpm.overrides.@nuxt/cli must match root package.json value "3.36.1", received "3.36.2".',
        ]));
    });

    it('rejects independent landing lockfile override drift', () => {
        expect(checkDependencyLockstep({
            landingLockfile: createLockfile({'js-yaml': '4.1.1'}),
            landingPackageJson: createLandingPackageJson(),
            lockfile: createLockfile(),
            packageJson: createPackageJson(),
        })).toContain('landing/pnpm-lock.yaml override js-yaml must match package.json value "4.2.0", received "4.1.1".');
    });

    it('rejects landing shared dependency anchor drift while allowing exact/range style differences', () => {
        expect(checkDependencyLockstep({
            landingLockfile: createLockfile(),
            landingPackageJson: createLandingPackageJson({devDependencies: {
                '@nuxt/eslint': '1.15.3',
                'vue-tsc': '^3.3.3',
            }}),
            lockfile: createLockfile(),
            packageJson: createPackageJson({devDependencies: {
                '@nuxt/eslint': '^1.15.2',
                'vue-tsc': '3.3.3',
            }}),
        })).toContain('landing package @nuxt/eslint must stay on root dependency anchor 1.15.2, received 1.15.3.');
    });

    it('checks the range forms used by vue-i18n policy', () => {
        expect(versionRangeIncludesVersion('^11.4.4', '11.4.4')).toBe(true);
        expect(versionRangeIncludesVersion('>=11.0.0 <12.0.0', '11.4.4')).toBe(true);
        expect(versionRangeIncludesVersion('^11.5.0', '11.4.4')).toBe(false);
    });
});
