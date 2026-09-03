import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {ESLint} from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';

const customPlugin = (await import(new URL('../../../eslint-plugin-custom.mjs', import.meta.url).href)).default;

const sentryRules = {
    'custom/no-raw-red-presentation': 'error',
    'custom/no-direct-console-error': 'error',
    'custom/require-failure-receipt': 'error',
    'custom/require-classified-error-log': 'error',
    'custom/no-unclassified-diagnostic-code': 'error',
} as const;

const sentryFilePatterns = [
    'app/**/*.{ts,vue}',
    'electron/**/*.ts',
    'landing/**/*.{ts,vue}',
    'server/**/*.ts',
];
interface ISentryLintMessage {
    column?: number;
    line?: number;
    message: string;
    ruleId: string | null;
    severity: number;
}

interface ISentryLintResult {messages: ISentryLintMessage[];}

function createSentryEslint() {
    return new ESLint({
        cwd: process.cwd(),
        overrideConfigFile: true,
        overrideConfig: [
            {
                files: ['**/*.ts'],
                languageOptions: {
                    parser: tsParser,
                    parserOptions: {
                        ecmaVersion: 2022,
                        sourceType: 'module',
                    },
                },
                plugins: {custom: customPlugin},
                rules: sentryRules,
            },
            {
                files: ['**/*.vue'],
                languageOptions: {
                    parser: vueParser,
                    parserOptions: {
                        ecmaVersion: 2022,
                        parser: tsParser,
                        sourceType: 'module',
                    },
                },
                plugins: {custom: customPlugin},
                rules: sentryRules,
            },
        ],
    });
}

function getSentryMessages(results: ISentryLintResult[]) {
    return results.flatMap(result => result.messages)
        .filter(message => message.ruleId && message.ruleId in sentryRules);
}

function createMigrationReport(name: string, messages: ISentryLintMessage[]) {
    return {
        name,
        count: messages.length,
        entries: messages.map(message => ({
            column: message.column,
            line: message.line,
            message: message.message,
            ruleId: message.ruleId,
        })),
    };
}

function printMigrationReport(report: ReturnType<typeof createMigrationReport>) {
    console.warn(JSON.stringify({
        count: report.count,
        entries: report.entries,
        name: report.name,
    }));
}

async function lintFixture(code: string, filePath: string) {
    const eslint = createSentryEslint();
    const [result] = await eslint.lintText(code, {filePath: path.resolve(filePath)});
    if (!result) {
        throw new Error(`ESLint produced no result for ${filePath}`);
    }
    return result.messages;
}

describe('SEN-GATE-01 blocking rules', () => {
    it('keeps the red-presentation and unclassified-code reports at zero', async () => {
        const eslint = createSentryEslint();
        const results = await eslint.lintFiles(sentryFilePatterns);
        const messages = getSentryMessages(results);
        const redMessages = messages.filter(message => message.ruleId === 'custom/no-raw-red-presentation');
        const unclassifiedMessages = messages.filter(message => (
            message.ruleId === 'custom/no-direct-console-error'
            || message.ruleId === 'custom/require-failure-receipt'
        ));
        const redReport = createMigrationReport('red-presentation', redMessages);
        const unclassifiedReport = createMigrationReport('unclassified-code', unclassifiedMessages);

        printMigrationReport(redReport);
        printMigrationReport(unclassifiedReport);

        expect(messages.every(message => message.severity === 2)).toBe(true);
        expect(redReport.count).toBe(0);
        expect(unclassifiedReport.count).toBe(0);
    }, 60_000);

    it('blocks raw red presenters and allows the shared presenter owners', async () => {
        await expect(lintFixture(
            'const toast = useToast();\ntoast.add({color: \'error\', title: \'Failure\'});',
            'app/components/RawFailureToast.ts',
        )).resolves.toMatchObject([{
            ruleId: 'custom/no-raw-red-presentation',
            severity: 2,
        }]);
        await expect(lintFixture(
            '<template><UAlert color="error" /></template>',
            'app/components/RawFailureAlert.vue',
        )).resolves.toMatchObject([{
            ruleId: 'custom/no-raw-red-presentation',
            severity: 2,
        }]);
        await expect(lintFixture(
            'const toast = useToast();\ntoast.add({color: \'error\', title: \'Failure\'});',
            'app/composables/useFailureToast.ts',
        )).resolves.not.toContainEqual(expect.objectContaining({ruleId: 'custom/no-raw-red-presentation'}));
        await expect(lintFixture(
            '<template><UAlert color="error" /></template>',
            'app/components/AppFatalRuntimeDialog.vue',
        )).resolves.not.toContainEqual(expect.objectContaining({ruleId: 'custom/no-raw-red-presentation'}));
        await expect(lintFixture(
            '<template><UAlert color="error" /></template>',
            'app/components/AppFailureAlert.vue',
        )).resolves.not.toContainEqual(expect.objectContaining({ruleId: 'custom/no-raw-red-presentation'}));
    });

    it('blocks direct console.error and keeps only the documented sinks exempt', async () => {
        await expect(lintFixture(
            'console.error(error);',
            'app/components/FailureBoundary.ts',
        )).resolves.toContainEqual(expect.objectContaining({
            ruleId: 'custom/no-direct-console-error',
            severity: 2,
        }));
        for (const filePath of [
            'app/utils/browserLogger.ts',
            'app/utils/consoleErrorObserver.ts',
            'electron/preload/installDebugLogListener.ts',
        ]) {
            await expect(lintFixture('console.error(error);', filePath)).resolves.not.toContainEqual(
                expect.objectContaining({ruleId: 'custom/no-direct-console-error'}),
            );
        }
        await expect(lintFixture(
            'console.error(error);',
            'electron/preload.ts',
        )).resolves.toContainEqual(expect.objectContaining({ruleId: 'custom/no-direct-console-error'}));
        await expect(lintFixture(
            'console.error(error);',
            'tests/fixtures/consoleError.test.ts',
        )).resolves.not.toContainEqual(expect.objectContaining({ruleId: 'custom/no-direct-console-error'}));
    });

    it('blocks receipt-free runtime and fatal presentation while accepting receipt-bearing calls', async () => {
        await expect(lintFixture(
            'reportRuntimeError({title: \'Failure\', source: \'test\', error});\nsetFatalRuntimeError(\'runtime\', error, \'test\');',
            'app/components/LegacyFailurePresentation.ts',
        )).resolves.toHaveLength(2);
        const receiptAwareSource = [
            'reportRuntimeError({failure: receipt, title: \'Failure\'});',
            'setFatalRuntimeError({failure: receipt, title: \'Failure\'});',
            'setFatalRuntimeError(\'runtime\', {failure: receipt, title: \'Failure\'});',
        ].join('\n');
        await expect(lintFixture(
            receiptAwareSource,
            'app/components/ReceiptFailurePresentation.ts',
        )).resolves.not.toContainEqual(expect.objectContaining({ruleId: 'custom/require-failure-receipt'}));
    });

    it('blocks unclassified error logs while accepting codes and receipts', async () => {
        await expect(lintFixture(
            'BrowserLogger.error(\'scope\', \'failed\', error);\nlogger.error(\'failed\');',
            'app/components/UnclassifiedErrors.ts',
        )).resolves.toHaveLength(2);
        await expect(lintFixture(
            'BrowserLogger.error(\'scope\', \'failed\', error, {code: \'RENDERER_WORKSPACE_OPERATION_FAILED\', context: {}});\nlogger.error(\'failed\', receipt);',
            'app/components/ClassifiedErrors.ts',
        )).resolves.not.toContainEqual(expect.objectContaining({ruleId: 'custom/require-classified-error-log'}));
        await expect(lintFixture(
            'reporter.capture({code: \'UNCLASSIFIED_RENDERER_ERROR\', context: {}});',
            'app/components/GenericDiagnosticCode.ts',
        )).resolves.toContainEqual(expect.objectContaining({ruleId: 'custom/no-unclassified-diagnostic-code'}));
    });
});
