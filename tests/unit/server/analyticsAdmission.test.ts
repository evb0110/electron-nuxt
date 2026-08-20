import {
    describe,
    expect,
    it,
} from 'vitest';
import {decodeViewerAnalyticsEventsBody} from '@server/utils/decodeViewerAnalyticsEventsBody';
import {
    createAnalyticsVisitorHash,
    isAnalyticsWriteAllowedForHost,
    isTrustedAnalyticsRequestValues,
} from '@server/utils/analytics';
import {
    ANALYTICS_ADMISSION_REJECTED_SQLSTATE,
    isAnalyticsAdmissionRejected,
    resolveRootAnalyticsAdmissionPolicy,
    ROOT_ANALYTICS_ADMISSION_DEFAULTS,
} from '@server/utils/analyticsAdmission';
import {
    decodeBoundedAnalyticsJsonStream,
    parseAnalyticsContentLength,
} from '@server/utils/analyticsRequestBody';
import { isAnalyticsRetentionRequestAuthorized } from '@contracts/analyticsRetention';
import {
    resolveAnalyticsClientIp,
    resolveStrongAnalyticsSecret,
} from '@contracts/analyticsPrivacy';

function createBodyStream(chunks: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({start(controller) {
        for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
    }});
}

describe('root analytics admission policy', () => {
    it('fails closed without the exact strong retention bearer secret', () => {
        const secret = 'a'.repeat(32);
        expect(isAnalyticsRetentionRequestAuthorized(`Bearer ${secret}`, secret)).toBe(true);
        expect(isAnalyticsRetentionRequestAuthorized(`Bearer ${secret}`, undefined)).toBe(false);
        expect(isAnalyticsRetentionRequestAuthorized('Bearer wrong', secret)).toBe(false);
        expect(isAnalyticsRetentionRequestAuthorized('Bearer short', 'short')).toBe(false);
    });

    it('uses conservative checked-in defaults and bounded environment overrides', () => {
        expect(resolveRootAnalyticsAdmissionPolicy({})).toEqual(
            ROOT_ANALYTICS_ADMISSION_DEFAULTS,
        );
        expect(resolveRootAnalyticsAdmissionPolicy({
            ANALYTICS_BUCKET_SECONDS: '1',
            ANALYTICS_DEDUPE_SECONDS: '999',
            ANALYTICS_GLOBAL_EVENT_LIMIT: '999999',
            ANALYTICS_VISITOR_EVENT_LIMIT: '0',
        })).toEqual({
            bucketSeconds: 60,
            dedupeSeconds: 120,
            globalEventLimit: 50_000,
            visitorEventLimit: 1,
        });
    });

    it('requires explicit write enablement and enforces configured hosts', () => {
        expect(isAnalyticsWriteAllowedForHost({DATABASE_URL: 'postgres://configured'}, 'web.evb-viewer.com')).toBe(false);
        expect(isAnalyticsWriteAllowedForHost({
            ANALYTICS_WRITE_ENABLED: '1',
            ANALYTICS_HASH_SECRET: 'a'.repeat(32),
            ANALYTICS_ALLOWED_HOSTS: 'web.evb-viewer.com',
        }, 'other.example')).toBe(false);
        expect(isAnalyticsWriteAllowedForHost({
            ANALYTICS_WRITE_ENABLED: '1',
            ANALYTICS_HASH_SECRET: 'a'.repeat(32),
            ANALYTICS_ALLOWED_HOSTS: 'web.evb-viewer.com',
        }, 'WEB.EVB-VIEWER.COM')).toBe(true);
    });

    it('fails closed without a strong visitor-hash secret', () => {
        expect(isAnalyticsWriteAllowedForHost({ANALYTICS_WRITE_ENABLED: '1'}, 'web.evb-viewer.com')).toBe(false);
        expect(isAnalyticsWriteAllowedForHost({
            ANALYTICS_HASH_SECRET: 'short',
            ANALYTICS_WRITE_ENABLED: '1',
        }, 'web.evb-viewer.com')).toBe(false);
        expect(isAnalyticsWriteAllowedForHost({
            ANALYTICS_HASH_SECRET: `  ${'a'.repeat(32)}  `,
            ANALYTICS_WRITE_ENABLED: '1',
        }, 'web.evb-viewer.com')).toBe(true);
        expect(resolveStrongAnalyticsSecret([
            ' '.repeat(40),
            'b'.repeat(32),
        ])).toBe('b'.repeat(32));
        expect(resolveStrongAnalyticsSecret([
            'short',
            'b'.repeat(32),
        ])).toBe('');
    });

    it('trusts the Vercel-owned client IP header only in the Vercel runtime', () => {
        expect(resolveAnalyticsClientIp({
            isVercel: true,
            platformIp: '10.0.0.2',
            vercelForwardedFor: '203.0.113.7, 10.0.0.1',
        })).toBe('203.0.113.7');
        expect(resolveAnalyticsClientIp({
            isVercel: false,
            platformIp: '198.51.100.4',
            vercelForwardedFor: '203.0.113.7',
        })).toBe('198.51.100.4');
        expect(resolveAnalyticsClientIp({
            isVercel: true,
            platformIp: '198.51.100.4',
            vercelForwardedFor: '  ',
        })).toBe('198.51.100.4');
    });

    it('admits only same-origin JSON requests', () => {
        const trusted = {
            contentType: 'application/json',
            fetchSite: 'same-origin',
            origin: 'https://web.evb-viewer.com',
            requestOrigin: 'https://web.evb-viewer.com',
        };
        expect(isTrustedAnalyticsRequestValues(trusted)).toBe(true);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            contentType: 'text/plain',
        })).toBe(false);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            fetchSite: 'cross-site',
        })).toBe(false);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            origin: 'https://attacker.example',
        })).toBe(false);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            contentType: undefined,
        })).toBe(false);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            fetchSite: undefined,
        })).toBe(false);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            origin: undefined,
        })).toBe(false);
        expect(isTrustedAnalyticsRequestValues({
            ...trusted,
            requestOrigin: undefined,
        })).toBe(false);
    });

    it('rotates keyed visitor identities without exposing an offline IP hash', async () => {
        const input = {
            date: '2026-08-19',
            ip: '203.0.113.7',
            secret: 'a'.repeat(32),
        };
        const hash = await createAnalyticsVisitorHash(input);
        await expect(createAnalyticsVisitorHash(input)).resolves.toBe(hash);
        await expect(createAnalyticsVisitorHash({
            ...input,
            secret: 'b'.repeat(32),
        })).resolves.not.toBe(hash);
        await expect(createAnalyticsVisitorHash({
            ...input,
            date: '2026-08-20',
        })).resolves.not.toBe(hash);
    });

    it('maps only the dedicated SQLSTATE to admission rejection', () => {
        expect(isAnalyticsAdmissionRejected({sourceError: {code: ANALYTICS_ADMISSION_REJECTED_SQLSTATE}})).toBe(true);
        expect(isAnalyticsAdmissionRejected({code: '23505'})).toBe(false);
        expect(isAnalyticsAdmissionRejected(new Error('EVB01'))).toBe(false);
    });
});

describe('root analytics body decoder', () => {
    it('validates Content-Length and enforces the streaming byte cap', async () => {
        expect(parseAnalyticsContentLength(undefined, 16)).toBeNull();
        expect(parseAnalyticsContentLength('12', 16)).toBe(12);
        expect(() => parseAnalyticsContentLength('12, 12', 16)).toThrow('Invalid Content-Length');
        expect(() => parseAnalyticsContentLength('17', 16)).toThrow('too large');

        await expect(decodeBoundedAnalyticsJsonStream(
            createBodyStream([
                '{"value":',
                '12345}',
            ]),
            null,
            8,
        )).rejects.toMatchObject({statusCode: 413});
    });

    it('decodes split JSON and rejects mismatched declared lengths', async () => {
        await expect(decodeBoundedAnalyticsJsonStream(
            createBodyStream([
                '{"events":',
                '[]}',
            ]),
            13,
            64,
        )).resolves.toEqual({events: []});
        await expect(decodeBoundedAnalyticsJsonStream(
            createBodyStream(['{}']),
            3,
            64,
        )).rejects.toMatchObject({statusCode: 400});
    });

    it('rejects empty, non-byte, and malformed UTF-8 streams at the shared boundary', async () => {
        await expect(decodeBoundedAnalyticsJsonStream(
            new ReadableStream<Uint8Array>({start: controller => controller.close()}),
            null,
            64,
        )).rejects.toMatchObject({
            statusCode: 400,
            statusMessage: 'Analytics request body is empty',
        });
        await expect(decodeBoundedAnalyticsJsonStream(
            new ReadableStream<unknown>({start(controller) {
                controller.enqueue('not bytes');
                controller.close();
            }}),
            null,
            64,
        )).rejects.toMatchObject({statusCode: 400});
        await expect(decodeBoundedAnalyticsJsonStream(
            new ReadableStream<Uint8Array>({start(controller) {
                controller.enqueue(Uint8Array.of(0xC3, 0x28));
                controller.close();
            }}),
            2,
            64,
        )).rejects.toMatchObject({
            statusCode: 400,
            statusMessage: 'Analytics request body must be valid JSON',
        });
    });

    it('bounds batches and preserves client time separately from server chronology', () => {
        const clientOccurredAt = '1999-01-01T00:00:00.000Z';
        const decoded = decodeViewerAnalyticsEventsBody({events: [{
            name: 'viewer_session_started',
            occurredAt: clientOccurredAt,
            path: '/workspace',
            screenCategory: 'desktop',
            sessionId: 'session-1',
            payload: {},
        }]});

        expect(decoded).toHaveLength(1);
        expect(decoded[0]).toMatchObject({clientOccurredAt});
        expect(decoded[0]).not.toHaveProperty('occurredAt');
        expect(() => decodeViewerAnalyticsEventsBody({events: Array.from({length: 21}, () => ({}))})).toThrow('at most 20 events');
    });
});
