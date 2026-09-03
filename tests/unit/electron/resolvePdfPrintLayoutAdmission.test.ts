import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IHostResourceProfileSnapshot,
    THostResourceTier,
} from '@contracts/hostResourceProfile';
import {
    JobBroker,
    resolveMainJobBrokerCapacity,
} from '@electron/resources/jobBroker';
import { resolvePdfPrintLayoutAdmission } from '@electron/features/documents/main/resolvePdfPrintLayoutAdmission';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function createResourceProfile(
    logicalCpus: number,
    totalRamBytes: number,
    tier: THostResourceTier,
): IHostResourceProfileSnapshot {
    return {
        logicalCpus,
        totalRamBytes,
        safeMode: false,
        detectedTier: tier,
        performanceMode: 'auto',
        tier,
    };
}

function printLayoutRequest(estimatedResidentBytes: number) {
    return {
        ownerId: 'pdf-print-layout:test',
        kind: 'pdf-print-layout',
        priority: 'foreground' as const,
        admissionClass: 'bulk' as const,
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes,
            nativeProcesses: 1,
            ioWeight: 1,
        },
    };
}

describe('pdf print layout admission', () => {
    it('keeps the full 7 GiB budget and 6 GiB child heap on large hosts', () => {
        const capacity = resolveMainJobBrokerCapacity(createResourceProfile(12, 32 * GIB, 'high'));

        expect(resolvePdfPrintLayoutAdmission(capacity)).toEqual({
            estimatedResidentBytes: 7 * GIB,
            childMaxOldSpaceMib: 6 * 1024,
        });
    });

    it('is admitted by the broker of an 8 GiB host instead of exceeding its capacity', async () => {
        const capacity = resolveMainJobBrokerCapacity(createResourceProfile(4, 8 * GIB, 'low'));
        const broker = new JobBroker(capacity);
        const admission = resolvePdfPrintLayoutAdmission(capacity);

        expect(admission.estimatedResidentBytes).toBeLessThan(7 * GIB);
        expect(admission.estimatedResidentBytes).toBe(capacity.estimatedResidentBytes);
        expect(admission.childMaxOldSpaceMib).toBe(
            Math.floor((capacity.estimatedResidentBytes - GIB) / MIB),
        );
        await expect(broker.acquire(printLayoutRequest(7 * GIB))).rejects.toThrow('exceeds broker capacity');
        const lease = await broker.acquire(printLayoutRequest(admission.estimatedResidentBytes));
        lease.release();
    });

    it('admits the exact 2 GiB floor with a 1 GiB child heap', () => {
        expect(resolvePdfPrintLayoutAdmission({
            cpuTokens: 1,
            estimatedResidentBytes: 2 * GIB,
            nativeProcesses: 1,
            ioWeight: 1,
        })).toEqual({
            estimatedResidentBytes: 2 * GIB,
            childMaxOldSpaceMib: 1024,
        });
    });

    it('rejects a capacity below the minimum before it can reach the broker', () => {
        expect(() => resolvePdfPrintLayoutAdmission({
            cpuTokens: 1,
            estimatedResidentBytes: 2 * GIB - MIB,
            nativeProcesses: 1,
            ioWeight: 1,
        })).toThrow('requires at least 2 GiB');
    });
});
