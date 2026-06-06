import { defineConfig } from 'vitest/config';
import AutoImport from 'unplugin-auto-import/vite';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';

const explicitImportOnlyFiles = [
    'app/composables/pdf/annotationNoteWindowHelpers.ts',
    'app/composables/pdf/annotations/useAnnotationIdentity.ts',
    'app/composables/pdf/pdfSerializationOperations.ts',
] as const;

export default defineConfig({
    plugins: [AutoImport({
        imports: [
            'vue',
            { 'vue-i18n': ['useI18n'] },
        ],
        dirsScanOptions: {fileFilter: (file) => {
            const normalizedFile = file.replaceAll('\\', '/');
            return !explicitImportOnlyFiles.some((explicitImportOnlyFile) => normalizedFile.endsWith(explicitImportOnlyFile));
        }},
        dirs: ['app/composables/**'],
    })],
    resolve: {alias: vitestResolveAlias},
    test: {
        include: [
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
        ],
        exclude: ['tests/unit/electron/bundleIntegrity.test.ts'],
        globals: false,
        setupFiles: ['tests/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: [
                'text',
                'lcov',
            ],
            thresholds: {
                statements: 54,
                branches: 42,
                functions: 55,
                lines: 54,
                'electron/**/*.ts': {
                    statements: 58,
                    branches: 46,
                    functions: 57,
                    lines: 58,
                },
                'app/composables/page/**/*.ts': {
                    statements: 68,
                    branches: 60,
                    functions: 50,
                    lines: 68,
                },
            },
        },
    },
});
