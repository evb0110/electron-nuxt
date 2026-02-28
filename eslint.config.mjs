import withNuxt from './.nuxt/eslint.config.mjs';
import stylistic from '@stylistic/eslint-plugin';
import fs from 'node:fs';
import path from 'node:path';
import customPlugin from './eslint-plugin-custom.mjs';

const stylisticRules = {
    '@stylistic/indent': [
        'error',
        4,
    ],
    '@stylistic/quotes': [
        'error',
        'single',
    ],
    '@stylistic/semi': [
        'error',
        'always',
    ],
    '@stylistic/comma-dangle': [
        'error',
        'always-multiline',
    ],
    '@stylistic/array-bracket-newline': [
        'error',
        { minItems: 2 },
    ],
    '@stylistic/array-element-newline': [
        'error',
        { minItems: 2 },
    ],
    '@stylistic/object-curly-newline': [
        'error',
        { minProperties: 2 },
    ],
    '@stylistic/object-property-newline': [
        'error',
        { allowAllPropertiesOnSameLine: false },
    ],
};

const strictTypeRules = {
    '@typescript-eslint/consistent-type-imports': [
        'error',
        {
            prefer: 'type-imports',
            fixStyle: 'separate-type-imports',
        },
    ],
    '@typescript-eslint/consistent-type-exports': 'error',
    '@typescript-eslint/no-import-type-side-effects': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-unnecessary-type-constraint': 'error',
    '@typescript-eslint/ban-ts-comment': [
        'error',
        {
            'ts-ignore': true,
            'ts-nocheck': true,
            'ts-check': false,
            'ts-expect-error': 'allow-with-description',
            minimumDescriptionLength: 8,
        },
    ],
};

const FEATURE_PUBLIC_ENTRYPOINT_EXCEPTIONS = [
    './index.ts',
    './index.tsx',
    './index.js',
    './index.mjs',
    './public.ts',
    './public.tsx',
    './public.js',
    './public.mjs',
    './public/index.ts',
    './public/index.tsx',
    './public/index.js',
    './public/index.mjs',
];

function readFeatureDirectories(relativeRoot) {
    const absoluteRoot = path.join(import.meta.dirname, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) {
        return [];
    }

    return fs.readdirSync(absoluteRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

function createCrossFeatureZones(relativeRoot, zoneMessagePrefix) {
    const features = readFeatureDirectories(relativeRoot);
    if (features.length < 2) {
        return [];
    }

    return features.map(targetFeature => ({
        target: `./${relativeRoot}/${targetFeature}`,
        from: features
            .filter(feature => feature !== targetFeature)
            .map(feature => `./${relativeRoot}/${feature}`),
        except: FEATURE_PUBLIC_ENTRYPOINT_EXCEPTIONS,
        message: `${zoneMessagePrefix} cross-feature imports must use public entrypoints.`,
    }));
}

export default withNuxt(
    {ignores: [
        '**/.devkit/**',
        'eslint.config.mjs',
        'stylelint.config.mjs',
        'nuxt.config.ts',
        'landing/nuxt.config.ts',
        'landing/drizzle.config.ts',
    ]},
    {
        plugins: {
            '@stylistic': stylistic,
            custom: customPlugin,
        },
        rules: {
            'vue/no-multiple-template-root': 'off',
            'vue/html-self-closing': 'off',
            'vue/no-undef-properties': [
                'error',
                {
                    ignores: ['/^\\$/u'],
                },
            ],
            '@typescript-eslint/unified-signatures': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-inferrable-types': 'error',
            'no-return-await': 'error',
            'import/no-relative-parent-imports': 'error',
            'import/no-cycle': [
                'error',
                {
                    ignoreExternal: true,
                    maxDepth: Infinity,
                },
            ],
            'import/no-restricted-paths': [
                'error',
                {
                    basePath: import.meta.dirname,
                    zones: [
                        {
                            target: './electron',
                            from: './app',
                            message: 'electron/** must not import app/**.',
                        },
                        {
                            target: './landing',
                            from: './app',
                            message: 'landing/** must not import app/**.',
                        },
                        {
                            target: './landing',
                            from: './electron',
                            message: 'landing/** must not import electron/**.',
                        },
                        {
                            target: './electron',
                            from: './landing',
                            message: 'electron/** must not import landing/**.',
                        },
                        {
                            target: './app/services',
                            from: './app/composables',
                            message: 'app/services/** must not import app/composables/**.',
                        },
                        {
                            target: './packages',
                            from: './app',
                            message: 'packages/** must not import app/**.',
                        },
                        {
                            target: './packages',
                            from: './electron',
                            message: 'packages/** must not import electron/**.',
                        },
                        {
                            target: './packages',
                            from: './landing',
                            message: 'packages/** must not import landing/**.',
                        },
                        {
                            target: './scripts',
                            from: './electron',
                            message: 'scripts/** must not import electron/**.',
                        },
                        ...createCrossFeatureZones('app/modules', 'app/modules'),
                        ...createCrossFeatureZones('electron/features', 'electron/features'),
                    ],
                },
            ],
            'no-restricted-imports': [
                'error',
                {patterns: [
                    {
                        group: ['./*'],
                        message: 'Use absolute imports with @app/ or @electron/ prefix instead of relative imports',
                    },
                    {
                        group: [
                            '@i18n-core/*',
                            '@i18n-app/*',
                            '@release-selection/*',
                        ],
                        message: 'Import shared packages via their root entrypoint to keep package APIs slim.',
                    },
                ]},
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'TSAsExpression[expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
                    message: 'Avoid "as unknown as" double assertion. Use a type guard, generic parameter, or fix the underlying type instead.',
                },
            ],
            '@typescript-eslint/no-empty-object-type': [
                'error',
                { allowInterfaces: 'with-single-extends' },
            ],
            'custom/brace-return-after-if': 'error',
            'custom/import-specifier-newline': 'error',
            'custom/destructuring-property-newline': 'error',
            ...stylisticRules,
        },
    },
    {
        files: [
            'packages/**/*.ts',
            'scripts/**/*.mjs',
        ],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        files: [
            '**/*.ts',
            '**/*.tsx',
        ],
        ignores: [
            '*.config.ts',
            '*.config.mts',
            '*.config.mjs',
            'eslint.config.mjs',
            'nuxt.config.ts',
            'landing/*.config.ts',
            'electron/**',
            'tests/**',
            'scripts/**/*.ts',
            '**/*.d.ts',
        ],
        languageOptions: {parserOptions: {projectService: true}},
        rules: {
            ...strictTypeRules,
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^T[A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {paths: [{
                    name: 'vue',
                    message: 'Vue APIs are auto-imported by Nuxt. Use them directly without importing. Type imports (import type) are still allowed.',
                    allowTypeImports: true,
                }]},
            ],
        },
    },
    {
        files: ['scripts/**/*.ts'],
        languageOptions: {parserOptions: {
            project: ['./tsconfig.scripts.json'],
            tsconfigRootDir: import.meta.dirname,
        }},
        rules: {
            ...strictTypeRules,
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^T[A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            'no-return-await': 'off',
            'no-empty': 'off',
            'no-restricted-imports': 'off',
        },
    },
    {
        files: ['electron/**/*.ts'],
        languageOptions: {parserOptions: {
            project: ['./electron/tsconfig.json'],
            tsconfigRootDir: import.meta.dirname,
        }},
        rules: {
            ...strictTypeRules,
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^[TI][A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
            '@typescript-eslint/require-await': 'off',
        },
    },
    {
        files: ['tests/**/*.ts'],
        languageOptions: {parserOptions: {
            project: ['./tests/tsconfig.json'],
            tsconfigRootDir: import.meta.dirname,
        }},
        rules: {
            ...strictTypeRules,
            'no-restricted-imports': 'off',
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^T[A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
            '@typescript-eslint/require-await': 'off',
        },
    },
    {
        files: ['landing/app/pages/**/*.vue'],
        rules: {
            'vue/multi-word-component-names': 'off',
        },
    },
    {
        files: ['**/*.vue'],
        plugins: {custom: customPlugin},
        languageOptions: {parserOptions: {projectService: true}},
        rules: {
            ...strictTypeRules,
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^T[A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
            'vue/no-restricted-syntax': [
                'error',
                {
                    selector:
                        'VExpressionContainer > * Identifier[name="$props"]',
                    message:
                        'Use destructured props from defineProps() instead of $props',
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'Identifier[name="$props"]',
                    message:
                        'Use destructured props from defineProps() instead of $props',
                },
                {
                    selector: 'Identifier[name="withDefaults"]',
                    message:
                        'use props destructuring. beware that withDefaults is not compatible with destructured props. Use default values in destructuring pattern directly, vue 3.5 supports them',
                },
                {
                    selector: 'TSAsExpression[expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
                    message: 'Avoid "as unknown as" double assertion. Use a type guard, generic parameter, or fix the underlying type instead.',
                },
            ],
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {paths: [{
                    name: 'vue',
                    message: 'Vue APIs are auto-imported by Nuxt. Use them directly without importing. Type imports (import type) are still allowed.',
                    allowTypeImports: true,
                }]},
            ],
            'custom/vue-boolean-prop-shorthand': 'error',
            'custom/brace-return-after-if': 'error',
            'custom/no-scss-ampersand-concatenation': 'error',
            'custom/nuxt-ui-semantic-utilities': 'error',
            'custom/tailwind-class-shorthand': 'error',
        },
    },
);
