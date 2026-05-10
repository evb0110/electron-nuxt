import {
    describe,
    it,
} from 'vitest';
import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';

const customPlugin = (await import(new URL('../../../eslint-plugin-custom.mjs', import.meta.url).href)).default;

const tester = new RuleTester({languageOptions: {
    parser: vueParser,
    ecmaVersion: 2022,
    sourceType: 'module',
}});

const rules = (customPlugin as { rules: Record<string, unknown> }).rules;

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
