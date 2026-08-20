import {
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
    getAnalyticsDb: vi.fn(),
    getRuntimeEnv: vi.fn(),
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

vi.mock('@server/db', () => ({getAnalyticsDb: mocks.getAnalyticsDb}));
vi.mock('@server/utils/getRuntimeEnv', () => ({getRuntimeEnv: mocks.getRuntimeEnv}));

describe('root analytics retention endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorization = '';
        mocks.getRuntimeEnv.mockReturnValue({CRON_SECRET: 'a'.repeat(32)});
        mocks.getAnalyticsDb.mockReturnValue({
            batch: mocks.batch,
            execute: mocks.execute,
        });
        mocks.batch.mockResolvedValue([
            {rows: []},
            {rows: []},
            {rows: [{
                dedupeDeleted: '2',
                deletedRows: '7',
                eventsDeleted: '3',
                globalQuotaDeleted: '1',
                hasMore: false,
                visitorQuotaDeleted: '1',
            }]},
        ]);
    });

    it('rejects an unauthenticated purge before reaching the database', async () => {
        const {default: handler} = await import('@server/api/maintenance/analyticsRetention.get');

        await expect(handler({} as never)).rejects.toMatchObject({statusCode: 401});
        expect(mocks.getAnalyticsDb).not.toHaveBeenCalled();
        expect(mocks.setHeader).toHaveBeenCalledWith({}, 'cache-control', 'no-store');
    });

    it('runs the bounded purge batch and exposes a JSON-safe deletion count', async () => {
        mocks.authorization = `Bearer ${'a'.repeat(32)}`;
        const {default: handler} = await import('@server/api/maintenance/analyticsRetention.get');

        await expect(handler({} as never)).resolves.toEqual({
            batches: 1,
            deletedRows: '7',
            ok: true,
            tables: {
                dedupe: '2',
                events: '3',
                globalQuota: '1',
                visitorQuota: '1',
            },
        });
        expect(mocks.execute).toHaveBeenCalledTimes(3);
        expect(mocks.batch).toHaveBeenCalledOnce();
    });

    it('rejects malformed database results instead of reporting false success', async () => {
        mocks.authorization = `Bearer ${'a'.repeat(32)}`;
        mocks.batch.mockResolvedValue([
            {rows: []},
            {rows: []},
            {rows: [{
                dedupeDeleted: '2',
                deletedRows: 'not-a-count',
                eventsDeleted: '3',
                globalQuotaDeleted: '1',
                hasMore: false,
                visitorQuotaDeleted: '1',
            }]},
        ]);
        const {default: handler} = await import('@server/api/maintenance/analyticsRetention.get');

        await expect(handler({} as never)).rejects.toThrow('invalid row count');
    });

    it('commits and repeats bounded batches until the database reports convergence', async () => {
        mocks.authorization = `Bearer ${'a'.repeat(32)}`;
        mocks.batch
            .mockResolvedValueOnce([
                {rows: []},
                {rows: []},
                {rows: [{
                    dedupeDeleted: '0',
                    deletedRows: '5000',
                    eventsDeleted: '5000',
                    globalQuotaDeleted: '0',
                    hasMore: true,
                    visitorQuotaDeleted: '0',
                }]},
            ])
            .mockResolvedValueOnce([
                {rows: []},
                {rows: []},
                {rows: [{
                    dedupeDeleted: '0',
                    deletedRows: '1',
                    eventsDeleted: '1',
                    globalQuotaDeleted: '0',
                    hasMore: false,
                    visitorQuotaDeleted: '0',
                }]},
            ]);
        const {default: handler} = await import('@server/api/maintenance/analyticsRetention.get');

        await expect(handler({} as never)).resolves.toMatchObject({
            batches: 2,
            deletedRows: '5001',
            tables: {events: '5001'},
        });
        expect(mocks.batch).toHaveBeenCalledTimes(2);
    });

    it('reports a service failure when the bounded drain cannot clear the backlog', async () => {
        mocks.authorization = `Bearer ${'a'.repeat(32)}`;
        mocks.batch.mockResolvedValue([
            {rows: []},
            {rows: []},
            {rows: [{
                dedupeDeleted: '0',
                deletedRows: '5000',
                eventsDeleted: '5000',
                globalQuotaDeleted: '0',
                hasMore: true,
                visitorQuotaDeleted: '0',
            }]},
        ]);
        const {default: handler} = await import('@server/api/maintenance/analyticsRetention.get');

        await expect(handler({} as never)).rejects.toMatchObject({statusCode: 503});
        expect(mocks.batch).toHaveBeenCalledTimes(10);
    });
});
