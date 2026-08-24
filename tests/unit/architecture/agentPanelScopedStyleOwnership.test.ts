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
const GLOBAL_STYLESHEET = join(process.cwd(), 'app/assets/css/main.css');

const PANEL_STYLESHEETS = [
    'AgentAssistantPanel.shell.css',
    'AgentAssistantPanel.composer.css',
];

const CLASS_SELECTOR_PATTERN = /\.([A-Za-z][\w-]*)/gu;
// Static class attributes only. A `:class` binding is an expression, not a list
// of names, and its tokens are checked where the expression is written.
const CLASS_ATTRIBUTE_PATTERN = /\sclass="([^"]*)"/gu;

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
    return collectClassNames(source.split('<style').slice(1).join('<style'));
}

/**
 * The panel imports both of its stylesheets with `<style scoped>`, so every rule
 * in them compiles with the panel's own `data-v-*` attribute. A child component
 * never carries that attribute on anything but its root element, and a child
 * that renders a fragment carries it nowhere at all. So a class a child puts on
 * its own markup has to be styled by the child itself or by the global
 * stylesheet: a rule left behind in the panel silently stops matching, and the
 * element renders unstyled at the browser's default type size.
 *
 * This holds the whole condition rather than just the panel half. Deleting a
 * child's local rule fails here too, which is the same defect arriving by a
 * different route.
 */
describe('agent panel scoped style ownership', () => {
    it('styles every child component class locally or globally, never from the panel stylesheets', async () => {
        const [
            panelCss,
            globalCss,
            componentDirectory,
        ] = await Promise.all([
            Promise.all(PANEL_STYLESHEETS.map(file => readFile(join(COMPONENTS_DIR, file), 'utf8'))),
            readFile(GLOBAL_STYLESHEET, 'utf8'),
            readdir(COMPONENTS_DIR),
        ]);
        const panelClasses = collectClassNames(panelCss.join('\n'));
        const globalClasses = collectClassNames(globalCss);
        expect(panelClasses.size).toBeGreaterThan(0);
        expect(globalClasses.size).toBeGreaterThan(0);

        const childComponents = componentDirectory
            .filter(file => file.startsWith('Assistant') && file.endsWith('.vue'));
        expect(childComponents.length).toBeGreaterThan(0);

        const unstyled: Record<string, string[]> = {};
        for (const file of childComponents) {
            const source = await readFile(join(COMPONENTS_DIR, file), 'utf8');
            const ownClasses = collectOwnStyleClasses(source);
            const missing = [...collectTemplateClasses(source)]
                .filter(token => !ownClasses.has(token) && !globalClasses.has(token))
                .map(token => (panelClasses.has(token)
                    ? `${token} (styled only by the panel stylesheets)`
                    : token))
                .sort();
            if (missing.length > 0) {
                unstyled[file] = missing;
            }
        }

        expect(unstyled).toEqual({});
    });
});
