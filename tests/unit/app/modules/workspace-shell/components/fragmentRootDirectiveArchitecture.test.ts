import {
    readdirSync,
    readFileSync,
} from 'node:fs';
import {
    basename,
    join,
    relative,
    resolve,
} from 'node:path';
import {
    NodeTypes,
    type RootNode,
    type TemplateChildNode,
} from '@vue/compiler-core';
import {parse as parseDom} from '@vue/compiler-dom';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../../../..');
const appRoot = resolve(repoRoot, 'app');
const consumerRoots = [
    'app/modules/workspace-shell',
    'app/modules/pdf-viewer',
    'app/modules/scan-cleanup',
].map(path => resolve(repoRoot, path));
const compileTimeDirectiveNames = new Set([
    'bind',
    'cloak',
    'else',
    'else-if',
    'for',
    'html',
    'if',
    'memo',
    'model',
    'on',
    'once',
    'pre',
    'slot',
    'text',
]);

function listVueFiles(root: string): string[] {
    return readdirSync(root, {withFileTypes: true}).flatMap(entry => {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            return listVueFiles(path);
        }
        return entry.isFile() && entry.name.endsWith('.vue') ? [path] : [];
    });
}

function parseTemplate(path: string): RootNode | null {
    const source = readFileSync(path, 'utf8');
    const templateStart = source.search(/<template(?:\s[^>]*)?>/u);
    if (templateStart < 0) {
        return null;
    }
    const contentStart = source.indexOf('>', templateStart) + 1;
    const scriptStart = source.indexOf('<script', contentStart);
    const searchEnd = scriptStart < 0 ? source.length : scriptStart;
    const contentEnd = source.lastIndexOf('</template>', searchEnd);
    if (contentStart <= 0 || contentEnd < contentStart) {
        return null;
    }
    try {
        return parseDom(source.slice(contentStart, contentEnd));
    } catch (error) {
        throw new Error(`Could not parse ${relative(repoRoot, path)} for fragment-root directive audit`, {cause: error});
    }
}

function significantRootChildren(root: RootNode) {
    return root.children.filter(node => (
        node.type !== NodeTypes.COMMENT
        && (node.type !== NodeTypes.TEXT || node.content.trim() !== '')
    ));
}

function collectFragmentRootComponents() {
    const components = new Map<string, string[]>();
    for (const path of listVueFiles(appRoot)) {
        const root = parseTemplate(path);
        if (!root) continue;
        const children = significantRootChildren(root);
        const soleRoot = children.length === 1 ? children[0] : null;
        const isFragment = children.length !== 1
            || (soleRoot?.type === NodeTypes.ELEMENT && soleRoot.tag === 'template');
        if (!isFragment) continue;
        const componentName = basename(path, '.vue');
        components.set(componentName, [
            ...(components.get(componentName) ?? []),
            relative(repoRoot, path),
        ]);
    }
    return components;
}

function walkTemplate(node: RootNode | TemplateChildNode, visit: (node: TemplateChildNode) => void) {
    if (node.type !== NodeTypes.ROOT) visit(node);
    if (node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT) {
        for (const child of node.children) walkTemplate(child, visit);
    }
}

describe('fragment-root runtime directive architecture', () => {
    it('does not apply v-show or custom runtime directives to fragment-root components', () => {
        // Pragmatic source-level guard: Vue SFC templates are parsed to discover
        // multi-root component files, then component uses in the three viewer
        // trees are checked for v-show and non-built-in directives. Components
        // imported under a different local name remain a documented limitation.
        const fragmentComponents = collectFragmentRootComponents();
        const violations: string[] = [];

        for (const consumerPath of consumerRoots.flatMap(listVueFiles)) {
            const root = parseTemplate(consumerPath);
            if (!root) continue;
            walkTemplate(root, node => {
                if (node.type !== NodeTypes.ELEMENT || !fragmentComponents.has(node.tag)) {
                    return;
                }
                for (const prop of node.props) {
                    if (prop.type !== NodeTypes.DIRECTIVE) continue;
                    const isRuntimeDirective = prop.name === 'show'
                        || !compileTimeDirectiveNames.has(prop.name);
                    if (!isRuntimeDirective) continue;
                    violations.push(
                        `${relative(repoRoot, consumerPath)}: <${node.tag} v-${prop.name}> targets fragment root in ${fragmentComponents.get(node.tag)?.join(', ')}`,
                    );
                }
            });
        }

        expect(violations).toEqual([]);
    });
});
