import {
    describe,
    it,
} from 'vitest';
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';

const customPlugin = (await import(new URL('../../../eslint-plugin-custom.mjs', import.meta.url).href)).default;

const tester = new RuleTester({languageOptions: {
    parser: vueParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { parser: tsParser },
}});

const rules = (customPlugin as { rules: Record<string, unknown> }).rules;

describe('no-relative-imports rule', () => {
    it('rejects static, dynamic, re-export, and type import sources', () => {
        tester.run(
            'no-relative-imports',
            rules['no-relative-imports'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: 'import { value } from \'@app/utils/value\';' },
                    { code: 'const module = import(\'@scripts/task\');' },
                    { code: 'type TModule = typeof import(\'@contracts\');' },
                ],
                invalid: [
                    {
                        code: 'import { value } from \'./value\';',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                    {
                        code: 'export { value } from \'../value\';',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                    {
                        code: 'const module = import(\'./value\');',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                    {
                        code: 'type TModule = typeof import(\'../value\');',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                ],
            },
        );
    });
});

describe('arrow-composable rule', () => {
    it('reports exported composable declarations and function expressions', () => {
        tester.run(
            'arrow-composable',
            rules['arrow-composable'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: 'export const useFoo = () => value;' },
                    { code: 'function useInternal() { return value; }' },
                    { code: 'export function buildFoo() { return value; }' },
                ],
                invalid: [
                    {
                        code: 'export function useFoo(options: IOptions) { return options; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export async function useFoo<T>(options: T): Promise<T> { return options; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nuseFoo();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'const value = useFoo();\nexport function useFoo() { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo(value: string): string;\nexport function useFoo(value: string) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'function useFoo() { return value; }\nexport { useFoo };',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export default function useFoo() { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'function useFoo() { return value; }\nexport default useFoo;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export const useFoo = function () { return value; };',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'const useFoo = function () { return value; };\nexport { useFoo };',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                ],
            },
        );
    });

    it('reports unsafe function semantics without autofix', () => {
        tester.run(
            'arrow-composable',
            rules['arrow-composable'] as Parameters<typeof tester.run>[1],
            {
                valid: [],
                invalid: [
                    {
                        code: 'export function useFoo(this: Ctx, value: number) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return this.value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return arguments[0]; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return new.target; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo(value = arguments[0]) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo(value = this.value) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo({ value = new.target } = {}) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nnew useFoo();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nuseFoo.prototype.extra = 1;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nuseFoo = () => 2;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nnew (useFoo as any)();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\n(useFoo as any).prototype.extra = 1;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nclass Child extends useFoo {}',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nclass Child extends (useFoo as any) {}',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nvalue instanceof useFoo;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nReflect.construct(useFoo, []);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nnew (condition ? useFoo : Other)();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nclass Child extends (condition ? useFoo : Base) {}',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nvalue instanceof (condition ? useFoo : Other);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nReflect[\'construct\'](useFoo, []);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nReflect.construct(Date, [], useFoo);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                ],
            },
        );
    });
});

describe('vue-define-emits-tuple rule', () => {
    it('converts defineEmits call signatures to tuple properties', () => {
        tester.run(
            'vue-define-emits-tuple',
            rules['vue-define-emits-tuple'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<script setup lang="ts">const emit = defineEmits<{save: [];}>();</script>' },
                    { code: '<script setup lang="ts">const emit = defineEmits<IEmits>();</script>' },
                    { code: '<script setup lang="ts">const emit = defineEmits<{<T>(e: \'select\', value: T): void;}>();</script>' },
                ],
                invalid: [
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'activate\'): void;}>();</script>',
                        output: '<script setup lang="ts">const emit = defineEmits<{activate: [];}>();</script>',
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: `<script setup lang="ts">
const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'resize-start', event: PointerEvent): void;
}>();
</script>`,
                        output: `<script setup lang="ts">
const emit = defineEmits<{
    'update:open': [value: boolean];
    'resize-start': [event: PointerEvent];
}>();
</script>`,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{save: []; (e: \'cancel\'): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'cancel\');}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'save\', value): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'save\', ...args): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e?: \'save\'): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(this: void, e: \'save\'): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: `<script setup lang="ts">
const emit = defineEmits<{
    // Fired after save.
    (e: 'save'): void;
}>();
</script>`,
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'save\\\\nnow\'): void;}>();</script>',
                        output: '<script setup lang="ts">const emit = defineEmits<{\'save\\\\nnow\': [];}>();</script>',
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                ],
            },
        );
    });
});

describe('nuxt-ui-semantic-utilities rule', () => {
    it('passes RuleTester valid/invalid scenarios', () => {
        tester.run(
            'nuxt-ui-semantic-utilities',
            rules['nuxt-ui-semantic-utilities'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><div class="text-default" /></template>' },
                    { code: '<template><div :class="`bg-muted`" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><div class="text-(--ui-text-muted)" /></template>',
                        output: '<template><div class="text-muted" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div :class="`bg-(--ui-bg-muted)`" /></template>',
                        output: '<template><div :class="`bg-muted`" /></template>',
                        errors: 1,
                    },
                ],
            },
        );
    });
});

describe('tailwind-class-shorthand rule', () => {
    it('passes RuleTester valid/invalid scenarios', () => {
        tester.run(
            'tailwind-class-shorthand',
            rules['tailwind-class-shorthand'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><div class="py-2" /></template>' },
                    { code: '<template><div :class="`px-3`" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><div class="pt-2 pb-2" /></template>',
                        output: '<template><div class="py-2" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div :class="`pl-3 pr-3`" /></template>',
                        output: '<template><div :class="`px-3`" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div class="px-2 px-2" /></template>',
                        output: '<template><div class="px-2" /></template>',
                        errors: 1,
                    },
                ],
            },
        );
    });
});

describe('app-tooltip-only rule', () => {
    it('rejects raw tooltip APIs but allows AppTooltip and component title props', () => {
        tester.run(
            'app-tooltip-only',
            rules['app-tooltip-only'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><AppTooltip text="Open"><button aria-label="Open" /></AppTooltip></template>' },
                    { code: '<template><UModal :title="title" /></template>' },
                    { code: '<template><PdfPanelEmptyState :title="title" /></template>' },
                    { code: '<template><button aria-label="Open" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><UTooltip text="Open"><button /></UTooltip></template>',
                        errors: [{ message: 'Use AppTooltip instead of UTooltip so tooltip usefulness is centralized.' }],
                    },
                    {
                        code: '<template><button title="Open" /></template>',
                        errors: [{ message: 'Do not use native title tooltips. Use AppTooltip for useful tooltips, or aria-label for accessibility-only labels.' }],
                    },
                    {
                        code: '<template><div :title="label" /></template>',
                        errors: [{ message: 'Do not use native title tooltips. Use AppTooltip for useful tooltips, or aria-label for accessibility-only labels.' }],
                    },
                ],
            },
        );
    });
});
