// .yt 语言的值类型、表达式 AST 与输出结构，以及值的显示格式化
use serde::Serialize;

use crate::WorkspaceVar;
use num_complex::Complex64;

// ---------------- 值与表达式 ----------------

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(f64),
    Complex(Complex64),
    Mat(Vec<Vec<f64>>),
    ComplexVec(Vec<Complex64>),
    Func(UserFunc),
    Eigen {
        values: Vec<Complex64>,
        vectors: Vec<Vec<Complex64>>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserFunc {
    pub param: String,
    pub body: Expr,
    pub src: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Text(String),
    Var(String),
    MatLit(Vec<Vec<Expr>>),
    Neg(Box<Expr>),
    Transpose(Box<Expr>),
    Bin(BinOp, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

// ---------------- 输出结构 ----------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Series {
    pub name: String,
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlotData {
    pub series: Vec<Series>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EvalOutput {
    pub text: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EvalResult {
    pub outputs: Vec<EvalOutput>,
    pub plot: Option<PlotData>,
    pub vars: Vec<WorkspaceVar>,
}

// ---------------- 显示格式化 ----------------

pub(crate) const MAX_INLINE_MATRIX_CELLS: usize = 256;

pub(crate) fn fmt_num(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    if v == v.trunc() && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    let s = format!("{:.10}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

pub(crate) fn fmt_value(v: &Value) -> String {
    match v {
        Value::Num(x) => format!("   {}", fmt_num(*x)),
        Value::Complex(x) => format!("   {}", fmt_complex(*x)),
        Value::ComplexVec(values) => fmt_complex_vec(values),
        Value::Mat(m) => fmt_mat(m),
        Value::Func(f) => format!("   函数({})", f.param),
        Value::Eigen { values, vectors } => format!(
            "   特征值：\n{}\n\n   特征向量（每列对应一个特征值）：\n{}",
            fmt_complex_mat(&[values.clone()]),
            fmt_complex_mat(vectors)
        ),
    }
}

pub(crate) fn fmt_complex(value: Complex64) -> String {
    let re = if value.re.abs() < 1e-12 {
        0.0
    } else {
        value.re
    };
    let im = if value.im.abs() < 1e-12 {
        0.0
    } else {
        value.im
    };
    match (re, im) {
        (re, 0.0) => fmt_num(re),
        (0.0, im) if im == 1.0 => "i".to_string(),
        (0.0, im) if im == -1.0 => "-i".to_string(),
        (0.0, im) => format!("{}i", fmt_num(im)),
        (re, im) if im == 1.0 => format!("{}+i", fmt_num(re)),
        (re, im) if im == -1.0 => format!("{}-i", fmt_num(re)),
        (re, im) if im > 0.0 => format!("{}+{}i", fmt_num(re), fmt_num(im)),
        (re, im) => format!("{}{}i", fmt_num(re), fmt_num(im)),
    }
}

pub(crate) fn fmt_complex_vec(values: &[Complex64]) -> String {
    format!(
        "   {}",
        values
            .iter()
            .map(|&v| fmt_complex(v))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub(crate) fn fmt_complex_mat(matrix: &[Vec<Complex64>]) -> String {
    if matrix.is_empty() {
        return "   []".to_string();
    }
    let cells: Vec<Vec<String>> = matrix
        .iter()
        .map(|row| row.iter().map(|&value| fmt_complex(value)).collect())
        .collect();
    let cols = cells.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![0; cols];
    for row in &cells {
        for (col, value) in row.iter().enumerate() {
            widths[col] = widths[col].max(value.len());
        }
    }
    let mut out = String::new();
    for row in &cells {
        out.push_str("   ");
        for (col, value) in row.iter().enumerate() {
            out.push_str(&format!("{:>width$}  ", value, width = widths[col]));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

pub(crate) fn fmt_mat(m: &[Vec<f64>]) -> String {
    if m.is_empty() {
        return "   []".to_string();
    }
    let cols = m.first().map_or(0, Vec::len);
    if m.len().saturating_mul(cols) > MAX_INLINE_MATRIX_CELLS {
        return format!("   {}×{} 矩阵（内容已省略）", m.len(), cols);
    }
    // 防御：按最长行分配列宽，避免参差矩阵越界
    let cols = m.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut widths = vec![0usize; cols];
    let cells: Vec<Vec<String>> = m
        .iter()
        .map(|row| row.iter().map(|v| fmt_num(*v)).collect())
        .collect();
    for row in &cells {
        for (j, c) in row.iter().enumerate() {
            widths[j] = widths[j].max(c.len());
        }
    }
    let mut out = String::new();
    for row in &cells {
        out.push_str("   ");
        for (j, c) in row.iter().enumerate() {
            out.push_str(&format!("{:>width$}  ", c, width = widths[j]));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

pub(crate) fn fmt_mat_compact(m: &[Vec<f64>]) -> String {
    let cols = m.first().map_or(0, Vec::len);
    if m.len().saturating_mul(cols) > MAX_INLINE_MATRIX_CELLS {
        return format!("{}×{} 矩阵（内容已省略）", m.len(), cols);
    }
    let rows: Vec<String> = m
        .iter()
        .map(|r| r.iter().map(|v| fmt_num(*v)).collect::<Vec<_>>().join(","))
        .collect();
    format!("[{}]", rows.join(";"))
}
