export type TPdfSaveMode = 'incremental' | 'rewrite' | 'save_as_rewrite';

export type TPdfaPart = '1' | '2' | '3' | '4';
export type TPdfaConformance = 'A' | 'B' | 'E' | 'F' | 'U';
export type TPdfaLevel = `PDF/A-${TPdfaPart}${TPdfaConformance}` | (string & {});

export interface IPdfConformanceProfile {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    pdfaLevel: TPdfaLevel | null;
    hasAcroForm: boolean;
    hasXfa: boolean;
    canIncrementalSave: boolean;
    saveRestrictions: string[];
}

export type TPdfConformanceProfileBase = Omit<IPdfConformanceProfile, 'saveRestrictions'>;

export interface IPdfValidationResult {
    isValid: boolean;
    tool: 'qpdf' | 'browser' | 'native';
    errors: string[];
    warnings: string[];
}
