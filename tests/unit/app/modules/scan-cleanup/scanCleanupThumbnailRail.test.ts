// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
    Teleport,
} from 'vue';
import type {
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import {
    resolveScanCleanupSelection,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';

vi.mock('@app/components/document-viewer/DocumentThumbnailList.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        inheritAttrs: false,
        props: {
            currentPage: {
                type: Number,
                required: true,
            },
            selectedPages: {
                type: Object,
                required: true,
            },
            source: {
                type: Object,
                default: null,
            },
        },
        emits: ['go-to-page'],
        setup(props, {
            attrs,
            emit,
            slots,
        }) {
            return () => vue.h('div', {
                ...attrs,
                'data-thumbnail-list-stub': '',
            }, Array.from({length: (props.source as IDocumentPageSource | null)?.pageCount ?? 0}, (_, index) => {
                const position = index + 1;
                return vue.h('div', {
                    'data-position': position,
                    'data-current': position === props.currentPage ? 'true' : 'false',
                    'data-selected': (props.selectedPages as ReadonlySet<number>).has(position) ? 'true' : 'false',
                    onClick: (event: MouseEvent) => emit('go-to-page', position, event),
                }, [
                    slots.overlay?.({pageNumber: position}),
                    slots.label?.({pageNumber: position}),
                ]);
            }));
        },
    })};
});

const messages: Record<string, string> = {
    'scanCleanup.pages.title': 'Source pages',
    'scanCleanup.pages.count': '{count} source pages',
    'scanCleanup.pages.sort.label': 'Sort pages',
    'scanCleanup.pages.sort.natural': 'Natural order',
    'scanCleanup.pages.sort.classification': 'By layout',
    'scanCleanup.pages.sort.confidence': 'Confidence: low first',
    'scanCleanup.pages.classification.single': 'Single',
    'scanCleanup.pages.classification.spread': 'Spread',
    'scanCleanup.pages.classification.offcut': 'Offcut',
    'scanCleanup.pages.override.auto': 'Auto',
    'scanCleanup.pages.override.single': 'Single page',
    'scanCleanup.pages.override.spread': 'Two-page spread',
    'scanCleanup.pages.override.keepLeft': 'Keep left half',
    'scanCleanup.pages.override.keepRight': 'Keep right half',
    'scanCleanup.pages.overrideFor': 'Layout override for page {page}',
    'scanCleanup.pages.rotateCurrent': 'Rotate page (currently {rotation}°)',
    'scanCleanup.pages.includeInOutput': 'Include in output',
    'scanCleanup.pages.excludedFromOutput': 'Excluded from output',
    'scanCleanup.pages.lowConfidence': 'Low-confidence detection',
    'scanCleanup.pages.processed': 'Processed',
    'scanCleanup.pages.sourceLoading': 'Loading source pages…',
    'scanCleanup.pages.sourceUnavailable': 'Source pages are unavailable',
    'scanCleanup.pages.sourceUnavailableHint': 'Reopen Scan Cleanup',
    'scanCleanup.pages.detectionPending': 'Detecting page {page}',
};

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (
    key: string,
    parameters?: Record<string, string | number>,
) => Object.entries(parameters ?? {}).reduce(
    (value, [
        parameter,
        replacement,
    ]) => value.replace(`{${parameter}}`, String(replacement)),
    messages[key] ?? key,
)})}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {
        icon: {
            type: String,
            default: '',
        },
        label: {
            type: String,
            default: '',
        },
    },
    setup: (props, {attrs}) => () => h('button', {
        ...attrs,
        type: 'button',
    }, [
        props.icon ? h('span', {'data-icon': props.icon}) : null,
        props.label,
    ]),
});
const SelectStub = defineComponent({
    inheritAttrs: false,
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: String,
            default: '',
        },
        portal: {
            type: [
                Boolean,
                String,
            ],
            default: false,
        },
        ui: {
            type: Object,
            default: () => ({}),
        },
    },
    emits: ['update:modelValue'],
    setup(props, {
        attrs,
        emit,
    }) {
        const open = ref(false);
        return () => {
            const items = props.items as Array<{
                label: string;
                value: string
            }>;
            const trigger = h('select', {
                ...attrs,
                value: props.modelValue,
                onClick: () => { open.value = true; },
                onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
            }, items.map(item => h('option', {value: item.value}, item.label)));
            if (!open.value || !props.portal) {
                return trigger;
            }
            const ui = props.ui as Record<string, string>;
            const menu = h('div', {
                class: ui.content,
                'data-select-menu-stub': '',
            }, items.map(item => h('span', {
                class: ui.itemLabel,
                'data-select-item-label-stub': '',
            }, item.label)));
            return [
                trigger,
                h(Teleport, {to: typeof props.portal === 'string' ? props.portal : 'body'}, menu),
            ];
        };
    },
});
const BadgeStub = defineComponent({setup: (_props, {slots}) => () => h('span', {'data-ui-badge': ''}, slots.default?.())});
const IconStub = defineComponent({
    inheritAttrs: false,
    props: {name: {
        type: String,
        default: '',
    }},
    setup: (props, {attrs}) => () => h('span', {
        ...attrs,
        'data-icon': props.name,
    }),
});
const SlotStub = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});
const mountedApps = new Set<() => void>();

function createSource(pageCount = 5): IDocumentPageSource {
    const renderPage = vi.fn(async () => ({
        widthPx: 100,
        heightPx: 140,
        bytes: 56_000,
        surface: 'data:image/png;base64,',
        release: vi.fn(),
    }));
    return {
        kind: 'pdf',
        documentRef: '/document.pdf',
        pageCount,
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 500,
            heightPoints: 700,
            rotation: 0 as const,
        })),
        renderPage,
        thumbnailProvider: {renderThumbnail: renderPage},
        dispose: vi.fn(),
    };
}

function mountRail(options: {
    source?: IDocumentPageSource | null;
    sourcePending?: boolean;
    detectionActive?: boolean;
    classifications?: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    confidences?: ReadonlyMap<number, number>;
    overrides?: TScanCleanupPageOverrides;
    leader?: number;
    selected?: ReadonlySet<number>;
    processed?: ReadonlySet<number>;
} = {}) {
    const source = options.source === undefined ? createSource() : options.source;
    const leader = ref(options.leader ?? 1);
    const anchor = ref(options.leader ?? 1);
    const selected = ref<ReadonlySet<number>>(options.selected ?? new Set([leader.value]));
    const overrideUpdates: Array<[number, IScanCleanupPageOverride]> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(ScanCleanupThumbnailRail, {
        source,
        sourcePending: options.sourcePending ?? false,
        detectionActive: options.detectionActive ?? false,
        totalPages: source?.pageCount ?? 5,
        selectionLeader: leader.value,
        selectedPages: selected.value,
        overrides: options.overrides ?? {},
        classifications: options.classifications ?? new Map(),
        confidences: options.confidences ?? new Map(),
        processedPages: options.processed ?? new Set(),
        disabled: false,
        onSelectPage: (page: number, intent: TScanCleanupSelectionIntent, orderedPages: readonly number[]) => {
            const next = resolveScanCleanupSelection({
                anchor: anchor.value,
                leader: leader.value,
                selectedPages: selected.value,
            }, page, intent, orderedPages);
            anchor.value = next.anchor;
            leader.value = next.leader;
            selected.value = next.selectedPages;
        },
        'onUpdate:override': (page: number, value: IScanCleanupPageOverride) => overrideUpdates.push([
            page,
            value,
        ]),
    })}));
    app.component('AppTooltip', SlotStub);
    app.component('UBadge', BadgeStub);
    app.component('UButton', ButtonStub);
    app.component('UIcon', IconStub);
    app.component('UPopover', SlotStub);
    app.component('USelect', SelectStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        mountedApps.delete(unmount);
    };
    mountedApps.add(unmount);
    return {
        host,
        leader,
        overrideUpdates,
        selected,
    };
}

function naturalOrder(host: HTMLElement) {
    return Array.from(host.querySelectorAll<HTMLElement>('.scan-thumbnail-overlay'))
        .map(element => Number(element.dataset.pageNumber));
}

afterEach(() => {
    for (const unmount of mountedApps) unmount();
    document.body.innerHTML = '';
});

describe('ScanCleanupThumbnailRail', () => {
    it('docks selected-row controls in the measured label band below the thumbnail overlay', () => {
        const harness = mountRail();
        const selectedRow = harness.host.querySelector<HTMLElement>('[data-position="1"]')!;
        const overlay = selectedRow.querySelector<HTMLElement>('.scan-thumbnail-overlay')!;
        const controls = selectedRow.querySelector<HTMLElement>('.scan-thumbnail-controls')!;
        const labelBand = selectedRow.querySelector<HTMLElement>('.scan-thumbnail-label-band')!;

        expect(overlay.contains(controls)).toBe(false);
        expect(labelBand.contains(controls)).toBe(true);
        expect(controls.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    it('shows explicit loading and unavailable states instead of a blank rail', async () => {
        const loading = mountRail({
            source: null,
            sourcePending: true,
        });
        expect(loading.host.querySelector('.scan-thumbnail-source-state')?.textContent)
            .toContain('Loading source pages…');
        expect(loading.host.querySelector('.scan-thumbnail-source-state')?.getAttribute('role')).toBe('status');

        loading.host.remove();
        const unavailable = mountRail({
            source: null,
            sourcePending: false,
        });
        await nextTick();
        expect(unavailable.host.querySelector('.scan-thumbnail-source-state')?.textContent)
            .toContain('Source pages are unavailable');
        expect(unavailable.host.querySelector('.scan-thumbnail-source-state')?.textContent)
            .toContain('Reopen Scan Cleanup');
        expect(unavailable.host.querySelector('.scan-thumbnail-source-state')?.getAttribute('role')).toBe('alert');
    });

    it('keeps the rail header limited to source title, count, and sort', () => {
        const overrides: TScanCleanupPageOverrides = {'1': {
            rotation: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplitX: null,
        }};
        const harness = mountRail({overrides});
        const header = harness.host.querySelector('.scan-thumbnail-rail-header');

        expect(header?.textContent).toContain('Source pages');
        expect(header?.querySelector('.scan-thumbnail-sort')).not.toBeNull();
        expect(header?.querySelectorAll('button')).toHaveLength(0);
    });

    it('portals the override menu outside the virtual list and renders complete item labels', async () => {
        const harness = mountRail();
        const list = harness.host.querySelector<HTMLElement>('[data-thumbnail-list-stub]')!;
        const trigger = harness.host.querySelector<HTMLSelectElement>('.scan-thumbnail-override-select')!;

        trigger.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();

        const menu = document.body.querySelector<HTMLElement>('.scan-thumbnail-override-menu')!;
        const labels = Array.from(menu.querySelectorAll<HTMLElement>('[data-select-item-label-stub]'));
        expect(menu).not.toBeNull();
        expect(harness.host.contains(menu)).toBe(false);
        expect(list.contains(menu)).toBe(false);
        expect(menu.classList).toContain('w-auto');
        expect(menu.classList).toContain('min-w-(--reka-select-trigger-width)');
        expect(labels.map(label => label.textContent)).toEqual([
            'Auto',
            'Single page',
            'Two-page spread',
            'Keep left half',
            'Keep right half',
        ]);
        expect(labels.every(label => label.classList.contains('whitespace-nowrap'))).toBe(true);
        expect(labels.every(label => !label.classList.contains('truncate'))).toBe(true);

        const renderedMenuWidth = Math.max(...labels.map(label => label.textContent?.length ?? 0));
        Object.defineProperty(menu, 'clientWidth', {
            configurable: true,
            value: renderedMenuWidth,
        });
        for (const label of labels) {
            const labelWidth = label.textContent?.length ?? 0;
            Object.defineProperties(label, {
                clientWidth: {
                    configurable: true,
                    value: renderedMenuWidth,
                },
                scrollWidth: {
                    configurable: true,
                    value: labelWidth,
                },
            });
            expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
        }
    });

    it('streams pending detection indicators into classification badges page by page', async () => {
        const classifications = reactive(new Map<number, IScanCleanupPreviewMetadata['layoutClassification']>());
        const harness = mountRail({
            classifications,
            detectionActive: true,
        });

        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(5);
        expect(harness.host.querySelector('[aria-label="Detecting page 1"]')).not.toBeNull();

        classifications.set(1, 'two-page-spread');
        await nextTick();
        expect(harness.host.querySelectorAll('.scan-thumbnail-detection-pending')).toHaveLength(4);
        expect(harness.host.querySelector('[data-page-number="1"]')?.textContent).toContain('Spread');
    });

    it('supports single, Ctrl/Cmd toggle, Shift range, and keyboard leader navigation', async () => {
        const harness = mountRail();
        const row = (page: number) => harness.host.querySelector<HTMLElement>(`.scan-thumbnail-overlay[data-page-number="${String(page)}"]`)?.parentElement;

        row(2)?.click();
        await nextTick();
        expect(harness.leader.value).toBe(2);
        expect([...harness.selected.value]).toEqual([2]);

        row(4)?.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            ctrlKey: true,
        }));
        await nextTick();
        expect(harness.leader.value).toBe(4);
        expect([...harness.selected.value]).toEqual([
            2,
            4,
        ]);

        row(1)?.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            shiftKey: true,
        }));
        await nextTick();
        expect(harness.leader.value).toBe(1);
        expect([...harness.selected.value]).toEqual([
            1,
            2,
            3,
            4,
        ]);

        const list = harness.host.querySelector<HTMLElement>('[data-thumbnail-list-stub]')!;
        list.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'End',
        }));
        await nextTick();
        expect(harness.leader.value).toBe(5);
        expect([...harness.selected.value]).toEqual([5]);
        expect(harness.host.querySelector('[data-position="5"]')?.getAttribute('data-current')).toBe('true');

        list.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'PageUp',
        }));
        await nextTick();
        expect(harness.leader.value).toBe(1);
    });

    it('sorts only rail positions by classification and confidence with unknowns last', async () => {
        const harness = mountRail({
            classifications: reactive(new Map([
                [
                    1,
                    'two-page-spread' as const,
                ],
                [
                    3,
                    'single-uncut-page' as const,
                ],
                [
                    4,
                    'page-with-offcut' as const,
                ],
            ])),
            confidences: reactive(new Map([
                [
                    1,
                    0.8,
                ],
                [
                    3,
                    0.2,
                ],
                [
                    5,
                    0.5,
                ],
            ])),
        });
        const sort = harness.host.querySelector<HTMLSelectElement>('.scan-thumbnail-sort');
        expect(naturalOrder(harness.host)).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);

        sort!.value = 'classification';
        sort!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(naturalOrder(harness.host)).toEqual([
            3,
            4,
            1,
            2,
            5,
        ]);

        sort!.value = 'confidence';
        sort!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(naturalOrder(harness.host)).toEqual([
            3,
            5,
            1,
            2,
            4,
        ]);
    });

    it('shows classification or override, warning, exclusion, rotation, and selected-row controls', async () => {
        const harness = mountRail({
            leader: 2,
            selected: new Set([
                2,
                3,
            ]),
            classifications: new Map([[
                2,
                'single-uncut-page',
            ]]),
            confidences: new Map([[
                2,
                0.4,
            ]]),
            processed: new Set([
                1,
                2,
            ]),
            overrides: {
                '2': {
                    rotation: 90,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplitX: null,
                },
                '3': {
                    rotation: 0,
                    layoutOverride: 'keep-left',
                    excluded: true,
                    manualSplitX: null,
                },
            },
        });
        const page2 = harness.host.querySelector<HTMLElement>('[data-page-number="2"]')!;
        const page3 = harness.host.querySelector<HTMLElement>('[data-page-number="3"]')!;

        expect(page2.textContent).toContain('Single');
        expect(page2.querySelector('.scan-thumbnail-low-confidence')?.textContent).toBe('?');
        expect(page2.querySelector('.scan-thumbnail-rotation')?.textContent).toContain('90°');
        expect(page2.parentElement?.querySelector('.scan-thumbnail-controls')).not.toBeNull();
        expect(page2.querySelector('[data-icon="i-ph-check-circle"]')).not.toBeNull();
        expect(page3.textContent).toContain('Keep left half');
        expect(page3.classList.contains('is-excluded')).toBe(true);
        expect(page3.querySelector('[data-icon="i-ph-eye-slash"]')).not.toBeNull();
        expect(page3.parentElement?.querySelector('.scan-thumbnail-page-number')?.classList.contains('is-excluded')).toBe(true);
        expect(page3.querySelector('.scan-thumbnail-controls')).toBeNull();
        expect(page3.querySelector('[data-icon="i-ph-check-circle"]')).toBeNull();

        const rotate = page2.parentElement?.querySelector<HTMLButtonElement>('[aria-label="Rotate page (currently 90°)"]');
        rotate?.click();
        await nextTick();
        expect(harness.overrideUpdates.at(-1)).toEqual([
            2,
            expect.objectContaining({rotation: 180}),
        ]);
    });
});
