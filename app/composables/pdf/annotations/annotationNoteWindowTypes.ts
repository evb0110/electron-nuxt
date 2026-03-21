import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface IAnnotationNotePosition {
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export interface IAnnotationNoteWindowState {
    comment: IAnnotationCommentSummary;
    text: string;
    lastSavedText: string;
    saving: boolean;
    error: string | null;
    order: number;
    saveMode: 'auto' | 'embedded';
    isMinimized: boolean;
}
