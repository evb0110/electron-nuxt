import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveWorkspaceMemoryBudget,
    resolveWorkspaceMemoryDeviceTier,
    resolveWorkspaceMemoryReclaimPlan,
} from '@app/modules/workspace-shell/memory/workspaceMemoryBudget';
import type { IViewerReclaimCandidate } from '@app/utils/document-viewer/memory/viewerResidencyPolicy';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function viewer(params: Partial<IViewerReclaimCandidate> & { viewerId: string }): IViewerReclaimCandidate {
    return {
        viewerId: params.viewerId,
        residencyState: params.residencyState ?? 'warm',
        isActive: params.isActive ?? false,
        canReclaim: params.canReclaim ?? true,
        lastActiveAt: params.lastActiveAt ?? 0,
        estimatedBytes: params.estimatedBytes,
    };
}

describe('workspace memory budget', () => {
    it('derives device tiers from the existing performance profile inputs', () => {
        expect(resolveWorkspaceMemoryBudget({ environment: {
            totalMemoryBytes: 4 * GIB,
            hardwareConcurrency: 4,
        } })).toMatchObject({
            deviceTier: 'low',
            maxCachedPdfPagesPerViewer: 16,
            maxWarmViewers: 2,
        });

        expect(resolveWorkspaceMemoryBudget({
            environment: {
                totalMemoryBytes: 32 * GIB,
                hardwareConcurrency: 8,
            },
            pressure: { level: 'moderate' },
        })).toMatchObject({
            deviceTier: 'high',
            maxCachedPdfPagesPerViewer: 48,
            maxWarmViewers: 4,
            pressureLevel: 'moderate',
        });
    });

    it('keeps balanced devices distinct from low and high tiers', () => {
        expect(resolveWorkspaceMemoryDeviceTier({
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 2,
            concurrentPdfRenders: 3,
            maxCachedPdfPages: 48,
            thumbnailBaseConcurrency: 2,
            settledMaxCanvasPixels: 2 ** 25,
            maxBufferCanvasPixels: 16_777_216,
        })).toBe('balanced');
    });

    it('selects inactive reclaim candidates deterministically when warm viewers exceed the budget', () => {
        const budget = {
            ...resolveWorkspaceMemoryBudget({ environment: {
                totalMemoryBytes: 16 * GIB,
                hardwareConcurrency: 8,
            } }),
            targetWarmViewers: 1,
            maxEstimatedWorkspaceBytes: 10 * GIB,
        };

        const plan = resolveWorkspaceMemoryReclaimPlan({
            budget,
            protectedViewerIds: ['protected-warm'],
            viewers: [
                viewer({
                    viewerId: 'active',
                    residencyState: 'active',
                    isActive: true,
                    estimatedBytes: 800 * MIB,
                }),
                viewer({
                    viewerId: 'protected-warm',
                    lastActiveAt: 1,
                    estimatedBytes: 900 * MIB,
                }),
                viewer({
                    viewerId: 'old-warm',
                    lastActiveAt: 2,
                    estimatedBytes: 100 * MIB,
                }),
                viewer({
                    viewerId: 'newer-large-warm',
                    lastActiveAt: 3,
                    estimatedBytes: 500 * MIB,
                }),
                viewer({
                    viewerId: 'newer-small-warm',
                    lastActiveAt: 4,
                    estimatedBytes: 50 * MIB,
                }),
            ],
        });

        expect(plan.warmViewerCount).toBe(4);
        expect(plan.overWarmViewerCount).toBe(3);
        expect(plan.candidates.map(candidate => candidate.viewerId)).toEqual([
            'old-warm',
            'newer-large-warm',
            'newer-small-warm',
        ]);
    });

    it('requests at least one candidate under critical pressure even before byte overflow', () => {
        const plan = resolveWorkspaceMemoryReclaimPlan({
            budget: resolveWorkspaceMemoryBudget({
                environment: {
                    totalMemoryBytes: 16 * GIB,
                    hardwareConcurrency: 8,
                },
                pressure: { level: 'critical' },
            }),
            viewers: [
                viewer({
                    viewerId: 'active',
                    residencyState: 'active',
                    isActive: true,
                    estimatedBytes: 256 * MIB,
                }),
                viewer({
                    viewerId: 'warm',
                    estimatedBytes: 128 * MIB,
                }),
            ],
        });

        expect(plan.overBudgetBytes).toBe(0);
        expect(plan.candidates.map(candidate => candidate.viewerId)).toEqual(['warm']);
    });
});
