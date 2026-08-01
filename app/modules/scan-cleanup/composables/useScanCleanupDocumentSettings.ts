import type {
    IScanCleanupOptions,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import type {ComputedRef} from 'vue';
import {tryOnScopeDispose} from '@vueuse/core';
import {
    getScanCleanupPageOverride,
    setScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {
    DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE,
    loadScanCleanupDocumentMargins,
    loadScanCleanupDocumentOutputMode,
    loadScanCleanupDocumentOverrides,
    saveScanCleanupDocumentPreferences,
    saveScanCleanupDocumentOutputMode,
    SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS,
    type IScanCleanupDocumentPreferencePatch,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {
    flushScanCleanupPreferencesStore,
    getScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import {
    resolveScanCleanupMarginPatch,
    scanCleanupMarginsUniform,
    type TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

interface IUseScanCleanupDocumentSettingsOptions {
    documentLifecycleKey: ComputedRef<string | null>;
    preferenceDocumentKey: ComputedRef<string | null>;
}

const alignmentIcons: Array<{
    value: TScanCleanupPageAlignment;
    icon: string;
}> = [
    {
        value: 'top-left',
        icon: 'i-ph-arrow-up-left',
    },
    {
        value: 'top-center',
        icon: 'i-ph-arrow-up',
    },
    {
        value: 'top-right',
        icon: 'i-ph-arrow-up-right',
    },
    {
        value: 'center-left',
        icon: 'i-ph-arrow-left',
    },
    {
        value: 'center',
        icon: 'i-ph-dot-outline',
    },
    {
        value: 'center-right',
        icon: 'i-ph-arrow-right',
    },
    {
        value: 'bottom-left',
        icon: 'i-ph-arrow-down-left',
    },
    {
        value: 'bottom-center',
        icon: 'i-ph-arrow-down',
    },
    {
        value: 'bottom-right',
        icon: 'i-ph-arrow-down-right',
    },
];

export const useScanCleanupDocumentSettings = (options: IUseScanCleanupDocumentSettingsOptions) => {
    const {t} = useTypedI18n();
    const preferences = getScanCleanupPreferencesStore();
    interface IPendingDocumentPersistence extends IScanCleanupDocumentPreferencePatch {documentKey: string;}
    let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingPersistence: IPendingDocumentPersistence | null = null;

    function flushDocumentPersistence() {
        if (persistenceTimer !== null) {
            clearTimeout(persistenceTimer);
            persistenceTimer = null;
        }
        const pending = pendingPersistence;
        pendingPersistence = null;
        if (!pending) {
            return;
        }
        const {
            documentKey,
            ...patch
        } = pending;
        saveScanCleanupDocumentPreferences(documentKey, patch);
    }

    function scheduleDocumentPersistence(
        documentKey: string | null | undefined,
        patch: IScanCleanupDocumentPreferencePatch,
    ) {
        if (!documentKey) {
            flushDocumentPersistence();
            return;
        }
        if (pendingPersistence?.documentKey !== documentKey) {
            flushDocumentPersistence();
        }
        pendingPersistence ??= {documentKey};
        if (patch.overrides !== undefined) pendingPersistence.overrides = patch.overrides;
        if (patch.marginsMm !== undefined) pendingPersistence.marginsMm = patch.marginsMm;
        if (patch.outputMode !== undefined) pendingPersistence.outputMode = patch.outputMode;
        if (patch.resetOverrides === true) pendingPersistence.resetOverrides = true;
        if (persistenceTimer !== null) clearTimeout(persistenceTimer);
        persistenceTimer = setTimeout(flushDocumentPersistence, SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS);
    }

    function flushPersistence() {
        flushDocumentPersistence();
        flushScanCleanupPreferencesStore();
    }

    const handleWindowLifecycle = () => flushPersistence();
    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', handleWindowLifecycle);
        window.addEventListener('pagehide', handleWindowLifecycle);
    }
    tryOnScopeDispose(() => {
        flushPersistence();
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', handleWindowLifecycle);
            window.removeEventListener('pagehide', handleWindowLifecycle);
        }
    });
    const firstRunGuidanceDismissed = toRef(preferences, 'firstRunGuidanceDismissed');
    const marginsLinked = ref(true);
    const values: IScanCleanupOptions = reactive({
        preserveOriginalQuality: toRef(preferences, 'preserveOriginalQuality'),
        layoutMode: toRef(preferences, 'layoutMode'),
        outputMode: DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE,
        binarization: toRef(preferences, 'binarization'),
        normalizeIllumination: toRef(preferences, 'normalizeIllumination'),
        readingOrder: toRef(preferences, 'readingOrder'),
        thickness: toRef(preferences, 'thickness'),
        crop: toRef(preferences, 'crop'),
        matchPageSize: toRef(preferences, 'matchPageSize'),
        pageAlignment: toRef(preferences, 'pageAlignment'),
        marginsMm: {...preferences.marginsMm},
        despeckleLevel: toRef(preferences, 'despeckleLevel'),
        autoDewarp: toRef(preferences, 'autoDewarp'),
        autoDewarpDepth: toRef(preferences, 'autoDewarpDepth'),
        skipBlankPages: toRef(preferences, 'skipBlankPages'),
        pageOverrides: {},
    });
    const layoutItems = computed(() => [
        {
            value: 'auto' as const,
            label: t('scanCleanup.layout.auto'),
        },
        {
            value: 'force-single' as const,
            label: t('scanCleanup.layout.single'),
        },
        {
            value: 'force-two-page' as const,
            label: t('scanCleanup.layout.twoPage'),
        },
    ]);
    const readingOrderItems = computed(() => [
        {
            value: 'ltr' as const,
            label: t('scanCleanup.layout.leftToRight'),
        },
        {
            value: 'rtl' as const,
            label: t('scanCleanup.layout.rightToLeft'),
        },
    ]);
    const outputItems = computed(() => [
        {
            value: 'auto' as const,
            label: t('scanCleanup.output.autoShort'),
            fullLabel: t('scanCleanup.output.autoDescription'),
        },
        {
            value: 'bw' as const,
            label: t('scanCleanup.output.bwShort'),
            fullLabel: t('scanCleanup.output.bw'),
        },
        {
            value: 'grayscale' as const,
            label: t('scanCleanup.output.grayscaleShort'),
            fullLabel: t('scanCleanup.output.grayscale'),
        },
        {
            value: 'color' as const,
            label: t('scanCleanup.output.colorShort'),
            fullLabel: t('scanCleanup.output.color'),
        },
    ]);
    const alignmentItems = computed(() => alignmentIcons.map(item => ({
        ...item,
        label: t(`scanCleanup.pageSize.${({
            'top-left': 'topLeft',
            'top-center': 'topCenter',
            'top-right': 'topRight',
            'center-left': 'centerLeft',
            'center': 'center',
            'center-right': 'centerRight',
            'bottom-left': 'bottomLeft',
            'bottom-center': 'bottomCenter',
            'bottom-right': 'bottomRight',
        } as const)[item.value]}`),
    })));
    const thicknessLabel = computed(() => values.thickness > 0 ? `+${values.thickness}` : String(values.thickness));
    const showFirstRunGuidance = computed(() => !firstRunGuidanceDismissed.value);

    function dismissFirstRunGuidance() {
        firstRunGuidanceDismissed.value = true;
    }

    function handleThicknessInput(value: number | number[]) {
        values.thickness = Array.isArray(value) ? (value[0] ?? 0) : value;
    }

    function updateMargin(target: TScanCleanupMarginTarget, value: number) {
        Object.assign(values.marginsMm, resolveScanCleanupMarginPatch(
            marginsLinked.value ? 'all' : target,
            value,
        ));
        for (const pageNumber of Object.keys(values.pageOverrides).map(Number)) {
            setScanCleanupPageOverride(
                values.pageOverrides,
                pageNumber,
                getScanCleanupPageOverride(values.pageOverrides, pageNumber),
                values.marginsMm,
            );
        }
    }

    function setMarginsLinked(linked: boolean) {
        marginsLinked.value = linked;
        if (linked && !scanCleanupMarginsUniform(values.marginsMm)) {
            updateMargin('all', values.marginsMm.topMm);
        }
    }

    function resetPageOverrides() {
        values.pageOverrides = {};
        scheduleDocumentPersistence(options.preferenceDocumentKey.value, {
            overrides: values.pageOverrides,
            resetOverrides: true,
        });
    }

    watch(options.documentLifecycleKey, () => {
        flushPersistence();
        values.pageOverrides = loadScanCleanupDocumentOverrides(options.preferenceDocumentKey.value);
        const persistedOutputMode = loadScanCleanupDocumentOutputMode(options.preferenceDocumentKey.value);
        values.outputMode = persistedOutputMode === 'mixed'
            ? DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE
            : persistedOutputMode;
        if (persistedOutputMode === 'mixed') {
            saveScanCleanupDocumentOutputMode(
                options.preferenceDocumentKey.value,
                DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE,
            );
        }
        Object.assign(values.marginsMm, loadScanCleanupDocumentMargins(options.preferenceDocumentKey.value)
            ?? preferences.marginsMm);
        marginsLinked.value = scanCleanupMarginsUniform(values.marginsMm);
    }, {immediate: true});
    watch(() => values.pageOverrides, overrides => {
        scheduleDocumentPersistence(options.preferenceDocumentKey.value, {overrides});
    }, {deep: true});
    watch(() => values.marginsMm, marginsMm => {
        Object.assign(preferences.marginsMm, marginsMm);
        scheduleDocumentPersistence(options.preferenceDocumentKey.value, {marginsMm});
    }, {deep: true});
    watch(() => values.outputMode, outputMode => {
        scheduleDocumentPersistence(options.preferenceDocumentKey.value, {outputMode});
    });

    return {
        alignmentItems,
        dismissFirstRunGuidance,
        handleThicknessInput,
        layoutItems,
        marginsLinked,
        outputItems,
        readingOrderItems,
        resetPageOverrides,
        setMarginsLinked,
        showFirstRunGuidance,
        thicknessLabel,
        updateMargin,
        values,
    };
};
