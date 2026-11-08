// .yt 语言的轻量语法高亮（CodeMirror StreamLanguage）
import { StreamLanguage } from '@codemirror/language';

// 常用内置函数 / 常量，仅用于着色，不影响解释器
const FUNCTIONS = new Set([
  'plot', 'seek', 'jf', 'readtu', 'savetu',
  'H', 'N', 'R', 'GS', 'T',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'log', 'ln', 'sqrt', 'abs', 'floor', 'ceil', 'round',
  'min', 'max', 'sum', 'mean',
]);

const CONSTANTS = new Set(['pi', 'e', 'i', 'j', 'ans']);

export const ytLanguage = StreamLanguage.define({
  name: 'yt',
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }

    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';

    if (stream.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number';

    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current();
      if (CONSTANTS.has(word)) return 'atom';
      if (FUNCTIONS.has(word)) return 'keyword';
      return 'variableName';
    }

    if (stream.match(/^(?:\*\*|->|[-+*/^=<>'~])/)) return 'operator';
    if (stream.match(/^[()[\]{},;:]/)) return 'punctuation';

    stream.next();
    return null;
  },
});
