import {
    assertProductionAuditIsClean,
    shouldUseBulkAuditFallback,
    summarizeProductionAuditReport,
} from '@scripts/checkProductionDependencyAudit';
import {
    describe,
    expect,
    it,
} from 'vitest';

function createAuditReport(overrides: {
    critical?: number;
    high?: number;
    info?: number;
    low?: number;
    moderate?: number;
    muted?: unknown[];
} = {}) {
    return {
        advisories: {},
        metadata: {vulnerabilities: {
            critical: overrides.critical ?? 0,
            high: overrides.high ?? 0,
            info: overrides.info ?? 0,
            low: overrides.low ?? 0,
            moderate: overrides.moderate ?? 0,
        }},
        muted: overrides.muted ?? [],
    };
}

describe('production dependency audit policy', () => {
    it('uses the bulk-audit client only for the retired pnpm audit endpoint', () => {
        expect(shouldUseBulkAuditFallback('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"The audit endpoint is being retired"}}')).toBe(true);
        expect(shouldUseBulkAuditFallback('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"registry unavailable"}}')).toBe(false);
    });

    it('accepts a complete zero-vulnerability pnpm report', () => {
        expect(assertProductionAuditIsClean(createAuditReport(), 'root')).toEqual({
            counts: {
                critical: 0,
                high: 0,
                info: 0,
                low: 0,
                moderate: 0,
            },
            total: 0,
        });
    });

    it('rejects every reported production vulnerability severity', () => {
        expect(() => assertProductionAuditIsClean(createAuditReport({
            critical: 1,
            high: 2,
            low: 3,
        }), 'landing')).toThrow('landing production dependency audit found 6 vulnerabilities (low=3, high=2, critical=1).');
    });

    it('rejects muted advisories instead of silently accepting exceptions', () => {
        expect(() => summarizeProductionAuditReport(createAuditReport({muted: [101]}), 'root')).toThrow('root pnpm audit report contains 1 muted advisories');
    });

    it('rejects malformed or incomplete audit output', () => {
        expect(() => summarizeProductionAuditReport({}, 'root')).toThrow('root pnpm audit report is missing metadata.vulnerabilities.');
        expect(() => summarizeProductionAuditReport(createAuditReport({high: -1}), 'root')).toThrow('root pnpm audit report has an invalid high vulnerability count.');
    });
});
