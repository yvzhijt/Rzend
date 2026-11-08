// C / C++ 代码补全提示：关键字、类型、标准库函数与常用代码片段
// 说明：CodeMirror 自带的 lang-cpp 只提供语法高亮和缩进，
// 这里额外挂载一个补全源，让编辑器在输入时给出类似 IDE 的提示。
import { completeFromList, snippetCompletion } from '@codemirror/autocomplete';

const KEYWORDS = [
  'auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else',
  'enum', 'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict',
  'return', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'volatile', 'while', 'bool', 'true', 'false',
];

const TYPES = [
  'char', 'double', 'float', 'int', 'long', 'short', 'signed', 'unsigned',
  'void', 'size_t', 'ssize_t', 'ptrdiff_t', 'int8_t', 'int16_t', 'int32_t',
  'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'FILE', 'va_list',
];

const CONSTANTS = ['NULL', 'EOF', 'stdin', 'stdout', 'stderr', 'BUFSIZ', 'EXIT_SUCCESS', 'EXIT_FAILURE'];

// [函数名, 所属头文件]
const FUNCTIONS = [
  // stdio.h
  ['sprintf', 'stdio.h'],
  ['snprintf', 'stdio.h'], ['puts', 'stdio.h'], ['fputs', 'stdio.h'],
  ['putchar', 'stdio.h'], ['getchar', 'stdio.h'], ['fgets', 'stdio.h'],
  ['fopen', 'stdio.h'], ['fclose', 'stdio.h'], ['fread', 'stdio.h'],
  ['fwrite', 'stdio.h'], ['fseek', 'stdio.h'], ['ftell', 'stdio.h'],
  ['rewind', 'stdio.h'], ['fflush', 'stdio.h'], ['perror', 'stdio.h'],
  ['remove', 'stdio.h'], ['rename', 'stdio.h'],
  // stdlib.h
  ['malloc', 'stdlib.h'], ['calloc', 'stdlib.h'], ['realloc', 'stdlib.h'],
  ['free', 'stdlib.h'], ['exit', 'stdlib.h'], ['abort', 'stdlib.h'],
  ['atoi', 'stdlib.h'], ['atof', 'stdlib.h'], ['strtol', 'stdlib.h'],
  ['strtod', 'stdlib.h'], ['rand', 'stdlib.h'], ['srand', 'stdlib.h'],
  ['qsort', 'stdlib.h'], ['bsearch', 'stdlib.h'],
  // string.h
  ['strlen', 'string.h'], ['strcpy', 'string.h'], ['strncpy', 'string.h'],
  ['strcat', 'string.h'], ['strncat', 'string.h'], ['strcmp', 'string.h'],
  ['strncmp', 'string.h'], ['strchr', 'string.h'], ['strrchr', 'string.h'],
  ['strstr', 'string.h'], ['memcpy', 'string.h'], ['memmove', 'string.h'],
  ['memset', 'string.h'], ['memcmp', 'string.h'],
  // math.h
  ['sqrt', 'math.h'], ['pow', 'math.h'], ['fabs', 'math.h'],
  ['floor', 'math.h'], ['ceil', 'math.h'], ['fmod', 'math.h'],
  ['sin', 'math.h'], ['cos', 'math.h'], ['tan', 'math.h'],
  ['asin', 'math.h'], ['acos', 'math.h'], ['atan', 'math.h'], ['atan2', 'math.h'],
  ['exp', 'math.h'], ['log', 'math.h'], ['log10', 'math.h'],
  // time.h
  ['time', 'time.h'], ['clock', 'time.h'],
  // C++
  ['std::cout', 'iostream'], ['std::cin', 'iostream'], ['std::cerr', 'iostream'],
  ['std::endl', 'iostream'], ['std::string', 'string'], ['std::vector', 'vector'],
  ['std::map', 'map'], ['std::sort', 'algorithm'], ['std::max', 'algorithm'],
  ['std::min', 'algorithm'], ['std::swap', 'utility'],
];

function buildSnippets() {
  return [
    snippetCompletion('int main(void) {\n\t${}\n\treturn 0;\n}', {
      label: 'main', type: 'function', detail: '主函数',
    }),
    snippetCompletion('for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}', {
      label: 'for', type: 'keyword', detail: 'for 循环',
    }),
    snippetCompletion('while (${cond}) {\n\t${}\n}', {
      label: 'while', type: 'keyword', detail: 'while 循环',
    }),
    snippetCompletion('do {\n\t${}\n} while (${cond});', {
      label: 'do', type: 'keyword', detail: 'do-while 循环',
    }),
    snippetCompletion('if (${cond}) {\n\t${}\n}', {
      label: 'if', type: 'keyword', detail: 'if 判断',
    }),
    snippetCompletion('if (${cond}) {\n\t${}\n} else {\n\t${}\n}', {
      label: 'if-else', type: 'keyword', detail: 'if-else 分支',
    }),
    snippetCompletion('switch (${expr}) {\n\tcase ${value}:\n\t\t${}\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', {
      label: 'switch', type: 'keyword', detail: 'switch 分支',
    }),
    snippetCompletion('struct ${Name} {\n\t${}\n};', {
      label: 'struct', type: 'keyword', detail: '结构体定义',
    }),
    snippetCompletion('printf("${text}\\n");', {
      label: 'printf', type: 'function', detail: 'stdio.h',
    }),
    snippetCompletion('scanf("${format}", &${var});', {
      label: 'scanf', type: 'function', detail: 'stdio.h',
    }),
  ];
}

const cCompletionSource = completeFromList([
  ...buildSnippets(),
  ...KEYWORDS.map((label) => ({ label, type: 'keyword' })),
  ...TYPES.map((label) => ({ label, type: 'type' })),
  ...CONSTANTS.map((label) => ({ label, type: 'constant' })),
  ...FUNCTIONS.map(([label, detail]) => ({ label, type: 'function', detail })),
]);

export { cCompletionSource };
