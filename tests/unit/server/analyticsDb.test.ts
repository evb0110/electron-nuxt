import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    drizzle: vi.fn(),
    env: {} as Record<string, string | undefined>,
    neon: vi.fn(),
}));

vi.mock('@neondatabase/serverless', () => ({neon: mocks.neon}));
vi.mock('drizzle-orm/neon-http', () => ({drizzle: mocks.drizzle}));
vi.mock('@server/utils/getRuntimeEnv', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('@server/utils/getRuntimeEnv')),
    getRuntimeEnv: () => mocks.env,
}));

describe('analytics database access', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mocks.env = {};
    });

    afterEach(() => {
        vi.resetAllMocks();
        vi.resetModules();
        mocks.env = {};
    });

    it('exposes an optional fast path without constructing a database client', async () => {
        const {
            getAnalyticsDb,
            getOptionalAnalyticsDb,
        } = await import('@server/db');

        expect(getOptionalAnalyticsDb()).toBeNull();
        expect(() => getAnalyticsDb()).toThrow('Analytics database URL is not configured');
        expect(mocks.neon).not.toHaveBeenCalled();
        expect(mocks.drizzle).not.toHaveBeenCalled();
    });

    it('returns the configured database client through both access paths', async () => {
        const db = {query: {}};
        const sql = vi.fn();
        mocks.env = {
            NUXT_ANALYTICS_DATABASE_URL: 'postgres://nuxt-analytics',
            ANALYTICS_DATABASE_URL: 'postgres://analytics',
            DATABASE_URL: 'postgres://database',
        };
        mocks.neon.mockReturnValue(sql);
        mocks.drizzle.mockReturnValue(db);
        const {
            getAnalyticsDb,
            getOptionalAnalyticsDb,
        } = await import('@server/db');

        expect(getOptionalAnalyticsDb()).toBe(db);
        expect(getAnalyticsDb()).toBe(db);
        expect(mocks.neon).toHaveBeenCalledWith('postgres://nuxt-analytics');
        expect(mocks.neon).toHaveBeenCalledOnce();
        expect(mocks.drizzle).toHaveBeenCalledOnce();
    });

    it('falls through an empty Nuxt database URL to the analytics URL', async () => {
        const db = {query: {}};
        const sql = vi.fn();
        mocks.env = {
            NUXT_ANALYTICS_DATABASE_URL: '',
            ANALYTICS_DATABASE_URL: 'postgres://analytics',
            DATABASE_URL: 'postgres://database',
        };
        mocks.neon.mockReturnValue(sql);
        mocks.drizzle.mockReturnValue(db);
        const { getOptionalAnalyticsDb } = await import('@server/db');

        expect(getOptionalAnalyticsDb()).toBe(db);
        expect(mocks.neon).toHaveBeenCalledWith('postgres://analytics');
    });
});
