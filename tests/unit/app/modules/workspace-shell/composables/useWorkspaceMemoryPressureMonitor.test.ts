import {
    computed,
    isReadonly,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    resolveWorkspaceMemoryPressureLevel,
    useWorkspaceMemoryPressureMonitor,
} from '@app/modules/workspace-shell/composables/useWorkspaceMemoryPressureMonitor';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import type { ISystemMemoryInfo } from '@contracts/systemPlatformFeature';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';

const GIB = 1024 ** 3;

const mocks = vi.hoisted(() => ({
    getMemoryInfo: vi.fn<() => ISystemMemoryInfo | null>(),
    getSnapshot: vi.fn(() => ({
        maxBytes: 100,
        reservedBytes: 0,
    })),
    intervalCallbacks: [] as Array<() => void>,
    setPressureLevel: vi.fn(),
    useIntervalFn: vi.fn((callback: () => void) => {
        mocks.intervalCallbacks.push(callback);
    }),
}));

vi.mock('@vueuse/core', () => ({useIntervalFn: mocks.useIntervalFn}));
vi.mock('@app/utils/getSystemCapability', () => (
    {getSystemCapability: () => ({getMemoryInfo: mocks.getMemoryInfo})}
));
vi.mock('@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController', () => (
    {workspaceSurfaceBudgetController: {
        getSnapshot: mocks.getSnapshot,
        setPressureLevel: mocks.setPressureLevel,
    }}
));

describe('workspace memory pressure monitor', () => {
    beforeEach(() => {
        mocks.getMemoryInfo.mockReturnValue({
            availableBytes: 16 * GIB,
            freeBytes: 16 * GIB,
            totalBytes: 32 * GIB,
        });
        mocks.getSnapshot.mockReturnValue({
            maxBytes: 100,
            reservedBytes: 0,
        });
        mocks.intervalCallbacks.length = 0;
        vi.clearAllMocks();
    });

    it.each([
        {
            source: 'healthy' as const,
            expected: 'none',
        },
        {
            source: 'guarded' as const,
            expected: 'moderate',
        },
        {
            source: 'moderate' as const,
            expected: 'moderate',
        },
        {
            source: 'critical' as const,
            expected: 'critical',
        },
        {
            source: 'emergency' as const,
            expected: 'critical',
        },
        {
            source: 'post-crash-safe-mode' as const,
            expected: 'critical',
        },
    ])('maps $source surface pressure to $expected lifecycle pressure', ({
        source,
        expected,
    }) => {
        expect(resolveWorkspaceMemoryPressureLevel(source)).toBe(expected);
    });

    it('exposes a readonly budget and recomputes it through one sampling interval', () => {
        const budget = useWorkspaceMemoryPressureMonitor();
        const tabs = [
            {
                id: 'active',
                fileName: 'active.pdf',
                originalPath: '/docs/active.pdf',
                isDirty: false,
                isDjvu: false,
            },
            {
                id: 'inactive',
                fileName: 'inactive.pdf',
                originalPath: '/docs/inactive.pdf',
                isDirty: false,
                isDjvu: false,
            },
        ] satisfies ITab[];
        const panes = [{
            paneId: 'pane',
            activeTabId: 'active',
            tabIds: [
                'active',
                'inactive',
            ],
        }] satisfies IEditorPaneState[];
        const inactiveTemperature = computed(() => resolveTabLifecycleStates({
            activationOrder: [
                'active',
                'inactive',
            ],
            panes,
            policy: 'conservative',
            tabs,
            targetWarmViewers: budget.value.targetWarmViewers,
        }).find(state => state.tabId === 'inactive')?.temperature);

        expect(isReadonly(budget)).toBe(true);
        expect(budget.value.targetWarmViewers).toBe(5);
        expect(inactiveTemperature.value).toBe('warm');
        expect(mocks.useIntervalFn).toHaveBeenCalledOnce();
        expect(mocks.intervalCallbacks).toHaveLength(1);

        mocks.getMemoryInfo.mockReturnValue({
            availableBytes: 512 * 1024 ** 2,
            freeBytes: 512 * 1024 ** 2,
            totalBytes: 32 * GIB,
        });
        mocks.intervalCallbacks[0]?.();

        expect(mocks.setPressureLevel).toHaveBeenLastCalledWith('emergency');
        expect(budget.value.targetWarmViewers).toBe(0);
        expect(inactiveTemperature.value).toBe('cold');
    });
});
