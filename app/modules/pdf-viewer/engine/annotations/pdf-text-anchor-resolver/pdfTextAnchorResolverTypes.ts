

export interface IPageTextRangeMatchOptions {
    text: string;
    occurrence?: number | undefined;
    caseSensitive?: boolean | undefined;
    wholeWord?: boolean | undefined;
}

export interface IPageTextRangeMatch {
    range: Range;
    matchedText: string;
    occurrence: number;
    startOffset: number;
    endOffset: number;
}
