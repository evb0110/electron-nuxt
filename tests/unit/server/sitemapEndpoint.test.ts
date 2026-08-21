import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    resolveSiteUrl: vi.fn(),
    setHeader: vi.fn(),
}));

vi.mock('h3', () => ({
    defineEventHandler: (handler: unknown) => handler,
    setHeader: mocks.setHeader,
}));

vi.mock('@server/utils/normalizeSiteUrl', () => ({resolveSiteUrl: mocks.resolveSiteUrl}));

describe('sitemap endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveSiteUrl.mockReturnValue('https://web.evb-viewer.com/');
    });

    it('omits a misleading runtime-generated modification date', async () => {
        const {default: handler} = await import('@server/routes/sitemap.xml');

        const xml = handler({} as never);

        expect(xml).toContain('<loc>https://web.evb-viewer.com/</loc>');
        expect(xml).toContain('<image:loc>https://web.evb-viewer.com/evb-viewer-seo.png</image:loc>');
        expect(xml).not.toContain('<lastmod>');
        expect(mocks.setHeader).toHaveBeenCalledWith(
            {},
            'content-type',
            'application/xml; charset=utf-8',
        );
    });
});
