import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    ISettingsData,
    TFitMode,
    TZoomMode,
} from '@contracts/shared';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';

function createDefaultsSetup(settings: Partial<ISettingsData> = {}) {
    const scope = effectScope();
    const appSettings = ref<ISettingsData>(sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...settings,
    }));
    const annotationSettings = ref({
        ...DEFAULT_ANNOTATION_SETTINGS,
        highlightColor: '#111111',
        underlineColor: '#222222',
        strikethroughColor: '#333333',
        squigglyColor: '#444444',
        inkColor: '#555555',
        shapeColor: '#666666',
    });
    const viewMode = ref<ISettingsData['defaultViewMode']>('facing');
    const continuousScroll = ref(false);
    const fitMode = ref<TFitMode>('height');
    const zoom = ref(2);
    const effectiveZoom = ref(2);
    const zoomMode = ref<TZoomMode>('custom');
    const pdfSrc = ref<TPdfSource | null>(null);
    const documentSourceKey = ref<unknown>(null);

    const defaults = scope.run(() => useWorkspaceViewerDefaults({
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        documentSourceKey,
    }));

    if (!defaults) {
        throw new Error('Failed to create workspace viewer defaults');
    }

    return {
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        documentSourceKey,
        defaults,
        stop: () => scope.stop(),
    };
}

async function openPdf(pdfSrc: Ref<TPdfSource | null>) {
    pdfSrc.value = new Blob([], { type: 'application/pdf' });
    await nextTick();
}

describe('useWorkspaceViewerDefaults', () => {
    it('applies fit-width as the sanitized default zoom preset', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: 'fit-width',
            defaultAnnotationColor: '#123456',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
        });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.fitMode.value).toBe('width');
            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-width');
            expect(setup.viewMode.value).toBe('single');
            expect(setup.continuousScroll.value).toBe(true);
            expect(setup.annotationSettings.value).toMatchObject({
                highlightColor: '#123456',
                underlineColor: '#123456',
                strikethroughColor: '#123456',
                squigglyColor: '#123456',
                inkColor: '#123456',
                shapeColor: '#123456',
            });
        } finally {
            setup.stop();
        }
    });

    it('applies fit-height as the default zoom preset', async () => {
        const setup = createDefaultsSetup({ defaultZoomPreset: 'fit-height' });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.fitMode.value).toBe('height');
            expect(setup.zoom.value).toBe(1);
            expect(setup.effectiveZoom.value).toBe(1);
            expect(setup.zoomMode.value).toBe('fit-height');
        } finally {
            setup.stop();
        }
    });

    it.each([
        [
            '100',
            1,
        ],
        [
            '125',
            1.25,
        ],
        [
            '150',
            1.5,
        ],
    ] as const)('applies numeric default zoom preset %s as custom zoom', async (preset, expectedZoom) => {
        const setup = createDefaultsSetup({ defaultZoomPreset: preset });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.zoom.value).toBe(expectedZoom);
            expect(setup.effectiveZoom.value).toBe(expectedZoom);
            expect(setup.zoomMode.value).toBe('custom');
        } finally {
            setup.stop();
        }
    });

    it('applies fit-width when settings sanitization rejects the stored preset', async () => {
        const setup = createDefaultsSetup({ defaultZoomPreset: 'unsupported' as ISettingsData['defaultZoomPreset'] });

        try {
            await openPdf(setup.pdfSrc);

            expect(setup.appSettings.value.defaultZoomPreset).toBe(DEFAULT_SETTINGS.defaultZoomPreset);
            expect(setup.fitMode.value).toBe('width');
            expect(setup.zoomMode.value).toBe('fit-width');
        } finally {
            setup.stop();
        }
    });

    it('applies viewer defaults when a non-PDF document source opens', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: '125',
            defaultViewMode: 'facing',
            defaultContinuousScroll: true,
        });

        try {
            setup.documentSourceKey.value = 'djvu:/docs/scan.djvu';
            await nextTick();

            expect(setup.viewMode.value).toBe('facing');
            expect(setup.continuousScroll.value).toBe(true);
            expect(setup.zoom.value).toBe(1.25);
            expect(setup.effectiveZoom.value).toBe(1.25);
            expect(setup.zoomMode.value).toBe('custom');
        } finally {
            setup.stop();
        }
    });

    it('restores configured defaults when a document source closes', async () => {
        const setup = createDefaultsSetup({
            defaultZoomPreset: '125',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
        });

        try {
            await openPdf(setup.pdfSrc);
            setup.zoom.value = 1.44;
            setup.effectiveZoom.value = 1.44;
            setup.zoomMode.value = 'fit-height';
            setup.viewMode.value = 'facing';
            setup.continuousScroll.value = false;

            setup.pdfSrc.value = null;
            await nextTick();

            expect(setup.zoom.value).toBe(1.25);
            expect(setup.effectiveZoom.value).toBe(1.25);
            expect(setup.zoomMode.value).toBe('custom');
            expect(setup.viewMode.value).toBe('single');
            expect(setup.continuousScroll.value).toBe(true);
        } finally {
            setup.stop();
        }
    });
});
