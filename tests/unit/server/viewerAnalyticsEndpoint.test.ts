import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    admitViewerAnalyticsEvents: vi.fn(),
    createAnalyticsDedupeKey: vi.fn(),
    decodeViewerAnalyticsEventsBody: vi.fn(),
    extractGeo: vi.fn(),
    getAnalyticsRequestHost: vi.fn(),
    getOptionalAnalyticsDb: vi.fn(),
    getRuntimeEnv: vi.fn(),
    hashVisitorIdentity: vi.fn(),
    isAnalyticsWriteAllowed: vi.fn(),
    isTrustedAnalyticsRequest: vi.fn(),
    readBoundedAnalyticsJsonBody: vi.fn(),
    resolveRootAnalyticsAdmissionPolicy: vi.fn(),
    setHeader: vi.fn(),
}));

vi.mock('h3', () => ({
    createError: (details: Record<string, unknown>) => Object.assign(
        new Error(String(details.statusMessage ?? 'Request failed')),
        details,
    ),
    defineEventHandler: (handler: unknown) => handler,
    getHeader: () => undefined,
    setHeader: mocks.setHeader,
}));

vi.mock('@server/db', () => ({getOptionalAnalyticsDb: mocks.getOptionalAnalyticsDb}));
vi.mock('@server/db/admitViewerAnalyticsEvents', () => ({admitViewerAnalyticsEvents: mocks.admitViewerAnalyticsEvents}));
vi.mock('@server/utils/analytics', () => ({
    extractGeo: mocks.extractGeo,
    getAnalyticsRequestHost: mocks.getAnalyticsRequestHost,
    hashVisitorIdentity: mocks.hashVisitorIdentity,
    isAnalyticsWriteAllowed: mocks.isAnalyticsWriteAllowed,
    isTrustedAnalyticsRequest: mocks.isTrustedAnalyticsRequest,
}));
vi.mock('@server/utils/analyticsAdmission', () => ({
    createAnalyticsDedupeKey: mocks.createAnalyticsDedupeKey,
    isAnalyticsAdmissionRejected: () => false,
    resolveRootAnalyticsAdmissionPolicy: mocks.resolveRootAnalyticsAdmissionPolicy,
    ROOT_ANALYTICS_BODY_MAX_BYTES: 1_024,
    ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH: 1_024,
}));
vi.mock('@server/utils/analyticsRequestBody', () => ({readBoundedAnalyticsJsonBody: mocks.readBoundedAnalyticsJsonBody}));
vi.mock('@server/utils/decodeViewerAnalyticsEventsBody', () => ({decodeViewerAnalyticsEventsBody: mocks.decodeViewerAnalyticsEventsBody}));
vi.mock('@server/utils/getRuntimeEnv', () => ({getRuntimeEnv: mocks.getRuntimeEnv}));

describe('viewer analytics endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isAnalyticsWriteAllowed.mockReturnValue(true);
        mocks.isTrustedAnalyticsRequest.mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('skips request processing when analytics storage is not configured', async () => {
        mocks.getOptionalAnalyticsDb.mockReturnValue(null);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const {default: handler} = await import('@server/api/analytics/events.post');

        await expect(handler({} as never)).resolves.toEqual({
            ok: true,
            persisted: false,
        });
        expect(mocks.readBoundedAnalyticsJsonBody).not.toHaveBeenCalled();
        expect(mocks.hashVisitorIdentity).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('returns a controlled failure when database initialization fails', async () => {
        const initializationError = new Error('database client failed');
        mocks.getOptionalAnalyticsDb.mockImplementation(() => {
            throw initializationError;
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const {default: handler} = await import('@server/api/analytics/events.post');

        await expect(handler({} as never)).resolves.toEqual({
            ok: false,
            persisted: false,
        });
        expect(mocks.readBoundedAnalyticsJsonBody).not.toHaveBeenCalled();
        expect(mocks.admitViewerAnalyticsEvents).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(
            'viewer analytics database initialization failed',
            initializationError,
        );
    });
});
