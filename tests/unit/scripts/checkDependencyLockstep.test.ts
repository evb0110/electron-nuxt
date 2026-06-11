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

function createPackageJson(overrides: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
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
            'vue-i18n': '^11.4.4',
            ...overrides.devDependencies,
        },
        pnpm: {overrides: {
            '@nuxt/cli': '3.35.1',
            '@tiptap/y-tiptap': '3.0.4',
            '@vue/compiler-sfc': '3.5.35',
            ...overrides.pnpmOverrides,
        }},
    };
}

function createLockfile(overrides: Record<string, string> = {}) {
    const lockfileOverrides = {
        '@nuxt/cli': '3.35.1',
        '@tiptap/y-tiptap': '3.0.4',
        '@vue/compiler-sfc': '3.5.35',
        ...overrides,
    };
    const overrideLines = Object.entries(lockfileOverrides)
        .map(([
            packageName,
            version,
        ]) => `  '${packageName}': ${version}`)
        .join('\n');

    return parsePnpmLockfile(`
lockfileVersion: '9.0'

overrides:
${overrideLines}

packages:

  '@nuxt/cli@3.35.1':
    resolution: {integrity: sha512-test}

  '@tiptap/y-tiptap@3.0.4':
    resolution: {integrity: sha512-test}

  '@vue/compiler-sfc@3.5.35':
    resolution: {integrity: sha512-test}

snapshots:

  '@nuxt/cli@3.35.1(@nuxt/schema@4.4.2)':
    dependencies: {}

  '@tiptap/y-tiptap@3.0.4(prosemirror-model@1.25.7)':
    dependencies: {}

  '@vue/compiler-sfc@3.5.35':
    dependencies: {}
`);
}

function runCheck(packageOverrides: Parameters<typeof createPackageJson>[0] = {}) {
    return checkDependencyLockstep({
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
        expect(runCheck({pnpmOverrides: {'@stale/package': '1.0.0'}})).toContain('pnpm.overrides.@stale/package targets @stale/package, but that package is not resolved in pnpm-lock.yaml.');
    });

    it('checks the range forms used by vue-i18n policy', () => {
        expect(versionRangeIncludesVersion('^11.4.4', '11.4.4')).toBe(true);
        expect(versionRangeIncludesVersion('>=11.0.0 <12.0.0', '11.4.4')).toBe(true);
        expect(versionRangeIncludesVersion('^11.5.0', '11.4.4')).toBe(false);
    });
});
