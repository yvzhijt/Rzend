// .yt 自研数学语言解释器
//
// 模块划分：
//   value  值类型、表达式 AST、输出结构与显示格式化
//   lexer  词法分析（Token / 分词 / 注释剥除）
//   parser 语法分析（递归下降）
//   eval   环境、表达式求值、内置函数、求根/积分/绘图采样
//   math   线性代数与数值计算（faer 封装、图像读写）
pub(crate) mod value;
pub(crate) mod lexer;
pub(crate) mod parser;
pub(crate) mod eval;
pub mod math;

pub use value::{BinOp, Expr, EvalOutput, EvalResult, PlotData, Value};
pub use eval::Env;
