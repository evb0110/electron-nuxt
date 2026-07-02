export const stylisticRules = {
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

export const strictTypeRules = {
    '@typescript-eslint/consistent-type-imports': [
        'error',
        {
            prefer: 'type-imports',
            fixStyle: 'separate-type-imports',
        },
    ],
    '@typescript-eslint/consistent-type-exports': 'error',
    '@typescript-eslint/no-import-type-side-effects': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-unnecessary-type-arguments': 'error',
    '@typescript-eslint/no-unnecessary-type-constraint': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': [
        'error',
        {
            checksVoidReturn: {
                arguments: false,
                attributes: false,
            },
        },
    ],
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/return-await': [
        'error',
        'in-try-catch',
    ],
    '@typescript-eslint/only-throw-error': 'error',
    '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignoreConditionalTests: true },
    ],
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

export const namingRules = {
    '@typescript-eslint/naming-convention': [
        'error',
        {
            selector: 'typeAlias',
            format: ['PascalCase'],
            custom: {
                regex: '^[IT][A-Z]',
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
};

export const arrayTypeRules = {
    '@typescript-eslint/array-type': [
        'error',
        {
            default: 'array-simple',
            readonly: 'array-simple',
        },
    ],
};
