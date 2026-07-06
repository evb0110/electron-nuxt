import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('AppProgressOverlay visual policy', () => {
    it('keeps the underlying document visible while progress is active', async () => {
        const overlaySource = await readFile(
            join(process.cwd(), 'app/components/AppProgressOverlay.vue'),
            'utf8',
        );

        expect(overlaySource).toContain('background: color-mix(in oklab, var(--ui-bg-elevated) 42%, transparent);');
        expect(overlaySource).not.toContain('background: var(--ui-bg-elevated);');
    });
});
