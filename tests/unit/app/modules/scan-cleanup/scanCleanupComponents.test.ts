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
    shallowRef,
} from 'vue';
import type {
    IScanCleanupPreviewRect,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupPageAlignment,
    TScanCleanupPageLayoutOverride,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {updateScanCleanupPageOverrides} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue';
import ScanCleanupToolbar from '@app/modules/scan-cleanup/components/ScanCleanupToolbar.vue';
import ScanCleanupWorkspace from '@app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue';
import type {IScanCleanupTabSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

const workspaceSession = vi.hoisted(() => ({value: null as Record<string, unknown> | null}));
const workspaceSessionOptions = vi.hoisted(() => ({value: null as Record<string, () => unknown> | null}));
const workspaceSessionInitial = vi.hoisted(() => ({value: null as {
    page: unknown;
    viewMode: unknown;
    zoomMode: unknown;
} | null}));

vi.mock('@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession', () => ({useScanCleanupWorkspaceSession: (
    options: Record<string, () => unknown>,
) => {
    workspaceSessionOptions.value = options;
    workspaceSessionInitial.value = {
        page: options.initialPreviewPage?.(),
        viewMode: options.initialPreviewViewMode?.(),
        zoomMode: options.initialPreviewZoomMode?.(),
    };
    return workspaceSession.value;
}}));

const translations: Record<string, string> = {
    'scanCleanup.pages.title': 'Source pages',
    'scanCleanup.pages.classification.single': 'Single',
    'scanCleanup.pages.classification.spread': 'Spread',
    'scanCleanup.pages.classification.offcut': 'Offcut',
    'scanCleanup.pages.includeInOutput': 'Include in output',
    'scanCleanup.pages.excludedFromOutput': 'Excluded from output',
    'scanCleanup.preview.unavailable': 'Preview isn\'t available. You can still run cleanup.',
    'scanCleanup.preview.retry': 'Retry',
    'scanCleanup.preview.technicalDetails': 'Technical details',
    'scanCleanup.preview.loadingPage': 'Loading page {page}…',
    'scanCleanup.preview.cleanedAlt': 'Cleaned scan preview for page {page}, {half}',
    'scanCleanup.preview.outputHalf.left': 'left half',
    'scanCleanup.preview.outputHalf.right': 'right half',
    'scanCleanup.preview.outputHalf.full': 'full page',
    'scanCleanup.preview.preview': 'Preview',
    'scanCleanup.output.label': 'Output mode',
    'scanCleanup.output.preserveOriginalQuality': 'Preserve original quality (no rasterization)',
    'scanCleanup.output.losslessDisabledOptions': 'Raster cleanup options are unavailable in this mode.',
    'scanCleanup.contentPreserved': 'Output preserves original page content.',
    'scanCleanup.workspaceTitle': 'Scan cleanup',
    'scanCleanup.description': 'Clean scanned pages.',
    'scanCleanup.done': 'Done',
    'scanCleanup.settings.tabsLabel': 'Settings scope',
    'scanCleanup.settings.document': 'Document',
    'scanCleanup.settings.selection': 'Selection ({count})',
    'scanCleanup.settings.selectionDisabled': 'Select pages',
    'scanCleanup.settings.applyTo': 'Apply to…',
    'scanCleanup.settings.layoutOverride': 'Page layout override',
    'scanCleanup.settings.rotation': 'Rotation',
    'scanCleanup.settings.rotationDegrees': '{value}°',
    'scanCleanup.settings.inOutput': 'Output inclusion',
    'scanCleanup.settings.mixed': '— Mixed',
    'scanCleanup.settings.manualSplit': 'Spread cutter',
    'scanCleanup.settings.contentBox': 'Content box',
    'scanCleanup.settings.reset': 'Reset',
    'scanCleanup.settings.automatic': 'Automatic',
    'scanCleanup.settings.manual': 'Manual',
    'scanCleanup.settings.selectionAlignment': 'Content placement for selected pages',
    'scanCleanup.settings.enableMatchPageSize': 'Enable match page size',
    'scanCleanup.settings.applyScopes.allPages': 'All pages',
    'scanCleanup.settings.applyScopes.fromHere': 'From this page on',
    'scanCleanup.settings.applyScopes.selectedPages': 'Selected pages',
    'scanCleanup.settings.applyScopes.everyOther': 'Every other page',
    'common.cancel': 'Cancel',
    'scanCleanup.cleanUp': 'Clean up',
    'scanCleanup.detectAll.action': 'Detect layout for all pages',
    'scanCleanup.detectAll.redetect': 'Re-detect',
    'scanCleanup.detectAll.progressAria': 'Detecting layout: {detected} of {total} pages',
    'scanCleanup.detectAll.cancel': 'Cancel detection',
    'scanCleanup.detectAll.canceling': 'Canceling…',
    'scanCleanup.pages.resetAll': 'Reset overrides…',
    'scanCleanup.pages.resetConfirm': 'Reset all page overrides?',
    'scanCleanup.pages.resetConfirmBody': 'Clear overrides',
    'scanCleanup.pages.resetAction': 'Reset',
    'scanCleanup.steps.label': 'Scan cleanup progress',
    'scanCleanup.steps.detect': 'Detect',
    'scanCleanup.steps.review': 'Review',
    'scanCleanup.steps.cleanUp': 'Clean up',
    'scanCleanup.firstRun.title': 'How scan cleanup works',
    'scanCleanup.firstRun.detect': 'Pages are detected automatically.',
    'scanCleanup.firstRun.review': 'Review pages — drag the cutter or boxes, and adjust per-page settings.',
    'scanCleanup.firstRun.cleanUp': 'Clean up creates a new PDF; the original is untouched.',
    'scanCleanup.firstRun.dismiss': 'Got it',
};

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (
    key: string,
    parameters?: Record<string, string | number>,
) => Object.entries(parameters ?? {}).reduce(
    (value, [
        parameter,
        replacement,
    ]) => value.replace(`{${parameter}}`, String(replacement)),
    translations[key] ?? key,
)})}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        icon: {
            type: String,
            default: '',
        },
        label: {
            type: String,
            default: '',
        },
    },
    setup(props, {
        attrs,
        slots,
    }) {
        return () => h('button', {
            ...attrs,
            disabled: props.disabled,
            type: 'button',
        }, [
            props.icon ? h('span', {'data-icon': props.icon}) : null,
            ...(slots.default?.() ?? []),
            props.label,
        ]);
    },
});
const SelectStub = defineComponent({
    inheritAttrs: false,
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: [
                String,
                Number,
            ],
            default: '',
        },
    },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('select', {
        ...attrs,
        'data-ui-select': '',
        value: props.modelValue,
        onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
    }, (props.items as Array<{
        label: string;
        value: string | number;
    }>).map(item => h('option', {value: item.value}, item.label))),
});
const SlotStub = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});
const BadgeStub = defineComponent({setup: (_props, {slots}) => () => h('span', {'data-ui-badge': ''}, slots.default?.())});
const IconStub = defineComponent({setup: () => () => h('span', {'data-ui-icon': ''})});
const SkeletonStub = defineComponent({setup: () => () => h('span', {'data-ui-skeleton': ''})});
const PopoverStub = defineComponent({setup: (_props, {slots}) => () => h('span', [
    slots.default?.(),
    slots.content?.(),
])});
const CheckboxStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        label: {
            type: String,
            default: '',
        },
        modelValue: Boolean,
    },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('label', [
        h('input', {
            ...attrs,
            checked: props.modelValue,
            disabled: props.disabled,
            type: 'checkbox',
            onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked),
        }),
        props.label,
    ]),
});
const DropdownMenuStub = defineComponent({
    props: {items: {
        type: Array,
        default: () => [],
    }},
    setup: (props, {slots}) => () => h('div', [
        slots.default?.(),
        h('div', {role: 'menu'}, (props.items as Array<{
            label: string;
            onSelect: () => void;
        }>).map(item => h('button', {
            role: 'menuitem',
            type: 'button',
            onClick: item.onSelect,
        }, item.label))),
    ]),
});
const TabsStub = defineComponent({
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: String,
            default: '',
        },
    },
    emits: ['update:modelValue'],
    setup: (props, {emit}) => () => h('div', {role: 'tablist'}, (props.items as Array<{
        disabled?: boolean;
        label: string;
        title?: string;
        value: string;
    }>).map(item => h('button', {
        'aria-selected': item.value === props.modelValue,
        disabled: item.disabled,
        role: 'tab',
        title: item.title,
        type: 'button',
        onClick: () => emit('update:modelValue', item.value),
    }, item.label))),
});

const activeUnmounts = new Set<() => void>();

function spreadPreviewResult(pageNumber = 1): IScanCleanupPreviewResult {
    const output = (half: 'left' | 'right', x: number) => ({
        imageData: new Uint8Array([1]),
        metadata: {
            half,
            layoutClassification: 'two-page-spread' as const,
            layoutConfidence: 0.82,
            sourceRegion: {
                x,
                y: 0,
                width: 500,
                height: 800,
            },
            contentBox: null,
            appliedMargins: [
                0,
                0,
                0,
                0,
            ] as [number, number, number, number],
            outputWidth: 500,
            outputHeight: 800,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    -x,
                ],
                [
                    0,
                    1,
                    0,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
            cutterX: 500,
            inputWidth: 1000,
            inputHeight: 800,
            rotation: 0 as const,
            resamplePasses: 1,
            warnings: [],
        },
    });
    return {
        pageNumber,
        totalPages: 3,
        rawImageData: new Uint8Array([1]),
        rawWidth: 1000,
        rawHeight: 800,
        pageMetadata: {
            layoutClassification: 'two-page-spread',
            cutterX: 500,
            rotation: 0,
            excluded: false,
            blankOutputsSkipped: 0,
        },
        outputs: [
            output('left', 0),
            output('right', 500),
        ],
    };
}

function mount(component: Parameters<typeof createApp>[0]) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(component);
    app.component('AppTooltip', SlotStub);
    app.component('UBadge', BadgeStub);
    app.component('UButton', ButtonStub);
    app.component('UCheckbox', CheckboxStub);
    app.component('UDropdownMenu', DropdownMenuStub);
    app.component('UFormField', SlotStub);
    app.component('UIcon', IconStub);
    app.component('UInput', SlotStub);
    app.component('UPopover', PopoverStub);
    app.component('UProgress', SlotStub);
    app.component('USelect', SelectStub);
    app.component('USkeleton', SkeletonStub);
    app.component('USlider', SlotStub);
    app.component('UTabs', TabsStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of activeUnmounts) unmount();
    document.body.innerHTML = '';
});

describe('Scan cleanup components', () => {
    it('round-trips the toolbar surface command through Done while Escape keeps the workspace open', async () => {
        const updateCurrentPlacementAll = vi.fn();
        const detectAllPages = vi.fn();
        const cancelDetection = vi.fn();
        const isDetecting = ref(false);
        const detectionProgress = ref({
            detectedCount: 0,
            totalPages: 12,
        });
        const selectedPages = ref<ReadonlySet<number>>(new Set([7]));
        const previewPage = ref(7);
        const previewViewMode = ref<'original' | 'cleaned'>('cleaned');
        const previewZoomMode = ref<'fit' | 'actual'>('fit');
        const isRunning = ref(false);
        const jobProgress = ref({
            percent: 0,
            processedCount: 0,
            totalPages: 12,
        });
        const progressText = ref('Processed 0 of 12 source pages');
        workspaceSession.value = {
            alignmentItems: ref([{
                value: 'bottom-right',
                icon: 'i-ph-arrow-down-right',
                label: 'Place at bottom right',
            }]),
            cancel: vi.fn(),
            cancelDetection,
            cancelRequested: ref(false),
            canDetectAll: ref(true),
            canRun: ref(false),
            currentPageOverride: ref({
                manualSplitX: null,
                manualContentBoxes: {},
                placementOverrides: {},
            }),
            currentPlacementAlignment: ref('top-center'),
            handleThicknessInput: vi.fn(),
            detectAllPages,
            detectionCancelRequested: ref(false),
            detectionError: ref(''),
            detectionPending: isDetecting,
            detectionProgress,
            inlineError: ref(''),
            isDetecting,
            isRunning,
            jobProgress,
            layoutItems: ref([]),
            navigatePreview: vi.fn(),
            outputEstimate: ref(''),
            outputItems: ref([
                {
                    value: 'bw',
                    label: 'B&W',
                    fullLabel: 'Black and white',
                },
                {
                    value: 'grayscale',
                    label: 'Gray',
                    fullLabel: 'Grayscale',
                },
                {
                    value: 'color',
                    label: 'Color',
                    fullLabel: 'Color',
                },
            ]),
            previewClassifications: reactive(new Map()),
            previewConfidences: reactive(new Map()),
            previewError: ref(''),
            previewLoading: ref(false),
            previewPage,
            processedPages: ref(new Set()),
            previewResult: ref(null),
            previewTotalPages: ref(12),
            previewViewMode,
            previewZoomMode,
            progressText,
            readingOrderItems: ref([]),
            resetPageOverrides: vi.fn(),
            retryPreview: vi.fn(),
            run: vi.fn(),
            runOcrAfterCleanup: ref(false),
            showFirstRunGuidance: ref(false),
            dismissFirstRunGuidance: vi.fn(),
            selectedPages,
            selectionLeader: ref(7),
            selectPage: vi.fn(),
            settings: reactive({
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'color',
                readingOrder: 'ltr',
                thickness: 0,
                crop: false,
                matchPageSize: true,
                pageAlignment: 'top-center',
                marginsMm: 0,
                despeckle: false,
                skipBlankPages: false,
                straightenCurvedLines: false,
                pageOverrides: {},
            }),
            thicknessLabel: ref('0'),
            updateCurrentManualSplit: vi.fn(),
            updateCurrentManualContentBox: vi.fn(),
            updateCurrentPlacement: vi.fn(),
            updateCurrentPlacementAll,
            updatePageOverride: vi.fn(),
        };
        const readerState = {
            surfaceMode: ref<'reader' | 'scan-cleanup'>('reader'),
            viewport: {
                page: 37,
                zoom: 1.75,
            },
        };
        const retainedViewport = readerState.viewport;
        const cleanupSession = ref<IScanCleanupTabSessionState>({
            previewPage: 31,
            previewViewMode: 'original',
            previewZoomMode: 'actual',
        });
        const harness = mount(defineComponent(() => () => h('div', [
            h('button', {
                'data-toolbar-scan-cleanup': '',
                onClick: () => { readerState.surfaceMode.value = 'scan-cleanup'; },
            }),
            h('div', {
                'data-reader': '',
                style: {display: readerState.surfaceMode.value === 'reader' ? '' : 'none'},
            }),
            readerState.surfaceMode.value === 'scan-cleanup'
                ? h(ScanCleanupWorkspace, {
                    sourcePath: '/docs/book.pdf',
                    currentPage: readerState.viewport.page,
                    totalPages: 100,
                    sessionState: cleanupSession.value,
                    'onUpdate:sessionState': (state: IScanCleanupTabSessionState) => {
                        cleanupSession.value = state;
                    },
                    onDone: () => { readerState.surfaceMode.value = 'reader'; },
                })
                : null,
        ])));

        harness.host.querySelector<HTMLButtonElement>('[data-toolbar-scan-cleanup]')?.click();
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('scan-cleanup');
        expect(harness.host.querySelector('.scan-cleanup-surface')).not.toBeNull();
        expect(harness.host.querySelector<HTMLElement>('[data-reader]')?.style.display).toBe('none');
        const losslessToggle = Array.from(harness.host.querySelectorAll('label'))
            .find(label => label.textContent?.includes('Preserve original quality'))
            ?.querySelector<HTMLInputElement>('input');
        expect(losslessToggle).not.toBeUndefined();
        losslessToggle!.checked = true;
        losslessToggle!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        const outputModeOptions = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[aria-label="Output mode"] [role="radio"]'));
        expect(outputModeOptions).toHaveLength(3);
        expect(outputModeOptions.every(option => option.disabled)).toBe(true);
        expect(harness.host.textContent).toContain('Raster cleanup options are unavailable in this mode.');
        expect(harness.host.textContent).toContain('Output preserves original page content.');
        losslessToggle!.checked = false;
        losslessToggle!.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(workspaceSessionInitial.value).toEqual({
            page: 31,
            viewMode: 'original',
            zoomMode: 'actual',
        });

        previewPage.value = 9;
        previewViewMode.value = 'original';
        previewZoomMode.value = 'actual';
        await nextTick();
        expect(cleanupSession.value).toEqual({
            previewPage: 9,
            previewViewMode: 'original',
            previewZoomMode: 'actual',
        });

        const detectButton = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Re-detect');
        expect(detectButton?.disabled).toBe(false);
        detectButton?.click();
        expect(detectAllPages).toHaveBeenCalledOnce();
        isDetecting.value = true;
        detectionProgress.value = {
            detectedCount: 2,
            totalPages: 12,
        };
        await nextTick();
        expect(harness.host.querySelector('.scan-cleanup-toolbar')?.textContent).toContain('2 / 12');
        const cancelDetectionButton = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.getAttribute('aria-label') === 'Cancel detection');
        cancelDetectionButton?.click();
        expect(cancelDetection).toHaveBeenCalledOnce();
        isDetecting.value = false;
        await nextTick();

        harness.host.querySelector<HTMLButtonElement>('[aria-label="Place at bottom right"]')?.click();
        expect(updateCurrentPlacementAll).toHaveBeenCalledWith('bottom-right');

        isRunning.value = true;
        jobProgress.value = {
            percent: 25,
            processedCount: 3,
            totalPages: 12,
        };
        progressText.value = 'Processed 3 of 12 source pages';
        await nextTick();
        expect(harness.host.querySelector('.scan-cleanup-toolbar')?.textContent).toContain('3 / 12');
        expect(harness.host.querySelector('.scan-cleanup-toolbar-progress')).not.toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-header')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-footer')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-progress-overlay')).toBeNull();
        expect(harness.host.querySelector('.scan-cleanup-preview-hero')).not.toBeNull();

        const doneButton = Array.from(harness.host.querySelectorAll('button'))
            .find(button => button.textContent?.trim() === 'Done');
        doneButton?.click();
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('reader');
        expect(harness.host.querySelector('.scan-cleanup-surface')).toBeNull();
        expect(readerState.viewport).toBe(retainedViewport);
        expect(readerState.viewport).toEqual({
            page: 37,
            zoom: 1.75,
        });

        selectedPages.value = new Set();
        harness.host.querySelector<HTMLButtonElement>('[data-toolbar-scan-cleanup]')?.click();
        await nextTick();
        expect(workspaceSessionInitial.value).toEqual({
            page: 9,
            viewMode: 'original',
            zoomMode: 'actual',
        });
        const selectionTab = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
            .find(tab => tab.textContent === 'Selection (0)');
        expect(selectionTab?.disabled).toBe(true);
        expect(harness.host.textContent).toContain('Select pages');
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            cancelable: true,
        }));
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('scan-cleanup');
        expect(harness.host.querySelector('.scan-cleanup-surface')).not.toBeNull();
        expect(readerState.viewport).toBe(retainedViewport);

        const reopenedDoneButton = Array.from(harness.host.querySelectorAll('button'))
            .find(button => button.textContent?.trim() === 'Done');
        reopenedDoneButton?.click();
        await nextTick();
        expect(readerState.surfaceMode.value).toBe('reader');
    });

    it('keeps all toolbar zone widths identical across review, detection, and cleanup states', async () => {
        const state = reactive({
            detecting: false,
            running: false,
        });
        const zoneWidths = {
            'scan-cleanup-toolbar-zone-left': 160,
            'scan-cleanup-toolbar-zone-center': 680,
            'scan-cleanup-toolbar-zone-right': 336,
        } as const;
        const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const matched = Object.entries(zoneWidths).find(([className]) => this.classList.contains(className));
            const width = matched?.[1] ?? 0;
            return {
                bottom: 0,
                height: 0,
                left: 0,
                right: width,
                top: 0,
                width,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            };
        });
        const harness = mount(defineComponent(() => () => h(ScanCleanupToolbar, {
            canDetectAll: !state.detecting,
            canRun: true,
            cancelRequested: false,
            cleanupTotal: 120,
            detectionCancelRequested: false,
            detectionDetected: 17,
            detectionError: '',
            detectionTotal: 120,
            isDetecting: state.detecting,
            isRunning: state.running,
            outputEstimate: '120 source pages → about 145 output pages',
            percent: 42,
            processedCount: 51,
            progressText: 'Processed 51 of 120 source pages',
            runOcrAfterCleanup: false,
        })));
        const widths = () => Array.from(harness.host.querySelectorAll<HTMLElement>('.scan-cleanup-toolbar-zone'))
            .map(zone => zone.getBoundingClientRect().width);

        const reviewWidths = widths();
        expect(harness.host.querySelector('[aria-current="step"]')?.textContent).toContain('Review');

        state.detecting = true;
        await nextTick();
        expect(widths()).toEqual(reviewWidths);
        expect(harness.host.querySelector('[aria-current="step"]')?.textContent).toContain('Detect');
        expect(harness.host.querySelector('.scan-cleanup-toolbar-status-slot')?.textContent).toContain('17 / 120');

        state.detecting = false;
        state.running = true;
        await nextTick();
        expect(widths()).toEqual(reviewWidths);
        expect(harness.host.querySelector('[aria-current="step"]')?.textContent).toContain('Clean up');
        expect(harness.host.querySelector('.scan-cleanup-toolbar-status-slot')?.textContent).toContain('51 / 120');
        expect(harness.host.querySelectorAll('.scan-cleanup-toolbar-primary-action')).toHaveLength(1);
        rectSpy.mockRestore();
    });

    it('switches to selection settings, resolves mixed values on edit, and keeps document defaults isolated', async () => {
        const pageOverrides = reactive({
            '1': createScanCleanupPageOverride({layoutOverride: 'single'}),
            '2': createScanCleanupPageOverride({layoutOverride: 'spread'}),
        });
        const settings = reactive({
            layoutMode: 'force-single' as const,
            outputMode: 'color' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'top-left' as const,
            marginsMm: 5,
            despeckle: false,
            skipBlankPages: false,
            straightenCurvedLines: false,
            pageOverrides,
        });
        const selectionLayoutOverride = ref<{
            empty: boolean;
            mixed: boolean;
            value: TScanCleanupPageLayoutOverride;
        }>({
            empty: false,
            mixed: true,
            value: 'single' as const,
        });
        const applyLeaderOverrides = vi.fn();
        const resetPageOverrides = vi.fn();
        workspaceSession.value = {
            alignmentItems: ref([]),
            applyLeaderOverrides,
            cancel: vi.fn(),
            cancelDetection: vi.fn(),
            cancelRequested: ref(false),
            canDetectAll: ref(false),
            canRun: ref(false),
            currentPageOverride: ref(getScanCleanupPageOverride(pageOverrides, 2)),
            detectionCancelRequested: ref(false),
            detectionError: ref(''),
            detectionPending: ref(false),
            detectionProgress: ref({
                detectedCount: 0,
                totalPages: 3,
            }),
            handleThicknessInput: vi.fn(),
            inlineError: ref(''),
            isDetecting: ref(false),
            isRunning: ref(false),
            jobProgress: ref({
                percent: 0,
                processedCount: 0,
                totalPages: 3,
            }),
            layoutItems: ref([]),
            navigatePreview: vi.fn(),
            outputEstimate: ref(''),
            outputItems: ref([]),
            previewClassifications: reactive(new Map()),
            previewConfidences: reactive(new Map()),
            previewError: ref(''),
            previewLoading: ref(false),
            previewPage: ref(2),
            previewResult: ref(null),
            previewTotalPages: ref(3),
            previewViewMode: ref('cleaned'),
            previewZoomMode: ref('fit'),
            progressText: ref(''),
            readingOrderItems: ref([]),
            resetPageOverrides,
            resetSelectionContentBoxes: vi.fn(),
            resetSelectionManualSplit: vi.fn(),
            retryPreview: vi.fn(),
            run: vi.fn(),
            runOcrAfterCleanup: ref(false),
            showFirstRunGuidance: ref(false),
            dismissFirstRunGuidance: vi.fn(),
            selectedPages: ref(new Set([
                1,
                2,
            ])),
            selectionContentBoxes: ref({
                empty: false,
                mixed: false,
                value: {},
            }),
            selectionExcluded: ref({
                empty: false,
                mixed: false,
                value: false,
            }),
            selectionLayoutOverride,
            selectionLeader: ref(2),
            selectionManualSplit: ref({
                empty: false,
                mixed: false,
                value: null,
            }),
            selectionPlacementAlignment: ref({
                empty: false,
                mixed: false,
                value: 'top-left',
            }),
            selectionRotation: ref({
                empty: false,
                mixed: false,
                value: 0,
            }),
            selectPage: vi.fn(),
            settings,
            thicknessLabel: ref('0'),
            updateCurrentManualContentBox: vi.fn(),
            updateCurrentManualSplit: vi.fn(),
            updateCurrentPlacement: vi.fn(),
            updateCurrentPlacementAll: vi.fn(),
            updatePageOverride: vi.fn(),
            updateSelectionExcluded: vi.fn(),
            updateSelectionLayoutOverride: (value: 'auto' | 'single' | 'spread' | 'keep-left' | 'keep-right') => {
                updateScanCleanupPageOverrides(pageOverrides, new Set([
                    1,
                    2,
                ]), current => ({
                    ...current,
                    layoutOverride: value,
                }));
                selectionLayoutOverride.value = {
                    empty: false,
                    mixed: false,
                    value,
                };
            },
            updateSelectionPlacement: vi.fn(),
            updateSelectionRotation: vi.fn(),
        };
        const documentDefaults = {
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        };
        const harness = mount(defineComponent(() => () => h(ScanCleanupWorkspace, {
            sourcePath: null,
            totalPages: 3,
        })));

        const selectionTab = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
            .find(tab => tab.textContent === 'Selection (2)');
        expect(selectionTab?.disabled).toBe(false);
        selectionTab?.click();
        await nextTick();
        expect(harness.host.textContent).toContain('— Mixed');

        const layout = harness.host.querySelector<HTMLSelectElement>('[aria-label="Page layout override"]')!;
        layout.value = 'keep-right';
        layout.dispatchEvent(new Event('change', {bubbles: true}));
        await nextTick();
        expect(getScanCleanupPageOverride(pageOverrides, 1).layoutOverride).toBe('keep-right');
        expect(getScanCleanupPageOverride(pageOverrides, 2).layoutOverride).toBe('keep-right');
        expect({
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        }).toEqual(documentDefaults);
        expect(harness.host.textContent).not.toContain('— Mixed');

        Array.from(harness.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
            .find(item => item.textContent === 'Every other page')
            ?.click();
        expect(applyLeaderOverrides).toHaveBeenCalledWith('every-other');
        const resetOverridesButton = Array.from(harness.host.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Reset overrides…');
        expect(resetOverridesButton).not.toBeUndefined();
        expect(resetOverridesButton?.closest('.scan-thumbnail-rail-header')).toBeNull();
        harness.host.querySelector<HTMLButtonElement>('.scan-cleanup-reset-confirmation button:last-child')?.click();
        expect(resetPageOverrides).toHaveBeenCalledOnce();
    });

    it('shows a friendly retry state with raw details collapsed', () => {
        const rawError = 'Error: An object could not be cloned.';
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            loading: false,
            error: rawError,
            viewMode: 'cleaned',
            zoomMode: 'fit',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplitX: null,
            readingOrder: 'ltr',
        })}));

        const errorState = harness.host.querySelector('.preview-message.is-error');
        expect(errorState?.textContent).toContain('Preview isn\'t available. You can still run cleanup.');
        expect(errorState?.querySelector('button')?.textContent).toContain('Retry');
        const details = errorState?.querySelector('details');
        expect(details?.hasAttribute('open')).toBe(false);
        expect(details?.querySelector('.preview-error-detail')?.textContent).toBe(rawError);
        expect(Array.from(errorState?.children ?? [])
            .filter(child => child.tagName !== 'DETAILS')
            .some(child => child.textContent?.includes(rawError))).toBe(false);
    });

    it('shows dismissible first-run guidance inline over the reserved preview surface', () => {
        const dismiss = vi.fn();
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: null,
            loading: true,
            error: '',
            viewMode: 'cleaned',
            zoomMode: 'fit',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplitX: null,
            readingOrder: 'ltr',
            showFirstRunGuidance: true,
            onDismissFirstRunGuidance: dismiss,
        })}));

        const guidance = harness.host.querySelector('.scan-cleanup-first-run-guidance');
        expect(guidance?.closest('.preview-surface')).not.toBeNull();
        expect(guidance?.textContent).toContain('Pages are detected automatically.');
        expect(guidance?.textContent).toContain('Review pages');
        expect(guidance?.textContent).toContain('the original is untouched');
        guidance?.querySelector<HTMLButtonElement>('button')?.click();
        expect(dismiss).toHaveBeenCalledOnce();
    });

    it('dims stale content and centers the requested page loading state while navigating', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(1),
            loading: true,
            error: '',
            viewMode: 'cleaned',
            zoomMode: 'fit',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            stalePage: true,
            manualSplitX: null,
            readingOrder: 'ltr',
        })}));

        expect(harness.host.querySelector('.preview-surface')?.classList.contains('is-stale-page')).toBe(true);
        expect(harness.host.querySelector('.cutter-stage')?.classList.contains('is-stale-content')).toBe(true);
        expect(harness.host.querySelector('.page-loading-overlay')?.textContent).toContain('Loading page 2…');
        expect(harness.host.querySelector('.refresh-indicator')).toBeNull();
    });

    it('removes visual half labels while preserving each output half in image alternatives', () => {
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(2),
            loading: false,
            error: '',
            viewMode: 'cleaned',
            zoomMode: 'fit',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 2,
            totalPages: 3,
            manualSplitX: null,
            readingOrder: 'ltr',
        })}));
        const images = Array.from(harness.host.querySelectorAll<HTMLImageElement>('.cleaned-image'));

        expect(harness.host.querySelector('.half-label')).toBeNull();
        expect(images.map(image => image.alt)).toEqual([
            'Cleaned scan preview for page 2, left half',
            'Cleaned scan preview for page 2, right half',
        ]);
    });

    it('shows the original page with crop overlays and a single Preview state in lossless mode', async () => {
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            right: 1000,
            top: 0,
            bottom: 800,
            width: 1000,
            height: 800,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        try {
            const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
                result: spreadPreviewResult(2),
                loading: false,
                error: '',
                viewMode: 'cleaned',
                zoomMode: 'fit',
                matchPageSize: true,
                alignment: 'top-center',
                pageNumber: 2,
                totalPages: 3,
                manualSplitX: null,
                readingOrder: 'ltr',
                lossless: true,
            })}));
            await nextTick();

            const comparison = harness.host.querySelectorAll<HTMLElement>('[role="radiogroup"]')[0]!;
            expect(Array.from(comparison.querySelectorAll('[role="radio"]')).map(option => option.textContent)).toEqual(['Preview']);
            expect(harness.host.querySelector('.raw-preview')).not.toBeNull();
            expect(harness.host.querySelector('.cleaned-outputs')).toBeNull();
            expect(harness.host.querySelectorAll('.lossless-crop-overlay')).toHaveLength(2);
        } finally {
            rect.mockRestore();
        }
    });

    it('keeps the spread cutter mounted through click and the debounced loading cycle', async () => {
        const zoomMode = ref<'fit' | 'actual'>('actual');
        const loading = ref(false);
        const manualSplitX = ref<number | null>(null);
        const result = shallowRef(spreadPreviewResult());
        const splitUpdates: Array<number | null> = [];
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: result.value,
            loading: loading.value,
            error: '',
            viewMode: 'cleaned',
            zoomMode: zoomMode.value,
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            stalePage: false,
            manualSplitX: manualSplitX.value,
            readingOrder: 'ltr',
            'onUpdate:zoomMode': (value: 'fit' | 'actual') => { zoomMode.value = value; },
            'onUpdate:manualSplitX': (value: number | null) => {
                splitUpdates.push(value);
                manualSplitX.value = value;
                loading.value = true;
            },
        })}));

        expect(harness.host.querySelector('.cutter-control')).toBeNull();
        zoomMode.value = 'fit';
        await nextTick();
        const cutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control');
        expect(cutter).not.toBeNull();
        expect(cutter?.querySelector('.cutter-grab-handle')).not.toBeNull();

        const stage = harness.host.querySelector<HTMLElement>('.cutter-stage');
        vi.spyOn(stage!, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            right: 1000,
            top: 0,
            bottom: 800,
            width: 1000,
            height: 800,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        cutter!.setPointerCapture = vi.fn();
        cutter!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 600,
            pointerId: 1,
        }));
        expect(splitUpdates.at(-1)).toBeCloseTo(600, 8);
        await nextTick();
        expect(harness.host.querySelector('.cutter-control')).not.toBeNull();
        expect(harness.host.querySelector('.cutter-control')?.classList.contains('is-refreshing')).toBe(true);

        result.value = {
            ...result.value,
            pageMetadata: {
                ...result.value.pageMetadata,
                layoutClassification: 'single-uncut-page',
            },
        };
        loading.value = false;
        await nextTick();
        const persistentCutter = harness.host.querySelector<HTMLButtonElement>('.cutter-control');
        expect(persistentCutter).not.toBeNull();

        persistentCutter!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 550,
            pointerId: 2,
        }));
        persistentCutter!.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Escape',
        }));
        const updateCountAfterEscape = splitUpdates.length;
        persistentCutter!.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: 700,
            pointerId: 2,
        }));
        expect(splitUpdates).toHaveLength(updateCountAfterEscape);

        persistentCutter!.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
        expect(splitUpdates.at(-1)).toBeNull();
    });

    it('supports keyboard content-box resizing/reset and per-output placement nudging', async () => {
        const contentUpdates: Array<{
            half: string;
            value: unknown
        }> = [];
        const placementUpdates: Array<{
            half: string;
            value: string
        }> = [];
        const harness = mount(defineComponent({setup: () => () => h(ScanCleanupPreviewPane, {
            result: spreadPreviewResult(),
            loading: false,
            error: '',
            viewMode: 'cleaned',
            zoomMode: 'fit',
            matchPageSize: true,
            alignment: 'top-center',
            pageNumber: 1,
            totalPages: 3,
            manualSplitX: null,
            readingOrder: 'ltr',
            manualContentBoxes: {left: {
                x: 50,
                y: 60,
                width: 300,
                height: 500,
            }},
            placementOverrides: {left: 'top-center'},
            'onUpdate:manualContentBox': (
                half: TScanCleanupOutputHalf,
                value: IScanCleanupPreviewRect | null,
            ) => contentUpdates.push({
                half,
                value,
            }),
            'onUpdate:placement': (
                half: TScanCleanupOutputHalf,
                value: TScanCleanupPageAlignment,
            ) => placementUpdates.push({
                half,
                value,
            }),
        })}));

        harness.host.querySelector<HTMLButtonElement>('.content-handle.is-e')?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true,
        }));
        expect(contentUpdates.at(-1)).toMatchObject({
            half: 'left',
            value: {
                x: 50,
                y: 60,
                height: 500,
            },
        });
        expect((contentUpdates.at(-1)?.value as {width: number}).width).toBeGreaterThan(300);

        harness.host.querySelector<HTMLElement>('.content-overlay')?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
        expect(contentUpdates.at(-1)).toEqual({
            half: 'left',
            value: null,
        });

        harness.host.querySelector<HTMLElement>('.placed-image')?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));
        expect(placementUpdates.at(-1)).toEqual({
            half: 'left',
            value: 'center',
        });
    });
});
