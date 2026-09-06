import {cast} from '@tests/helpers/cast';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    findAppPage,
    probeRendererBody,
} from '@scripts/electron-run/rendererReadiness';

describe('Electron renderer readiness', () => {
    it.each([
        true,
        false,
    ])('reads body readiness in the main world and clears its timer, body=%s', async (hasBody) => {
        vi.useFakeTimers();
        try {
            const query = vi.fn(() => new Promise<never>(() => {}));
            const evaluate = vi.fn(async (probe: () => boolean) => {
                vi.stubGlobal('document', {body: hasBody ? {} : null});
                return probe();
            });
            const page = cast<Pick<Page, 'evaluate'>>({
                evaluate,
                $: query,
            });

            await expect(probeRendererBody(page)).resolves.toBe(hasBody ? 'ready' : 'waiting');
            expect(query).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it('bounds CDP page discovery when a target attach never responds', async () => {
        const browser = {pages: () => new Promise<never>(() => {})} as Pick<Browser, 'pages'>;

        await expect(findAppPage(browser, 5)).rejects.toThrow(
            'Puppeteer page discovery did not respond within 5ms',
        );
    });

    it('clears the discovery timer after CDP page discovery resolves', async () => {
        vi.useFakeTimers();
        try {
            const browser = {pages: async () => []} as Pick<Browser, 'pages'>;

            await expect(findAppPage(browser, 5_000)).resolves.toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
