import {
    readFile,
    readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const COMPONENTS_DIR = join(process.cwd(), 'app/modules/agent-panel/components');

const PANEL_STYLESHEETS = [
    'AgentAssistantPanel.shell.css',
    'AgentAssistantPanel.composer.css',
];

const CLASS_SELECTOR_PATTERN = /\.([A-Za-z][\w-]*)/gu;
const CLASS_ATTRIBUTE_PATTERN = /\sclass="([^"]*)"/gu;

/**
 * The panel imports both stylesheets with `<style scoped>`, so every rule in
 * them is compiled with the panel's own `data-v-*` attribute. A child component
 * never carries that attribute on anything but its root element, and a child
 * that renders a fragment carries it nowhere at all. A class the child puts on
 * its own markup therefore has to be defined by the child (or by a global
 * stylesheet), never only by the panel: the panel's copy silently does not
 * match, and the element renders unstyled at the browser's default type size.
 */
function collectClassNames(css: string) {
    return new Set([...css.matchAll(CLASS_SELECTOR_PATTERN)].map(match => match[1]!));
}

function collectTemplateClasses(source: string) {
    const template = source.split('<template>')[1]?.split('</template>')[0] ?? '';
    const used = new Set<string>();
    for (const match of template.matchAll(CLASS_ATTRIBUTE_PATTERN)) {
        for (const token of match[1]!.split(/\s+/u)) {
            if (token) {
                used.add(token);
            }
        }
    }
    return used;
}

function collectOwnStyleClasses(source: string) {
    const ownStyles = source.split('<style').slice(1).join('<style');
    return collectClassNames(ownStyles);
}

describe('agent panel scoped style ownership', () => {
    it('keeps child component classes out of the panel-only scoped stylesheets', async () => {
        const panelClasses = collectClassNames(
            (await Promise.all(
                PANEL_STYLESHEETS.map(file => readFile(join(COMPONENTS_DIR, file), 'utf8')),
            )).join('\n'),
        );
        expect(panelClasses.size).toBeGreaterThan(0);

        const childComponents = (await readdir(COMPONENTS_DIR))
            .filter(file => file.startsWith('Assistant') && file.endsWith('.vue'));
        expect(childComponents.length).toBeGreaterThan(0);

        const borrowed: Record<string, string[]> = {};
        for (const file of childComponents) {
            const source = await readFile(join(COMPONENTS_DIR, file), 'utf8');
            const ownClasses = collectOwnStyleClasses(source);
            const unowned = [...collectTemplateClasses(source)]
                .filter(token => panelClasses.has(token) && !ownClasses.has(token))
                .sort();
            if (unowned.length > 0) {
                borrowed[file] = unowned;
            }
        }

        expect(borrowed).toEqual({});
    });
});
