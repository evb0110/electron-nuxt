import { readFileSync } from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readWorkspaceFile(path: string) {
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function cssRule(source: string, selector: string) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(source);
    return match?.groups?.body ?? '';
}

describe('app shell status-row geometry', () => {
    it('reserves one status-bar row before and after teleported content arrives', () => {
        const styles = readWorkspaceFile('app/modules/workspace-shell/components/AppShellRoot.css');
        const hostRule = cssRule(styles, '.editor-global-status-host');
        const emptyRule = cssRule(styles, '.editor-global-status-host:empty');

        expect(hostRule).toContain('height: var(--app-statusbar-height)');
        expect(hostRule).toContain('min-height: var(--app-statusbar-height)');
        expect(hostRule).toContain('flex: 0 0 var(--app-statusbar-height)');
        expect(emptyRule).not.toMatch(/(?:height|min-height|flex-basis)\s*:\s*0/u);
        expect(emptyRule).toContain('background: var(--app-status-bar-bg)');
        expect(emptyRule).toContain('var(--app-statusbar-divider-width)');
    });

    it('keeps the reserved row hidden for tool pages and zen mode', () => {
        const template = readWorkspaceFile('app/modules/workspace-shell/components/AppShellRoot.vue');
        const styles = readWorkspaceFile('app/modules/workspace-shell/components/AppShellRoot.css');

        expect(template).toContain(
            '<div v-show="!activeToolPage" id="editor-global-status-host" class="editor-global-status-host" />',
        );
        expect(styles).toMatch(
            /\.app-shell-root\.is-zen-mode[^{]*\.editor-global-status-host\s*\{\s*display:\s*none;/su,
        );
    });

    it('keeps the empty reservation non-interactive and unnamed', () => {
        const template = readWorkspaceFile('app/modules/workspace-shell/components/AppShellRoot.vue');
        const host = template.match(/<div v-show="!activeToolPage" id="editor-global-status-host"[^>]*\/>/u)?.[0] ?? '';

        expect(host).not.toContain('role=');
        expect(host).not.toContain('tabindex=');
        expect(host).not.toContain('aria-label=');
    });
});
