const WORD_PATTERN = /[\p{L}\p{N}]+(?:[-./][\p{L}\p{N}]+)*/gu;

export function normalizeOcrText(value) {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('und')
        .replace(/[\u2010-\u2015\u2212]/gu, '-')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function tokenizeOcrWords(value) {
    return normalizeOcrText(value).match(WORD_PATTERN) ?? [];
}

export function editDistance(expected, actual) {
    if (expected.length > actual.length) {
        return editDistance(actual, expected);
    }
    let previous = Array.from({length: expected.length + 1}, (_, index) => index);
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
        const current = [actualIndex + 1];
        for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
            current.push(Math.min(
                current[expectedIndex] + 1,
                previous[expectedIndex + 1] + 1,
                previous[expectedIndex] + (expected[expectedIndex] === actual[actualIndex] ? 0 : 1),
            ));
        }
        previous = current;
    }
    return previous[expected.length];
}

export function measureOcrQuality(expected, actual) {
    const normalizedExpected = normalizeOcrText(expected);
    const normalizedActual = normalizeOcrText(actual);
    const expectedCharacters = Array.from(normalizedExpected);
    const actualCharacters = Array.from(normalizedActual);
    const expectedWords = tokenizeOcrWords(normalizedExpected);
    const actualWords = tokenizeOcrWords(normalizedActual);
    return {
        cer: editDistance(expectedCharacters, actualCharacters)
            / Math.max(1, expectedCharacters.length),
        wer: editDistance(expectedWords, actualWords)
            / Math.max(1, expectedWords.length),
        normalizedActual,
    };
}

export function retainsCriticalToken(actual, token) {
    const expectedTokens = tokenizeOcrWords(token);
    if (expectedTokens.length !== 1) {
        return false;
    }
    return tokenizeOcrWords(actual).includes(expectedTokens[0]);
}
