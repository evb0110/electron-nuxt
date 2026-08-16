import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('workspace document page-source bridge', () => {
    it('forwards the bound chassis source to workspace scope and the cleanup surface', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');

        expect(chassis).toContain('() => chassisAuthority.source.value');
        expect(chassis).toContain('source => emit(\'update:pageSource\', source)');
        expect(chassis).not.toContain('@update:page-source=');
        expect(chassis).toContain('\'update:pageSource\': [source: IDocumentPageSource | null]');
        expect(chassis).toContain('getCurrentPage: () => chassisAuthority.currentPage.value');
        expect(chassis).not.toContain('committedPage\n        ?? chassisAuthority.currentPage.value');
        expect(chassis).toContain('if (interaction.intent !== \'zoom\')');
        expect(chassis).toMatch(
            /if \(interaction\.intent !== 'zoom'\) \{[\s\S]*?observeUserInteraction\(\s*chassisAuthority\.viewportElement\.value \?\? undefined,\s*\);[\s\S]*?\}\s*chassisAuthority\.dispatchViewportWheel\(interaction\);/u,
        );
        expect(workspace).toContain('const documentPageSource = shallowRef<IDocumentPageSource | null>(null)');
        expect(workspace).toContain('onPageSourceUpdate: handlePageSourceUpdate');
        expect(workspace).toContain(':page-source="documentPageSource"');
    });
});
