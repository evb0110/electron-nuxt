import { readFile } from 'fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('foreground focus authority policy', () => {
    it('routes Dock, external-open, and assistant return activation through the shared helper', async () => {
        const [
            main,
            externalOpen,
            assistantReturn,
        ] = await Promise.all([
            readFile('electron/main.ts', 'utf8'),
            readFile('electron/bootstrap/externalOpen.ts', 'utf8'),
            readFile('electron/features/agent/assistantReturnWindow.ts', 'utf8'),
        ]);

        expect(main).toContain('focusWindowForUser(window, {');
        expect(externalOpen).toContain('focusWindowForUser(window, {');
        expect(assistantReturn).toContain('focusWindowForUser(window, {');
    });
});
