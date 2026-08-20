import { resolve } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    authorization: '',
    batch: vi.fn(),
    execute: vi.fn((query: unknown) => query),
    getOptionalDb: vi.fn(),
    setHeader: vi.fn(),
}));

vi.mock('h3', () => ({
    createError: (details: Record<string, unknown>) => Object.assign(
        new Error(String(details.statusMessage ?? 'Request failed')),
        details,
    ),
    defineEventHandler: (handler: unknown) => handler,
    getHeader: () => mocks.authorization || undefined,
    setHeader: mocks.setHeader,
}));

vi.mock('~~/server/db', () => ({getOptionalDb: mocks.getOptionalDb}));

describe('landing analytics retention endpoint', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('CRON_SECRET', 'a'.repeat(32));
        vi.stubGlobal('useRuntimeConfig', () => ({databaseUrl: 'postgres://test'}));
        mocks.authorization = '';
        mocks.getOptionalDb.mockReturnValue({
            batch: mocks.batch,
            execute: mocks.execute,
        });
        mocks.batch.mockResolvedValue([
            {rows: []},
            {rows: []},
            {rows: [{
                dedupeDeleted: '2',
                deletedRows: '9',
                downloadsDeleted: '1',
                globalQuotaDeleted: '1',
                hasMore: false,
                pageViewsDeleted: '4',
                visitorQuotaDeleted: '1',
            }]},
        ]);
    });

    async function loadHandler() {
        const endpointPath = resolve(
            process.cwd(),
            'landing/server/api/maintenance/analyticsRetention.get.ts',
        );
        const {default: handler} = await import(endpointPath);
        return handler;
    }

    it('rejects unauthenticated and unavailable-database requests', async () => {
        const handler = await loadHandler();
        await expect(handler({} as never)).rejects.toMatchObject({statusCode: 401});
        expect(mocks.getOptionalDb).not.toHaveBeenCalled();

        mocks.authorization = `Bearer ${'a'.repeat(32)}`;
        mocks.getOptionalDb.mockReturnValue(null);
        await expect(handler({} as never)).rejects.toMatchObject({statusCode: 503});
    });

    it('returns per-table counts after a converged committed batch', async () => {
        mocks.authorization = `Bearer ${'a'.repeat(32)}`;
        const handler = await loadHandler();

        await expect(handler({} as never)).resolves.toEqual({
            batches: 1,
            deletedRows: '9',
            ok: true,
            tables: {
                dedupe: '2',
                downloads: '1',
                globalQuota: '1',
                pageViews: '4',
                visitorQuota: '1',
            },
        });
        expect(mocks.batch).toHaveBeenCalledOnce();
        expect(mocks.setHeader).toHaveBeenCalledWith({}, 'cache-control', 'no-store');
    });
});
