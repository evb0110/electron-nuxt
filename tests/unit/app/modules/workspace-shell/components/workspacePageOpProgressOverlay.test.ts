import {readFileSync} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

describe('WorkspacePageOpProgressOverlay', () => {
    it('shows indeterminate progress for page operations without batch metrics', () => {
        const source = readFileSync(
            resolve(
                repoRoot,
                'app/modules/workspace-shell/components/WorkspacePageOpProgressOverlay.vue',
            ),
            'utf8',
        );

        expect(source).toContain('<AppProgressOverlay');
        expect(source).toContain(':open="isPageOperationInProgress"');
        expect(source).toContain('progress === null ? t(\'pageOps.operationInProgress\')');
        expect(source).toContain(':value="progress?.percent ?? null"');
        expect(source).not.toContain('<AppProgressChip');
        expect(source).not.toContain('progress !== null && isPageOperationInProgress');
    });
});
