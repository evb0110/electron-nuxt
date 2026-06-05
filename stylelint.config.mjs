export default {
    extends: [
        'stylelint-config-standard-scss',
        'stylelint-config-recommended-vue/scss',
    ],
    ignoreFiles: ['app/assets/css/vendor/**/*.css'],
    rules: {
        // Disallow SCSS parent selector concatenation (&- and &_)
        // Vue scoped styles eliminate the need for BEM - use flat class names
        'selector-nested-pattern': '^(?!&[-_])',

        // Allow any class naming pattern
        'selector-class-pattern': null,

        // Allow SCSS partials with leading underscore
        'scss/load-no-partial-leading-underscore': null,

        // Don't enforce modern color notation (rgba -> rgb)
        'color-function-notation': null,
        'color-function-alias-notation': null,
        'alpha-value-notation': null,

        // Don't enforce precision limits
        'number-max-precision': null,

        // Keep !important rare. PDF.js override boundary files are exempted below,
        // and local exceptions must carry a narrow stylelint disable rationale.
        'declaration-no-important': true,
    },
    overrides: [
        {
            files: ['app/assets/css/**/*.{css,scss}'],
            rules: {
                'scss/at-rule-no-unknown': null,
                'hue-degree-notation': null,
                'custom-property-empty-line-before': null,
                'color-hex-length': null,
                'value-keyword-case': null,
                'selector-id-pattern': null,
                'property-no-vendor-prefix': null,
                'declaration-empty-line-before': null,
                'custom-property-pattern': null,
                'rule-empty-line-before': null,
                'no-duplicate-selectors': null,
                'no-descending-specificity': null,
            },
        },
        {
            files: [
                'app/assets/css/pdfjs-overrides.scss',
            ],
            rules: {
                'declaration-no-important': null,
            },
        },
    ],
};
