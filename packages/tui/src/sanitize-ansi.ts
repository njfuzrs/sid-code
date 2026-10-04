import {hasAnsiControlCharacters, tokenizeAnsi} from './ansi-tokenizer.js';

// sid-code（B9 / T3.1）：去掉冒号。带冒号子参数的 SGR（`ESC[4:3m` 波浪下划线、`ESC[38:2::r:g:bm`）
// ansi-tokenize 不认识，会把 `[4:3m` 当成可见字符落格；旧底座整条丢弃，与之对齐
const sgrParametersRegex = /^[\d;]*$/;

// Strip ANSI escape sequences that would conflict with Ink's layout.
// Preserved: SGR sequences (colors, bold, etc. - end with 'm') and
// OSC sequences (hyperlinks, etc. - ESC ] or C1 OSC).
// Stripped: cursor movement, screen clearing, and other control sequences.
const sanitizeAnsi = (text: string): string => {
	if (!hasAnsiControlCharacters(text)) {
		return text;
	}

	let output = '';

	for (const token of tokenizeAnsi(text)) {
		if (token.type === 'text' || token.type === 'osc') {
			output += token.value;
			continue;
		}

		if (
			token.type === 'csi' &&
			token.finalCharacter === 'm' &&
			token.intermediateString === '' &&
			sgrParametersRegex.test(token.parameterString)
		) {
			output += token.value;
		}
	}

	return output;
};

export default sanitizeAnsi;
