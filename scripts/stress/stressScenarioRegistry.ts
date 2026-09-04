import type {
    IStressBudgets,
    IStressDeterministicScenario,
    IStressOperatorScenario,
    IStressThresholds,
    TStressScenario,
} from '@scripts/stress/stressTypes';

const MIB = 1024 * 1024;

export const DEFAULT_STRESS_THRESHOLDS: IStressThresholds = {
    heartbeatMaxGapMs: 2_000,
    longTaskP95Ms: 500,
    frameGapP95Ms: 250,
    peakRssBytes: 3_072 * MIB,
    jsHeapGrowthBytes: 512 * MIB,
    stepDurationMaxMs: 60_000,
};

export const DEFAULT_STRESS_BUDGETS: IStressBudgets = {
    maxTurns: 40,
    maxCostUsd: 2.5,
    deadlineMs: 12 * 60_000,
};

export const DEFAULT_STRESS_RUN_BUDGET = {
    maxCostUsd: 40,
    deadlineMs: 3 * 60 * 60_000,
};

const DETERMINISTIC_BUDGETS: IStressBudgets = {
    maxTurns: 0,
    maxCostUsd: 0,
    deadlineMs: 15 * 60_000,
};

const deterministic = (
    scenario: Omit<IStressDeterministicScenario, 'kind' | 'budgets' | 'thresholds' | 'workingCopies'> & Partial<Pick<IStressDeterministicScenario, 'budgets' | 'thresholds' | 'workingCopies'>>,
): IStressDeterministicScenario => ({
    kind: 'deterministic',
    budgets: DETERMINISTIC_BUDGETS,
    thresholds: {},
    workingCopies: [],
    ...scenario,
});

const operator = (
    scenario: Omit<IStressOperatorScenario, 'kind' | 'budgets' | 'thresholds' | 'workingCopies'> & Partial<Pick<IStressOperatorScenario, 'budgets' | 'thresholds' | 'workingCopies'>>,
): IStressOperatorScenario => ({
    kind: 'operator',
    budgets: DEFAULT_STRESS_BUDGETS,
    thresholds: {},
    workingCopies: [],
    ...scenario,
});

const COMMON_DO_NOT = [
    'Do not open Settings or Preferences.',
    'Do not dismiss error dialogs; describe them in your report instead.',
    'Do not open any file that is not listed in the task card.',
];

export const STRESS_SCENARIOS: TStressScenario[] = [
    deterministic({
        id: 'open-xlarge-sparse',
        title: 'Open a 513 MiB sparse PDF and jump across it',
        description: 'Crosses the native-preview size threshold, then navigates first/last/middle pages and scrolls in bursts.',
        tags: [
            'xlarge',
            'open',
            'navigation',
        ],
        fixtures: ['xlarge-sparse-513mib'],
        defaultProfile: 'baseline',
        thresholds: {stepDurationMaxMs: 120_000},
        steps: [
            {
                kind: 'phase',
                name: 'open',
            },
            {
                kind: 'open',
                fixture: 'xlarge-sparse-513mib',
            },
            { kind: 'gc' },
            {
                kind: 'phase',
                name: 'navigate',
            },
            {
                kind: 'goToPage',
                pages: [
                    'last',
                    1,
                    'middle',
                    'last',
                ],
            },
            {
                kind: 'wheelBurst',
                deltaY: 1200,
                count: 30,
            },
            {
                kind: 'wheelBurst',
                deltaY: -1200,
                count: 30,
            },
            {
                kind: 'command',
                name: 'handleZoomIn',
                repeat: 3,
            },
            {
                kind: 'command',
                name: 'handleFitWidth',
            },
            { kind: 'gc' },
            {
                kind: 'idle',
                ms: 2_000,
            },
        ],
    }),
    deterministic({
        id: 'many-pages-navigation-storm',
        title: '4000-page navigation storm',
        description: 'Random page jumps, long wheel bursts and zoom churn on a 4000-page text document.',
        tags: [
            'navigation',
            'zoom',
            'virtualization',
        ],
        fixtures: ['many-pages-text-4000'],
        defaultProfile: 'slow-a',
        steps: [
            {
                kind: 'phase',
                name: 'open',
            },
            {
                kind: 'open',
                fixture: 'many-pages-text-4000',
            },
            { kind: 'gc' },
            {
                kind: 'phase',
                name: 'jumps',
            },
            {
                kind: 'randomPages',
                count: 40,
                seed: 4000,
            },
            {
                kind: 'phase',
                name: 'wheel',
            },
            {
                kind: 'wheelBurst',
                deltaY: 900,
                count: 80,
            },
            {
                kind: 'wheelBurst',
                deltaY: -900,
                count: 80,
            },
            {
                kind: 'phase',
                name: 'zoom',
            },
            {
                kind: 'command',
                name: 'handleZoomIn',
                repeat: 6,
            },
            {
                kind: 'command',
                name: 'handleZoomOut',
                repeat: 6,
            },
            {
                kind: 'command',
                name: 'handleFitHeight',
            },
            {
                kind: 'command',
                name: 'handleFitWidth',
            },
            {
                kind: 'command',
                name: 'handleToggleContinuousScroll',
            },
            {
                kind: 'randomPages',
                count: 20,
                seed: 4001,
            },
            {
                kind: 'command',
                name: 'handleToggleContinuousScroll',
            },
            {
                kind: 'phase',
                name: 'search',
            },
            {
                kind: 'search',
                query: 'marker-3999-7',
            },
            { kind: 'gc' },
            {
                kind: 'idle',
                ms: 2_000,
            },
        ],
    }),
    deterministic({
        id: 'dense-annotations-scroll',
        title: 'Scroll through 2000 embedded annotations',
        description: 'Annotation layer rendering and inventory under wheel bursts and sidebar toggles.',
        tags: [
            'annotations',
            'sidebar',
        ],
        fixtures: ['dense-annotations-2000'],
        defaultProfile: 'slow-a',
        steps: [
            {
                kind: 'phase',
                name: 'open',
            },
            {
                kind: 'open',
                fixture: 'dense-annotations-2000',
            },
            { kind: 'gc' },
            {
                kind: 'phase',
                name: 'scroll',
            },
            {
                kind: 'wheelBurst',
                deltaY: 800,
                count: 100,
            },
            {
                kind: 'command',
                name: 'handleToggleSidebar',
            },
            {
                kind: 'goToPage',
                pages: [
                    150,
                    10,
                    199,
                ],
            },
            {
                kind: 'command',
                name: 'handleToggleSidebar',
            },
            {
                kind: 'command',
                name: 'handleRotateCw',
            },
            {
                kind: 'wheelBurst',
                deltaY: -800,
                count: 60,
            },
            { kind: 'gc' },
            {
                kind: 'idle',
                ms: 2_000,
            },
        ],
    }),
    deterministic({
        id: 'deep-outline-open',
        title: 'Open a 3000-bookmark outline',
        description: 'Sidebar outline tree construction and navigation on a deep outline.',
        tags: [
            'outline',
            'sidebar',
        ],
        fixtures: ['deep-outline-3000'],
        defaultProfile: 'slow-a',
        steps: [
            {
                kind: 'open',
                fixture: 'deep-outline-3000',
            },
            {
                kind: 'command',
                name: 'handleToggleSidebar',
            },
            {
                kind: 'idle',
                ms: 1_500,
            },
            {
                kind: 'goToPage',
                pages: [
                    120,
                    'last',
                    1,
                ],
            },
            {
                kind: 'command',
                name: 'handleToggleSidebar',
            },
            { kind: 'gc' },
        ],
    }),
    deterministic({
        id: 'multi-tab-pressure',
        title: 'Four heavy tabs, tab cycling, split view',
        description: 'Memory pressure across tabs with the aggressive tab memory policy and a split viewer.',
        tags: [
            'tabs',
            'memory',
            'split',
        ],
        fixtures: [
            'text-small-12',
            'many-pages-text-4000',
            'dense-annotations-2000',
            'scanned-large-431',
        ],
        defaultProfile: 'slow-a',
        thresholds: {peakRssBytes: 4_096 * MIB},
        steps: [
            {
                kind: 'phase',
                name: 'open-tabs',
            },
            {
                kind: 'open',
                fixture: 'text-small-12',
            },
            {
                kind: 'open',
                fixture: 'many-pages-text-4000',
                inNewTab: true,
            },
            {
                kind: 'open',
                fixture: 'dense-annotations-2000',
                inNewTab: true,
            },
            {
                kind: 'open',
                fixture: 'scanned-large-431',
                inNewTab: true,
            },
            { kind: 'gc' },
            {
                kind: 'phase',
                name: 'cycle',
            },
            {
                kind: 'cycleTabs',
                rounds: 5,
            },
            {
                kind: 'memoryPolicy',
                policy: 'aggressive',
            },
            {
                kind: 'cycleTabs',
                rounds: 5,
            },
            {
                kind: 'phase',
                name: 'split',
            },
            {
                kind: 'split',
                direction: 'right',
            },
            {
                kind: 'wheelBurst',
                deltaY: 700,
                count: 40,
            },
            { kind: 'gc' },
            {
                kind: 'idle',
                ms: 3_000,
            },
        ],
    }),
    deterministic({
        id: 'annotate-save-loop',
        title: 'Add 20 free-text notes, undo/redo, save twice',
        description: 'Annotation editing and save pipeline on a working copy; the saved file is checked with qpdf.',
        tags: [
            'annotations',
            'save',
            'integrity',
        ],
        fixtures: ['text-small-12'],
        workingCopies: ['text-small-12'],
        defaultProfile: 'slow-a',
        steps: [
            {
                kind: 'open',
                fixture: 'text-small-12',
            },
            {
                kind: 'phase',
                name: 'annotate',
            },
            {
                kind: 'freeText',
                count: 20,
                text: 'stress note',
            },
            { kind: 'save' },
            {
                kind: 'command',
                name: 'handleUndo',
                repeat: 5,
            },
            {
                kind: 'command',
                name: 'handleRedo',
                repeat: 5,
            },
            { kind: 'save' },
            { kind: 'gc' },
        ],
    }),
    deterministic({
        id: 'corrupt-open-recovery',
        title: 'Open a truncated PDF, then recover with a good one',
        description: 'The open error must surface without a crash, and the next open must succeed in the same session.',
        tags: [
            'failure',
            'recovery',
        ],
        fixtures: [
            'corrupt-truncated',
            'text-small-12',
        ],
        defaultProfile: 'baseline',
        steps: [
            {
                kind: 'open',
                fixture: 'corrupt-truncated',
                expect: 'open-error',
            },
            {
                kind: 'idle',
                ms: 1_000,
            },
            {
                kind: 'open',
                fixture: 'text-small-12',
                inNewTab: true,
            },
            {
                kind: 'goToPage',
                pages: [
                    'last',
                    1,
                ],
            },
        ],
    }),
    deterministic({
        id: 'djvu-open-navigate',
        title: 'Open the DjVu fixture and navigate',
        description: 'DjVu decode path under throttle; skipped when no DjVu fixture is available.',
        tags: [
            'djvu',
            'navigation',
        ],
        fixtures: ['djvu-reference'],
        defaultProfile: 'slow-a',
        steps: [
            {
                kind: 'open',
                fixture: 'djvu-reference',
            },
            {
                kind: 'goToPage',
                pages: [
                    'last',
                    'middle',
                    1,
                ],
            },
            {
                kind: 'wheelBurst',
                deltaY: 800,
                count: 40,
            },
            { kind: 'gc' },
        ],
    }),
    deterministic({
        id: 'scanned-large-scroll',
        title: 'Scroll 431 scanned pages',
        description: 'Raster-heavy pages under wheel bursts and random jumps.',
        tags: [
            'scanned',
            'raster',
            'navigation',
        ],
        fixtures: ['scanned-large-431'],
        defaultProfile: 'slow-a-gpu',
        steps: [
            {
                kind: 'open',
                fixture: 'scanned-large-431',
            },
            { kind: 'gc' },
            {
                kind: 'wheelBurst',
                deltaY: 1000,
                count: 100,
            },
            {
                kind: 'randomPages',
                count: 25,
                seed: 431,
            },
            {
                kind: 'command',
                name: 'handleZoomIn',
                repeat: 4,
            },
            {
                kind: 'wheelBurst',
                deltaY: 600,
                count: 40,
            },
            {
                kind: 'command',
                name: 'handleFitWidth',
            },
            { kind: 'gc' },
            {
                kind: 'idle',
                ms: 2_000,
            },
        ],
    }),
    operator({
        id: 'op-explore-many-pages',
        title: 'Operator explores a 4000-page document',
        description: 'A model-driven operator opens the document, uses the page box, scrolls and zooms, then reports.',
        tags: [
            'operator',
            'navigation',
        ],
        fixtures: ['many-pages-text-4000'],
        defaultProfile: 'slow-a',
        taskCard: {
            goal: 'Explore a very long document and report how the viewer behaved.',
            steps: [
                'Open the document.',
                'Wait until the first page is visible.',
                'Go to page 2500 using the page number box in the toolbar.',
                'Scroll down for about ten screens, then up for five.',
                'Zoom in twice, then zoom out twice.',
                'Go to the last page, then back to page 1.',
            ],
            pace: 'Work quickly; do not pause between steps unless the app is still loading.',
            doneWhen: 'You are back on page 1 and the page is rendered.',
            doNot: COMMON_DO_NOT,
        },
    }),
    operator({
        id: 'op-annotate-and-save',
        title: 'Operator adds notes and saves',
        description: 'Annotation tool discovery, text entry, and save via keyboard on a working copy.',
        tags: [
            'operator',
            'annotations',
            'save',
        ],
        fixtures: ['text-small-12'],
        workingCopies: ['text-small-12'],
        defaultProfile: 'slow-a',
        taskCard: {
            goal: 'Add three text notes on three different pages and save the file.',
            steps: [
                'Open the document.',
                'Find the text-note (free text) tool in the toolbar.',
                'On page 1, 3 and 5 add one note containing the word STRESS.',
                'Save with the keyboard shortcut (Cmd+S on macOS, Ctrl+S elsewhere).',
                'Confirm the save indicator no longer shows unsaved changes.',
            ],
            pace: 'Normal.',
            doneWhen: 'Three notes exist and the document is saved.',
            doNot: COMMON_DO_NOT,
        },
    }),
    operator({
        id: 'op-tab-juggle',
        title: 'Operator juggles two heavy tabs and splits the view',
        description: 'Tab switching pressure and split view driven through the visible UI.',
        tags: [
            'operator',
            'tabs',
            'split',
        ],
        fixtures: [
            'dense-annotations-2000',
            'scanned-large-431',
        ],
        defaultProfile: 'slow-a',
        taskCard: {
            goal: 'Work with two documents in separate tabs and switch between them repeatedly.',
            steps: [
                'Open the first document.',
                'Open the second document in a new tab.',
                'Switch between the two tabs six times, scrolling a little in each.',
                'Go to the last page of the second document.',
            ],
            pace: 'Fast; switch tabs as soon as the previous tab has rendered.',
            doneWhen: 'Both tabs are open and the second document shows its last page.',
            doNot: COMMON_DO_NOT,
        },
    }),
    operator({
        id: 'op-corrupt-then-recover',
        title: 'Operator hits a corrupt file and recovers',
        description: 'Error presentation must be understandable to a naive operator, and recovery must not need a restart.',
        tags: [
            'operator',
            'failure',
            'recovery',
        ],
        fixtures: [
            'corrupt-truncated',
            'text-small-12',
        ],
        defaultProfile: 'baseline',
        taskCard: {
            goal: 'Open a damaged file, describe what the app shows, then open a good file.',
            steps: [
                'Open the first (damaged) document.',
                'Describe any error message you see; do not click its buttons.',
                'Open the second document in a new tab.',
                'Go to its last page.',
            ],
            pace: 'Normal.',
            doneWhen: 'The second document is open and its last page is visible.',
            doNot: COMMON_DO_NOT,
        },
    }),
    operator({
        id: 'op-xlarge-endurance',
        title: 'Operator scrolls a 513 MiB document',
        description: 'Endurance flow on the sparse extra-large fixture with a longer deadline.',
        tags: [
            'operator',
            'xlarge',
        ],
        fixtures: ['xlarge-sparse-513mib'],
        defaultProfile: 'baseline',
        budgets: {
            ...DEFAULT_STRESS_BUDGETS,
            deadlineMs: 15 * 60_000,
        },
        taskCard: {
            goal: 'Open a very large document and move around in it without the app freezing.',
            steps: [
                'Open the document and wait until a page is visible.',
                'Go to the last page using the page number box.',
                'Scroll up for thirty screens.',
                'Zoom in once and scroll down for ten screens.',
            ],
            pace: 'Fast.',
            doneWhen: 'You have completed the scrolling and the page still renders.',
            doNot: COMMON_DO_NOT,
        },
    }),
];

export function listStressScenarioIds() {
    return STRESS_SCENARIOS.map(scenario => scenario.id);
}

export function findStressScenario(id: string) {
    return STRESS_SCENARIOS.find(scenario => scenario.id === id) ?? null;
}

export function selectStressScenarios(filters: {
    ids?: string[];
    tags?: string[];
    kind?: 'deterministic' | 'operator' | null
}) {
    const requestedIds = filters.ids ?? [];
    const unknown = requestedIds.filter(id => !findStressScenario(id));
    if (unknown.length > 0) {
        throw new Error(`Unknown stress scenario(s): ${unknown.join(', ')}. Known: ${listStressScenarioIds().join(', ')}`);
    }
    return STRESS_SCENARIOS.filter((scenario) => {
        if (requestedIds.length > 0 && !requestedIds.includes(scenario.id)) {
            return false;
        }
        if (filters.kind && scenario.kind !== filters.kind) {
            return false;
        }
        const tags = filters.tags ?? [];
        return tags.length === 0 || tags.some(tag => scenario.tags.includes(tag));
    });
}

export function resolveStressThresholds(scenario: TStressScenario): IStressThresholds {
    return {
        ...DEFAULT_STRESS_THRESHOLDS,
        ...scenario.thresholds,
    };
}
