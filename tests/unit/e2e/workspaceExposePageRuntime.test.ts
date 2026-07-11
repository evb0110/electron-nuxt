import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { installWorkspaceExposeProbe } from '@tests/e2e/electron/helpers/workspaceExpose';

describe('workspace expose page runtime', () => {
    const originalWindow = globalThis.window;

    afterEach(() => {
        vi.restoreAllMocks();
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: originalWindow,
            writable: true,
        });
    });

    it('runs the probe through the named-function-safe page serializer', async () => {
        const rendererWindow = {};
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: rendererWindow,
            writable: true,
        });
        const evaluate = vi.fn(async (expression: string) => {
            expect(expression).toContain('const __name = (fn) => fn;');
            return Function(`return ${expression}`)();
        });
        const page = Object.create(null) as Page;
        Object.defineProperty(page, 'evaluate', { value: evaluate });

        await installWorkspaceExposeProbe(page);

        expect(evaluate).toHaveBeenCalledOnce();
        expect(rendererWindow).toEqual(expect.objectContaining({
            __evbCollectWorkspaceExposeDebug: expect.any(Function),
            __evbFindWorkspaceExpose: expect.any(Function),
        }));
    });
});
