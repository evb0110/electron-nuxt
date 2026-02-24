import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createCollectionHints,
    extractIconsFromScriptContent,
    extractIconsFromTemplateContent,
    extractIconsFromVueSfcContent,
} from '../../../scripts/check-icon-bundle';

const COLLECTION_HINTS = createCollectionHints(['lucide']);

describe('check-icon-bundle extractors', () => {
    it('extracts direct and bound icon values from template expressions', () => {
        const template = `
            <section>
                <UIcon name="i-lucide-file-text" />
                <UIcon :name="isLoading ? 'i-lucide-loader-circle' : 'i-lucide-info'" />
                <UButton :icon="isGitHub ? 'i-simple-icons-github' : \`lucide:save\`" />
            </section>
        `;

        expect(extractIconsFromTemplateContent(template, COLLECTION_HINTS)).toEqual([
            'lucide:file-text',
            'lucide:info',
            'lucide:loader-circle',
            'lucide:save',
            'simple-icons:github',
        ]);
    });

    it('extracts icon values from v-bind object expression in template', () => {
        const template = `
            <UButton v-bind="{ icon: 'i-lucide-play', trailingIcon: 'i-lucide-circle-check', title: 'Play' }" />
        `;

        expect(extractIconsFromTemplateContent(template, COLLECTION_HINTS)).toEqual([
            'lucide:circle-check',
            'lucide:play',
        ]);
    });

    it('extracts icon values from script object and assignment contexts', () => {
        const scriptContent = `
            const directKnown = 'lucide:folder-open';
            const menuItem = {
                icon: 'i-simple-icons-github',
                trailingIcon: 'i-lucide-arrow-right',
                label: 'GitHub'
            };
            const ignoredUnknown = 'i-simple-icons-gitlab';
            panel.name = 'i-lucide-file-text';
        `;

        expect(extractIconsFromScriptContent(scriptContent, COLLECTION_HINTS)).toEqual([
            'lucide:arrow-right',
            'lucide:file-text',
            'lucide:folder-open',
            'simple-icons:github',
        ]);
    });

    it('extracts icons from script setup and template when parsing a full SFC', () => {
        const sfcContent = `
            <template>
                <UButton :icon="isBusy ? 'i-lucide-loader-circle' : actionIcon" />
            </template>
            <script setup lang="ts">
            const actionIcon = 'i-lucide-play';
            const quick = { icon: 'i-simple-icons-github' };
            </script>
        `;

        expect(extractIconsFromVueSfcContent(sfcContent, COLLECTION_HINTS)).toEqual([
            'lucide:loader-circle',
            'lucide:play',
            'simple-icons:github',
        ]);
    });
});
