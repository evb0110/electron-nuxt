import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createCollectionHints,
    extractBundledIconsFromConfig,
    extractIconsFromScriptContent,
    extractIconsFromTemplateContent,
    extractIconsFromVueSfcContent,
} from '@scripts/checkIconBundle';

const COLLECTION_HINTS = createCollectionHints(['ph']);

describe('checkIconBundle extractors', () => {
    it('extracts direct and bound icon values from template expressions', () => {
        const template = `
            <section>
                <UIcon name="i-ph-file-text" />
                <UIcon :name="isLoading ? 'i-ph-circle-notch' : 'i-ph-info'" />
                <UButton :icon="isGitHub ? 'i-simple-icons-github' : \`ph:floppy-disk\`" />
            </section>
        `;

        expect(extractIconsFromTemplateContent(template, COLLECTION_HINTS)).toEqual([
            'ph:circle-notch',
            'ph:file-text',
            'ph:floppy-disk',
            'ph:info',
            'simple-icons:github',
        ]);
    });

    it('extracts icon values from v-bind object expression in template', () => {
        const template = `
            <UButton v-bind="{ icon: 'i-ph-play', trailingIcon: 'i-ph-check-circle', title: 'Play' }" />
        `;

        expect(extractIconsFromTemplateContent(template, COLLECTION_HINTS)).toEqual([
            'ph:check-circle',
            'ph:play',
        ]);
    });

    it('extracts icon values from script object and assignment contexts', () => {
        const scriptContent = `
            const directKnown = 'ph:folder-open';
            const menuItem = {
                icon: 'i-simple-icons-github',
                trailingIcon: 'i-ph-arrow-right',
                label: 'GitHub'
            };
            const ignoredUnknown = 'i-simple-icons-gitlab';
            panel.name = 'i-ph-file-text';
            const typedMenu = { ['leadingIcon']: 'i-simple-icons-vue-dot-js' } as const satisfies Record<string, string>;
            const jsxButton = <UButton icon="i-ph-download-simple" />;
        `;

        expect(extractIconsFromScriptContent(scriptContent, COLLECTION_HINTS)).toEqual([
            'ph:arrow-right',
            'ph:download-simple',
            'ph:file-text',
            'ph:folder-open',
            'simple-icons:github',
            'simple-icons:vue-dot-js',
        ]);
    });

    it('falls back to context-aware quoted token extraction when script parsing fails', () => {
        const scriptContent = `
            const menuItem = { icon: 'i-simple-icons-github',
            const ignoredUnknown = 'i-simple-icons-gitlab';
        `;

        expect(extractIconsFromScriptContent(scriptContent, COLLECTION_HINTS)).toEqual(['simple-icons:github']);
    });

    it('extracts icons from script setup and template when parsing a full SFC', () => {
        const sfcContent = `
            <template>
                <UButton :icon="isBusy ? 'i-ph-circle-notch' : actionIcon" />
            </template>
            <script setup lang="ts">
            const actionIcon = 'i-ph-play';
            const quick = { icon: 'i-simple-icons-github' };
            </script>
        `;

        expect(extractIconsFromVueSfcContent(sfcContent, COLLECTION_HINTS)).toEqual([
            'ph:circle-notch',
            'ph:play',
            'simple-icons:github',
        ]);
    });

    it('extracts bundled icons only from clientBundle.icons', () => {
        const configContent = `
            const strayIcon = 'ph:trash';

            export default defineNuxtConfig({
                app: { head: { link: [{ href: 'ph:file' }] } },
                runtimeConfig: {
                    clientBundle: { icons: ['ph:warning'] },
                },
                icon: {
                    provider: 'iconify',
                    clientBundle: {
                        scan: true,
                        icons: [
                            'ph:file-text',
                            \`ph:check\`,
                            dynamicIcon,
                        ],
                    },
                },
            });
        `;

        expect(Array.from(extractBundledIconsFromConfig(configContent)).sort()).toEqual([
            'ph:check',
            'ph:file-text',
        ]);
    });
});
