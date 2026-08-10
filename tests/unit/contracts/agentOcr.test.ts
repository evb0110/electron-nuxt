import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AGENT_OCR_RUN_INPUT_SCHEMA,
    parseAgentOcrRunOptions,
} from '@contracts/agentOcr';

describe('agent OCR contract', () => {
    it('keeps the advertised fields and canonical enum values in one schema', () => {
        expect(Object.keys(AGENT_OCR_RUN_INPUT_SCHEMA.properties)).toEqual([
            'pageRange',
            'customRange',
            'languages',
            'qualityProfile',
            'preprocessingMode',
            'pageSegmentationMode',
            'supersessionPolicy',
            'replaceAllAcknowledged',
            'open',
        ]);
        expect(AGENT_OCR_RUN_INPUT_SCHEMA.properties.supersessionPolicy.enum).toEqual([
            'missing-only',
            'replace-evb',
            'replace-all',
        ]);
        expect(AGENT_OCR_RUN_INPUT_SCHEMA.additionalProperties).toBe(false);
    });

    it('normalizes every supported option at the untrusted action boundary', () => {
        expect(parseAgentOcrRunOptions({
            pageRange: 'custom',
            customRange: ' 1-3, 7 ',
            languages: [
                ' eng ',
                'rus',
                'eng',
                null,
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
            open: false,
        })).toEqual({
            pageRange: 'custom',
            customRange: '1-3, 7',
            languages: [
                'eng',
                'rus',
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
            open: false,
        });
    });

    it('drops invalid and legacy-only representations', () => {
        expect(parseAgentOcrRunOptions({
            pageRange: 'selection',
            customRange: '   ',
            selectedLanguages: ['deu'],
            qualityProfile: 'stock',
            preprocessingMode: 'maybe',
            pageSegmentationMode: 14,
            supersessionPolicy: 'replace-native',
            replaceAllAcknowledged: 'yes',
            open: 'yes',
        })).toEqual({});
        expect(parseAgentOcrRunOptions(null)).toEqual({});
    });
});
