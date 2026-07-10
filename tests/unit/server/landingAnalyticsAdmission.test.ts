import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isLandingAnalyticsAdmissionRejected,
    isLandingAnalyticsWriteAllowedForHost,
    LANDING_ANALYTICS_ADMISSION_DEFAULTS,
    LANDING_ANALYTICS_ADMISSION_REJECTED_SQLSTATE,
    resolveLandingAnalyticsAdmissionPolicy,
} from '@tests/../landing/server/utils/analytics';
import {
    decodeBoundedLandingAnalyticsJsonStream,
    parseLandingAnalyticsContentLength,
} from '@tests/../landing/server/utils/analyticsRequestBody';

function createBodyStream(body: string) {
    const bytes = new TextEncoder().encode(body);
    return new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(bytes);
        controller.close();
    }});
}

describe('landing analytics admission policy', () => {
    it('never enables writes from DATABASE_URL alone', () => {
        expect(isLandingAnalyticsWriteAllowedForHost({DATABASE_URL: 'postgres://configured'}, 'evb-viewer.com')).toBe(false);
    });

    it('matches explicit enablement and allowed-host behavior', () => {
        expect(isLandingAnalyticsWriteAllowedForHost({
            LANDING_ANALYTICS_WRITE_ENABLED: 'true',
            LANDING_ANALYTICS_ALLOWED_HOSTS: 'evb-viewer.com,www.evb-viewer.com',
        }, 'EVB-VIEWER.COM')).toBe(true);
        expect(isLandingAnalyticsWriteAllowedForHost({
            LANDING_ANALYTICS_WRITE_ENABLED: 'true',
            LANDING_ANALYTICS_ALLOWED_HOSTS: 'evb-viewer.com',
        }, 'attacker.example')).toBe(false);
    });

    it('uses surface-specific defaults and clamps overrides', () => {
        expect(resolveLandingAnalyticsAdmissionPolicy('download', {})).toEqual({
            bucketSeconds: LANDING_ANALYTICS_ADMISSION_DEFAULTS.bucketSeconds,
            dedupeSeconds: LANDING_ANALYTICS_ADMISSION_DEFAULTS.dedupeSeconds,
            globalEventLimit: LANDING_ANALYTICS_ADMISSION_DEFAULTS.downloadGlobalEventLimit,
            visitorEventLimit: LANDING_ANALYTICS_ADMISSION_DEFAULTS.downloadVisitorEventLimit,
        });
        expect(resolveLandingAnalyticsAdmissionPolicy('page_view', {
            LANDING_ANALYTICS_BUCKET_SECONDS: '9999',
            LANDING_ANALYTICS_PAGE_VIEW_GLOBAL_LIMIT: '1',
            LANDING_ANALYTICS_PAGE_VIEW_VISITOR_LIMIT: '999',
        })).toMatchObject({
            bucketSeconds: 3_600,
            globalEventLimit: 50,
            visitorEventLimit: 300,
        });
    });

    it('maps only the dedicated SQLSTATE to non-persisted admission', () => {
        expect(isLandingAnalyticsAdmissionRejected({cause: {code: LANDING_ANALYTICS_ADMISSION_REJECTED_SQLSTATE}})).toBe(true);
        expect(isLandingAnalyticsAdmissionRejected({code: '08006'})).toBe(false);
    });
});

describe('landing analytics body decoder', () => {
    it('rejects invalid and oversized Content-Length values', () => {
        expect(parseLandingAnalyticsContentLength('8', 8)).toBe(8);
        expect(() => parseLandingAnalyticsContentLength('-1', 8)).toThrow('Invalid Content-Length');
        expect(() => parseLandingAnalyticsContentLength('9', 8)).toThrow('too large');
    });

    it('caps the stream before parsing JSON', async () => {
        await expect(decodeBoundedLandingAnalyticsJsonStream(
            createBodyStream('{"path":"/oversized"}'),
            null,
            8,
        )).rejects.toMatchObject({statusCode: 413});
        await expect(decodeBoundedLandingAnalyticsJsonStream(
            createBodyStream('{"path":"/"}'),
            12,
            64,
        )).resolves.toEqual({path: '/'});
    });
});
