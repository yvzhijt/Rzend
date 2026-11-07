// .yt 语言求值：环境、表达式求值、内置函数、求根/积分/绘图采样

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use num_complex::Complex64;

use crate::WorkspaceVar;
use crate::yt::lexer::{lex, strip_comment, Tok, MAX_DEPTH};
use crate::yt::math::*;
use crate::yt::parser::{parse_expression, Parser};
use crate::yt::value::*;

// ---------------- 环境 ----------------

pub struct Env {
    vars: HashMap<String, Value>,
    declared: HashMap<String, String>, // 函数名 -> 形参
    depth: usize,                      // 求值递归深度
    working_dir: PathBuf,
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl Env {
    pub fn new() -> Self {
        let mut vars = HashMap::new();
        vars.insert("e".to_string(), Value::Num(2.71828));
        vars.insert("pi".to_string(), Value::Num(3.14159265));
        Env {
            vars,
            declared: HashMap::new(),
            depth: 0,
            working_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }

    pub fn set_working_dir(&mut self, working_dir: PathBuf) {
        self.working_dir = working_dir;
    }

    pub fn reset(&mut self) {
        *self = Env::new();
    }

    fn is_const(name: &str) -> bool {
        name == "e" || name == "pi"
    }

    // 执行一行，返回文本输出（可能附带 plot）
    pub fn eval_line(&mut self, line: &str) -> Result<(Option<String>, Option<PlotData>), String> {
        let line = strip_comment(line).trim().to_string();
        if line.is_empty() {
            return Ok((None, None));
        }
        let toks = lex(&line)?;

        // 函数声明: y -> x
        if toks.len() == 3 && matches!(toks[0], Tok::Ident(_)) && toks[1] == Tok::Arrow {
            if let (Tok::Ident(name), Tok::Ident(param)) = (&toks[0], &toks[2]) {
                if Self::is_const(name) {
                    return Err(format!("'{}' 是内置常量，不可用作函数名", name));
                }
                self.declared.insert(name.clone(), param.clone());
                return Ok((
                    Some(format!("已声明函数 {}({})，请定义映射关系", name, param)),
                    None,
                ));
            }
        }

        // 赋值: name = expr
        if toks.len() >= 2 {
            if let (Tok::Ident(name), Tok::Assign) = (&toks[0], &toks[1]) {
                let name = name.clone();
                if Self::is_const(&name) {
                    return Err(format!("'{}' 是内置常量，不可修改", name));
                }
                let rest = &toks[2..];
                if rest.is_empty() {
                    return Err("赋值语句缺少表达式".to_string());
                }
                // 已声明的函数：定义映射关系
                if let Some(param) = self.declared.get(&name).cloned() {
                    let mut p = Parser::new(rest);
                    let body = p.parse_expr()?;
                    if p.pos != p.toks.len() {
                        return Err("表达式末尾有多余内容".to_string());
                    }
                    let src = line[line.find('=').unwrap() + 1..].trim().to_string();
                    self.vars.insert(
                        name.clone(),
                        Value::Func(UserFunc {
                            param: param.clone(),
                            body,
                            src: src.clone(),
                        }),
                    );
                    return Ok((Some(format!("{}({}) = {}", name, param, src)), None));
                }
                let val = self.eval_tokens(rest)?;
                self.vars.insert(name.clone(), val.clone());
                return Ok((Some(format!("{} =\n\n{}", name, fmt_value(&val))), None));
            }
        }

        // plot(...)
        if toks.len() >= 2 {
            if let (Tok::Ident(cmd), Tok::LParen) = (&toks[0], &toks[1]) {
                if cmd == "plot" {
                    return self.eval_plot(&toks);
                }
                if cmd == "seek" {
                    let roots = self.eval_seek(&toks)?;
                    let value = Value::ComplexVec(roots);
                    let text = format!("seek 找到根：\n\n{}", fmt_value(&value));
                    self.vars.insert("ans".to_string(), value);
                    return Ok((Some(text), None));
                }
            }
        }

        // 裸表达式 -> ans
        let val = self.eval_tokens(&toks)?;
        self.vars.insert("ans".to_string(), val.clone());
        Ok((Some(format!("ans =\n\n{}", fmt_value(&val))), None))
    }

    fn eval_tokens(&mut self, toks: &[Tok]) -> Result<Value, String> {
        let mut p = Parser::new(toks);
        let expr = p.parse_expr()?;
        if p.pos != p.toks.len() {
            return Err("表达式末尾有多余内容".to_string());
        }
        self.eval(&expr)
    }

    pub(crate) fn eval(&mut self, expr: &Expr) -> Result<Value, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            return Err("表达式嵌套过深，可能存在递归调用".to_string());
        }
        let r = self.eval_inner(expr);
        self.depth -= 1;
        r
    }

    fn eval_inner(&mut self, expr: &Expr) -> Result<Value, String> {
        match expr {
            Expr::Num(v) => Ok(Value::Num(*v)),
            Expr::Text(_) => Err("字符串只能用作 readtu 的文件路径".to_string()),
            Expr::Var(name) => match self.vars.get(name).cloned() {
                Some(value) => Ok(value),
                None if name == "i" || name == "j" => Ok(Value::Complex(Complex64::new(0.0, 1.0))),
                None => Err(format!("未定义函数或变量 '{}'", name)),
            },
            Expr::MatLit(rows) => {
                let mut m = Vec::new();
                for row in rows {
                    let mut r = Vec::new();
                    for e in row {
                        match self.eval(e)? {
                            Value::Num(v) => r.push(v),
                            Value::Mat(sub) if sub.len() == 1 => r.extend(sub[0].iter().copied()),
                            _ => return Err("矩阵元素必须是数值".to_string()),
                        }
                    }
                    m.push(r);
                }
                if m.is_empty() {
                    return Err("暂不支持空矩阵".to_string());
                }
                // 摊平后各行长度必须一致，否则后续按列访问会越界
                let cols = m[0].len();
                if m.iter().any(|r| r.len() != cols) {
                    return Err("矩阵各行长度不一致".to_string());
                }
                Ok(Value::Mat(m))
            }
            Expr::Neg(e) => match self.eval(e)? {
                Value::Num(v) => Ok(Value::Num(-v)),
                Value::Complex(v) => Ok(scalar_value(-v)),
                Value::Mat(m) => Ok(Value::Mat(
                    m.iter().map(|r| r.iter().map(|v| -v).collect()).collect(),
                )),
                _ => Err("无法对函数取负".to_string()),
            },
            Expr::Transpose(e) => match self.eval(e)? {
                Value::Num(v) => Ok(Value::Num(v)),
                Value::Complex(v) => Ok(scalar_value(v)),
                Value::Mat(m) => {
                    let (r, c) = (m.len(), m[0].len());
                    if m.iter().any(|row| row.len() != c) {
                        return Err("矩阵各行长度不一致，无法转置".to_string());
                    }
                    let mut t = vec![vec![0.0; r]; c];
                    for (i, row) in m.iter().enumerate() {
                        for (j, v) in row.iter().enumerate() {
                            t[j][i] = *v;
                        }
                    }
                    Ok(Value::Mat(t))
                }
                _ => Err("无法转置函数".to_string()),
            },
            Expr::Bin(op, a, b) => {
                let va = self.eval(a)?;
                let vb = self.eval(b)?;
                bin_op(*op, &va, &vb)
            }
            Expr::Call(name, args) => self.eval_call(name, args),
        }
    }

    fn eval_call(&mut self, name: &str, args: &[Expr]) -> Result<Value, String> {
        // 大写内置矩阵函数（严格大小写）
        match name {
            "readtu" => {
                if args.len() != 1 {
                    return Err("函数 'readtu' 需要 1 个带引号的图片路径".to_string());
                }
                let Expr::Text(path) = &args[0] else {
                    return Err("readtu 的参数必须是带引号的图片路径".to_string());
                };
                if path.trim().is_empty() {
                    return Err("readtu 的图片路径不能为空".to_string());
                }
                let path = Path::new(path);
                let full_path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    self.working_dir.join(path)
                };
                return Ok(Value::Mat(read_grayscale_image(&full_path)?));
            }
            "savetu" => {
                if args.len() != 2 {
                    return Err("函数 'savetu' 用法：savetu(矩阵, \"图片路径\")".to_string());
                }
                let matrix = self.arg_matrix(&args[..1], "savetu")?;
                let Expr::Text(path) = &args[1] else {
                    return Err("savetu 的第二个参数必须是带引号的图片路径".to_string());
                };
                if path.trim().is_empty() {
                    return Err("savetu 的图片路径不能为空".to_string());
                }
                let path = Path::new(path);
                let full_path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    self.working_dir.join(path)
                };
                save_grayscale_image(&matrix, &full_path)?;
                return Ok(Value::Num(1.0));
            }
            "H" => {
                let m = self.arg_matrix(args, "H")?;
                return Ok(Value::Num(matrix_det(&m)?));
            }
            "N" => {
                let m = self.arg_matrix(args, "N")?;
                return Ok(Value::Mat(matrix_inverse(&m)?));
            }
            "R" => {
                let m = self.arg_matrix(args, "R")?;
                return Ok(Value::Num(matrix_rank(&m)? as f64));
            }
            "T" => {
                let m = self.arg_matrix(args, "T")?;
                let (values, vectors) = matrix_eigen(&m)?;
                return Ok(Value::Eigen { values, vectors });
            }
            "GS" => {
                let m = self.arg_matrix(args, "GS")?;
                return Ok(Value::Mat(matrix_rref(&m)?));
            }
            "jf" => {
                if args.len() != 3 {
                    return Err("函数 'jf' 用法：jf(函数名, 下限, 上限)".to_string());
                }
                let func_name = match &args[0] {
                    Expr::Var(name) => name,
                    _ => return Err("jf 的第一个参数必须是已定义的函数名".to_string()),
                };
                let func = self.user_func(func_name)?;
                let lo = self.eval_number(&args[1], "jf 的积分下限")?;
                let hi = self.eval_number(&args[2], "jf 的积分上限")?;
                return Ok(scalar_value(integrate_func(self, &func, lo, hi)?));
            }
            _ => {}
        }

        // 标量数学函数
        if is_scalar_builtin(name) {
            if args.len() != 1 {
                return Err(format!("函数 '{}' 需要 1 个参数", name));
            }
            let v = self.eval(&args[0])?;
            return Ok(match v {
                Value::Num(x) => scalar_value(apply_complex(name, Complex64::new(x, 0.0))?),
                Value::Complex(x) => scalar_value(apply_complex(name, x)?),
                Value::Mat(m) => Value::Mat(
                    m.iter()
                        .map(|r| {
                            r.iter()
                                .map(|&x| apply_scalar(name, x))
                                .collect::<Result<Vec<_>, _>>()
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                _ => return Err(format!("函数 '{}' 的参数必须是数值或矩阵", name)),
            });
        }

        // 用户函数
        let f = match self.vars.get(name) {
            Some(Value::Func(f)) => f.clone(),
            Some(_) => return Err(format!("'{}' 是变量，不是函数", name)),
            None => {
                if self.declared.contains_key(name) {
                    return Err(format!("函数 '{}' 已声明但尚未定义映射关系", name));
                }
                return Err(format!("未定义函数或变量 '{}'", name));
            }
        };
        if args.len() != 1 {
            return Err(format!("函数 '{}' 需要 1 个参数", name));
        }
        let arg = self.eval(&args[0])?;
        let saved = self.vars.get(&f.param).cloned();
        self.vars.insert(f.param.clone(), arg);
        let result = self.eval(&f.body);
        match saved {
            Some(v) => {
                self.vars.insert(f.param.clone(), v);
            }
            None => {
                self.vars.remove(&f.param);
            }
        }
        result
    }

    fn eval_seek(&mut self, toks: &[Tok]) -> Result<Vec<Complex64>, String> {
        if toks.len() < 5 || toks.last() != Some(&Tok::RParen) {
            return Err("seek 用法：seek(函数名=目标值[, 下限, 上限])".to_string());
        }
        let args = split_top_level_args(&toks[2..toks.len() - 1]);
        if args.is_empty() || args.len() > 3 || args[0].len() < 3 {
            return Err("seek 用法：seek(函数名=目标值[, 下限, 上限])".to_string());
        }

        let func_name = match &args[0][0] {
            Tok::Ident(name) if args[0][1] == Tok::Assign => name,
            _ => return Err("seek 的方程应写成 函数名=目标值".to_string()),
        };
        let target_expr = parse_expression(&args[0][2..])?;
        let func = self.user_func(func_name)?;
        let target = value_as_complex(self.eval(&target_expr)?)
            .ok_or_else(|| "seek 的目标值必须是数值".to_string())?;

        let (lo, hi) = match args.len() {
            1 => (-10.0, 10.0),
            3 => (
                self.eval_number(&parse_expression(args[1])?, "seek 的下限")?,
                self.eval_number(&parse_expression(args[2])?, "seek 的上限")?,
            ),
            _ => return Err("seek 指定搜索范围时必须同时提供下限和上限".to_string()),
        };
        if let Some(mut poly) = expression_polynomial(self, &func.body, &func.param)? {
            if poly.len() < 2 {
                return Err("方程不是非恒定多项式".to_string());
            }
            poly[0] -= target;
            trim_polynomial(&mut poly);
            if poly.len() > 11 {
                return Err("seek 当前最多支持 10 次多项式".to_string());
            }
            let roots = polynomial_roots(&poly)?;
            return Ok(roots);
        }
        if target.im.abs() > 1e-12 {
            return Err("超越方程暂只支持实数目标值，并在实数区间内搜索".to_string());
        }
        find_real_roots(self, &func, target.re, lo, hi)
            .map(|roots| roots.into_iter().map(|x| Complex64::new(x, 0.0)).collect())
    }

    fn user_func(&self, name: &str) -> Result<UserFunc, String> {
        match self.vars.get(name) {
            Some(Value::Func(f)) => Ok(f.clone()),
            Some(_) => Err(format!("'{}' 是变量，不是函数", name)),
            None if self.declared.contains_key(name) => {
                Err(format!("函数 '{}' 已声明但尚未定义映射关系", name))
            }
            None => Err(format!("未定义函数或变量 '{}'", name)),
        }
    }

    fn eval_number(&mut self, expr: &Expr, label: &str) -> Result<f64, String> {
        match self.eval(expr)? {
            Value::Num(value) if value.is_finite() => Ok(value),
            Value::Complex(value) if value.im.abs() < 1e-12 && value.re.is_finite() => Ok(value.re),
            Value::Num(_) => Err(format!("{}必须是有限数值", label)),
            Value::Complex(_) => Err(format!("{}必须是实数", label)),
            _ => Err(format!("{}必须是数值", label)),
        }
    }

    fn arg_matrix(&mut self, args: &[Expr], name: &str) -> Result<Vec<Vec<f64>>, String> {
        if args.len() != 1 {
            return Err(format!("函数 '{}' 需要 1 个参数", name));
        }
        match self.eval(&args[0])? {
            Value::Mat(m) => Ok(m),
            _ => Err(format!("函数 '{}' 的参数必须是矩阵", name)),
        }
    }

    // plot(y) / plot(y, f) / plot(y; lo, hi)
    fn eval_plot(&mut self, toks: &[Tok]) -> Result<(Option<String>, Option<PlotData>), String> {
        // 先校验括号闭合再切片，否则 "plot(" 这类输入会让切片范围倒置而 panic
        if toks.len() < 3 || !matches!(toks.last(), Some(Tok::RParen)) {
            return Err("plot 语句缺少 ')'".to_string());
        }
        let inner = &toks[2..toks.len() - 1];
        let mut depth = 0usize;
        let mut range_split = None;
        for (i, tok) in inner.iter().enumerate() {
            match tok {
                Tok::LParen | Tok::LBracket => depth += 1,
                Tok::RParen | Tok::RBracket => depth = depth.saturating_sub(1),
                Tok::Semicolon if depth == 0 => {
                    if range_split.replace(i).is_some() {
                        return Err("plot 的自定义范围语法为 plot(y; 下限, 上限)".to_string());
                    }
                }
                _ => {}
            }
        }
        let (names_toks, range_toks) = match range_split {
            Some(i) => (&inner[..i], Some(&inner[i + 1..])),
            None => (inner, None),
        };
        let mut names = Vec::new();
        for t in names_toks {
            match t {
                Tok::Ident(n) => names.push(n.clone()),
                Tok::Comma => {}
                _ => return Err("plot 的参数应为函数名，如 plot(y) 或 plot(y,f)".to_string()),
            }
        }
        if names.is_empty() {
            return Err("plot 至少需要一个函数，如 plot(y)".to_string());
        }

        let (lo, hi) = if let Some(range) = range_toks {
            let bounds = split_top_level_args(range);
            if bounds.len() != 2 {
                return Err("plot 的自定义范围语法为 plot(y; 下限, 上限)".to_string());
            }
            (
                self.eval_number(&parse_expression(bounds[0])?, "plot 的下限")?,
                self.eval_number(&parse_expression(bounds[1])?, "plot 的上限")?,
            )
        } else {
            (-10.0, 10.0)
        };
        if lo >= hi {
            return Err("plot 的下限必须小于上限".to_string());
        }

        let mut series = Vec::new();
        for name in &names {
            match self.vars.get(name).cloned() {
                Some(Value::Func(f)) => {
                    let (xs, real, imaginary) = sample_func(self, &f, lo, hi, 400);
                    series.push(Series {
                        name: format!("{}({})", name, f.param),
                        xs,
                        ys: real,
                    });
                    if let Some(ys) = imaginary {
                        let xs = series.last().unwrap().xs.clone();
                        series.push(Series {
                            name: format!("{}({}) 虚部", name, f.param),
                            xs,
                            ys,
                        });
                    }
                }
                Some(Value::Mat(m)) => {
                    // 向量按序号绘制
                    let flat: Vec<f64> = if m.len() == 1 {
                        m[0].clone()
                    } else if m.iter().all(|r| r.len() == 1) {
                        m.iter().map(|r| r[0]).collect()
                    } else {
                        return Err(format!("'{}' 不是向量，无法绘制", name));
                    };
                    let xs: Vec<f64> = (1..=flat.len()).map(|i| i as f64).collect();
                    series.push(Series {
                        name: name.clone(),
                        xs,
                        ys: flat,
                    });
                }
                Some(_) => return Err(format!("'{}' 是数值变量，无法绘制", name)),
                None => return Err(format!("未定义函数或变量 '{}'", name)),
            }
        }
        Ok((
            Some(format!("已绘制 {} 个图像", series.len())),
            Some(PlotData { series }),
        ))
    }

    pub fn workspace_vars(&self) -> Vec<WorkspaceVar> {
        let mut names: Vec<_> = self.vars.keys().cloned().collect();
        names.sort();
        names
            .into_iter()
            .map(|n| {
                let v = &self.vars[&n];
                let (value, var_type, size) = match v {
                    Value::Num(x) => (fmt_num(*x), "double".to_string(), "1×1".to_string()),
                    Value::Complex(x) => (
                        fmt_complex(*x),
                        "complex".to_string(),
                        "1×1".to_string(),
                    ),
                    Value::ComplexVec(values) => (
                        fmt_complex_vec(values),
                        "complex vector".to_string(),
                        format!("{} 个根", values.len()),
                    ),
                    Value::Mat(m) => (
                        fmt_mat_compact(m),
                        "matrix".to_string(),
                        format!("{}×{}", m.len(), m[0].len()),
                    ),
                    Value::Func(f) => (
                        format!("{}({}) = {}", n, f.param, f.src),
                        "function".to_string(),
                        "-".to_string(),
                    ),
                    Value::Eigen { values, vectors } => (
                        format!(
                            "特征值: {}; 特征向量: {}",
                            fmt_complex_mat(&[values.clone()]),
                            fmt_complex_mat(vectors)
                        ),
                        "eigenpairs".to_string(),
                        format!("{} 特征对", values.len()),
                    ),
                };
                WorkspaceVar {
                    name: n,
                    value,
                    var_type,
                    size,
                }
            })
            .collect()
    }

    // 执行一段脚本（逐行），遇错停止
    pub fn eval_block(&mut self, code: &str) -> (Vec<EvalOutput>, Option<PlotData>) {
        let mut outputs = Vec::new();
        let mut plot = None;
        for (idx, raw) in code.lines().enumerate() {
            let trimmed = strip_comment(raw).trim();
            if trimmed.is_empty() {
                continue;
            }
            match self.eval_line(raw) {
                Ok((text, p)) => {
                    if let Some(t) = text {
                        outputs.push(EvalOutput {
                            text: t,
                            is_error: false,
                        });
                    }
                    if p.is_some() {
                        plot = p;
                    }
                }
                Err(e) => {
                    outputs.push(EvalOutput {
                        text: format!("第 {} 行出错: {}", idx + 1, e),
                        is_error: true,
                    });
                    break;
                }
            }
        }
        (outputs, plot)
    }
}

// ---------------- 辅助：参数切分 ----------------

fn split_top_level_args(toks: &[Tok]) -> Vec<&[Tok]> {
    let mut args = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    for (i, tok) in toks.iter().enumerate() {
        match tok {
            Tok::LParen | Tok::LBracket => depth += 1,
            Tok::RParen | Tok::RBracket => depth = depth.saturating_sub(1),
            Tok::Comma if depth == 0 => {
                args.push(&toks[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    args.push(&toks[start..]);
    args
}

// ---------------- 辅助：求根与积分 ----------------

fn eval_func_at(env: &mut Env, func: &UserFunc, x: f64) -> Result<f64, String> {
    let saved = env.vars.insert(func.param.clone(), Value::Num(x));
    let result = env.eval(&func.body);
    match saved {
        Some(value) => {
            env.vars.insert(func.param.clone(), value);
        }
        None => {
            env.vars.remove(&func.param);
        }
    }
    match result? {
        Value::Num(value) if value.is_finite() => Ok(value),
        Value::Num(_) => Err("函数在该点的结果不是有限数值".to_string()),
        _ => Err("求根和积分要求函数返回标量数值".to_string()),
    }
}

fn find_real_roots(
    env: &mut Env,
    func: &UserFunc,
    target: f64,
    lo: f64,
    hi: f64,
) -> Result<Vec<f64>, String> {
    if !lo.is_finite() || !hi.is_finite() || lo >= hi {
        return Err("seek 的搜索范围必须是有限数值，且下限小于上限".to_string());
    }

    const STEPS: usize = 2048;
    const VALUE_TOL: f64 = 1e-8;
    const ROOT_TOL: f64 = 1e-9;
    let step = (hi - lo) / STEPS as f64;
    let mut samples = Vec::with_capacity(STEPS + 1);
    for i in 0..=STEPS {
        let x = lo + step * i as f64;
        samples.push(eval_func_at(env, func, x).ok().map(|value| value - target));
    }

    let mut roots = Vec::new();
    let mut add_root = |x: f64| {
        if x.is_finite()
            && roots
                .iter()
                .all(|r: &f64| (r - x).abs() > 1e-6 * (1.0 + x.abs()))
        {
            roots.push(x);
        }
    };

    for (i, value) in samples.iter().enumerate() {
        if let Some(value) = value {
            if value.abs() <= VALUE_TOL && (i == 0 || i == STEPS || *value == 0.0) {
                add_root(lo + step * i as f64);
            }
        }
    }

    for i in 0..STEPS {
        let (Some(mut fl), Some(fr)) = (samples[i], samples[i + 1]) else {
            continue;
        };
        if fl == 0.0 || fr == 0.0 || fl.is_sign_positive() == fr.is_sign_positive() {
            continue;
        }
        let (mut left, mut right) = (lo + step * i as f64, lo + step * (i + 1) as f64);
        let mut best = if fl.abs() < fr.abs() {
            (left, fl)
        } else {
            (right, fr)
        };
        for _ in 0..80 {
            let mid = (left + right) * 0.5;
            let Ok(fm) = eval_func_at(env, func, mid).map(|value| value - target) else {
                break;
            };
            if fm.abs() < best.1.abs() {
                best = (mid, fm);
            }
            if fm.abs() <= ROOT_TOL || right - left <= ROOT_TOL * (1.0 + mid.abs()) {
                break;
            }
            if fl.is_sign_positive() == fm.is_sign_positive() {
                left = mid;
                fl = fm;
            } else {
                right = mid;
            }
        }
        if best.1.abs() <= VALUE_TOL {
            add_root(best.0);
        }
    }

    // 局部极小值可捕获不穿过 x 轴的偶数重根，如 (x - 0.3)^2。
    for i in 1..STEPS {
        let (Some(prev), Some(center), Some(next)) = (samples[i - 1], samples[i], samples[i + 1])
        else {
            continue;
        };
        if center.abs() > prev.abs() || center.abs() > next.abs() {
            continue;
        }
        let mut left = lo + step * (i - 1) as f64;
        let mut right = lo + step * (i + 1) as f64;
        let ratio = (5.0_f64.sqrt() - 1.0) * 0.5;
        let mut x1 = right - ratio * (right - left);
        let mut x2 = left + ratio * (right - left);
        let mut f1 = eval_func_at(env, func, x1)
            .map(|v| (v - target).abs())
            .unwrap_or(f64::INFINITY);
        let mut f2 = eval_func_at(env, func, x2)
            .map(|v| (v - target).abs())
            .unwrap_or(f64::INFINITY);
        for _ in 0..64 {
            if f1 <= f2 {
                right = x2;
                x2 = x1;
                f2 = f1;
                x1 = right - ratio * (right - left);
                f1 = eval_func_at(env, func, x1)
                    .map(|v| (v - target).abs())
                    .unwrap_or(f64::INFINITY);
            } else {
                left = x1;
                x1 = x2;
                f1 = f2;
                x2 = left + ratio * (right - left);
                f2 = eval_func_at(env, func, x2)
                    .map(|v| (v - target).abs())
                    .unwrap_or(f64::INFINITY);
            }
        }
        let (x, residual) = if f1 <= f2 { (x1, f1) } else { (x2, f2) };
        if residual <= VALUE_TOL {
            add_root(x);
        }
    }

    roots.sort_by(f64::total_cmp);
    if roots.is_empty() {
        return Err(format!(
            "在 [{}, {}] 内没有找到实根",
            fmt_num(lo),
            fmt_num(hi)
        ));
    }
    Ok(roots)
}

fn eval_func_at_complex(env: &mut Env, func: &UserFunc, x: Complex64) -> Result<Complex64, String> {
    let saved = env.vars.insert(func.param.clone(), scalar_value(x));
    let result = env.eval(&func.body);
    match saved {
        Some(value) => {
            env.vars.insert(func.param.clone(), value);
        }
        None => {
            env.vars.remove(&func.param);
        }
    }
    match result? {
        Value::Num(value) if value.is_finite() => Ok(Complex64::new(value, 0.0)),
        Value::Complex(value) if value.re.is_finite() && value.im.is_finite() => Ok(value),
        Value::Num(_) | Value::Complex(_) => Err("函数在该点的结果不是有限数值".to_string()),
        _ => Err("积分要求函数返回标量数值".to_string()),
    }
}

fn integrate_func(env: &mut Env, func: &UserFunc, lo: f64, hi: f64) -> Result<Complex64, String> {
    if !lo.is_finite() || !hi.is_finite() {
        return Err("jf 的积分上下限必须是有限数值".to_string());
    }
    if lo == hi {
        return Ok(Complex64::new(0.0, 0.0));
    }
    let sign = if lo < hi { 1.0 } else { -1.0 };
    let (a, b) = if lo < hi { (lo, hi) } else { (hi, lo) };
    let mid = (a + b) * 0.5;
    let fa = eval_func_at_complex(env, func, Complex64::new(a, 0.0))?;
    let fm = eval_func_at_complex(env, func, Complex64::new(mid, 0.0))?;
    let fb = eval_func_at_complex(env, func, Complex64::new(b, 0.0))?;
    let whole = (b - a) * (fa + 4.0 * fm + fb) / 6.0;
    let tolerance = 1e-9 * whole.norm().max(1.0);
    Ok(sign * adaptive_simpson(env, func, a, b, fa, fm, fb, whole, tolerance, 20)?)
}

fn adaptive_simpson(
    env: &mut Env,
    func: &UserFunc,
    a: f64,
    b: f64,
    fa: Complex64,
    fm: Complex64,
    fb: Complex64,
    whole: Complex64,
    tolerance: f64,
    depth: usize,
) -> Result<Complex64, String> {
    let mid = (a + b) * 0.5;
    let left_mid = (a + mid) * 0.5;
    let right_mid = (mid + b) * 0.5;
    let fl = eval_func_at_complex(env, func, Complex64::new(left_mid, 0.0))?;
    let fr = eval_func_at_complex(env, func, Complex64::new(right_mid, 0.0))?;
    let left = (mid - a) * (fa + 4.0 * fl + fm) / 6.0;
    let right = (b - mid) * (fm + 4.0 * fr + fb) / 6.0;
    let combined = left + right;
    if depth == 0 || (combined - whole).norm() <= 15.0 * tolerance {
        return Ok(combined + (combined - whole) / 15.0);
    }
    Ok(adaptive_simpson(
        env,
        func,
        a,
        mid,
        fa,
        fl,
        fm,
        left,
        tolerance * 0.5,
        depth - 1,
    )? + adaptive_simpson(
        env,
        func,
        mid,
        b,
        fm,
        fr,
        fb,
        right,
        tolerance * 0.5,
        depth - 1,
    )?)
}

// ---------------- 运算 ----------------

fn bin_op(op: BinOp, a: &Value, b: &Value) -> Result<Value, String> {
    use BinOp::*;
    if let (Some(x), Some(y)) = (value_as_complex(a.clone()), value_as_complex(b.clone())) {
        if op == Div && y.norm() == 0.0 {
            return Err("除数为零".to_string());
        }
        let value = match op {
            Add => x + y,
            Sub => x - y,
            Mul => x * y,
            Div => x / y,
            Pow => x.powc(y),
        };
        return Ok(scalar_value(value));
    }
    match (a, b) {
        (Value::Mat(m), Value::Num(s)) | (Value::Num(s), Value::Mat(m))
            if matches!(op, Mul | Add | Sub)
                || (matches!(op, Div) && matches!(b, Value::Num(_))) =>
        {
            let mat = m;
            let scalar = *s;
            let left_num = matches!(a, Value::Num(_));
            if matches!(op, Div) && scalar == 0.0 {
                return Err("除数为零".to_string());
            }
            let out = mat
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|&v| match op {
                            Add => v + scalar,
                            Sub => {
                                if left_num {
                                    scalar - v
                                } else {
                                    v - scalar
                                }
                            }
                            Mul => v * scalar,
                            Div => v / scalar,
                            _ => unreachable!(),
                        })
                        .collect()
                })
                .collect();
            Ok(Value::Mat(out))
        }
        (Value::Mat(m), Value::Complex(s)) | (Value::Complex(s), Value::Mat(m))
            if s.im.abs() < 1e-12
                && (matches!(op, Mul | Add | Sub)
                    || (matches!(op, Div) && matches!(b, Value::Complex(_)))) =>
        {
            let scalar = s.re;
            if op == Div && scalar == 0.0 {
                return Err("除数为零".to_string());
            }
            let left_num = matches!(a, Value::Complex(_));
            let out = m
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|&v| match op {
                            Add => v + scalar,
                            Sub if left_num => scalar - v,
                            Sub => v - scalar,
                            Mul => v * scalar,
                            Div => v / scalar,
                            Pow => unreachable!(),
                        })
                        .collect()
                })
                .collect();
            Ok(Value::Mat(out))
        }
        (Value::Mat(_), Value::Complex(_)) | (Value::Complex(_), Value::Mat(_)) => {
            Err("当前矩阵元素为实数，不能与非实复数进行运算".to_string())
        }
        (Value::Mat(x), Value::Mat(y)) => mat_op(op, x, y),
        _ => Err("运算对象类型不匹配".to_string()),
    }
}

fn scalar_value(value: Complex64) -> Value {
    if value.im.abs() < 1e-12 * (1.0 + value.re.abs()) {
        Value::Num(value.re)
    } else {
        Value::Complex(value)
    }
}

fn mat_op(op: BinOp, x: &[Vec<f64>], y: &[Vec<f64>]) -> Result<Value, String> {
    let (rx, cx) = (x.len(), x[0].len());
    let (ry, cy) = (y.len(), y[0].len());
    match op {
        BinOp::Add | BinOp::Sub => {
            if rx != ry || cx != cy {
                return Err("矩阵维度必须一致".to_string());
            }
            let mut out = vec![vec![0.0; cx]; rx];
            for i in 0..rx {
                for j in 0..cx {
                    out[i][j] = if op == BinOp::Add {
                        x[i][j] + y[i][j]
                    } else {
                        x[i][j] - y[i][j]
                    };
                }
            }
            Ok(Value::Mat(out))
        }
        BinOp::Mul => {
            if cx != ry {
                return Err(format!(
                    "矩阵维度不匹配：{}×{} 无法乘 {}×{}",
                    rx, cx, ry, cy
                ));
            }
            // i-k-j 循环序：外层连续遍历 y 的行、内层连续遍历 out 行，
            // 内存访问模式线性，比朴素 i-j-k 快数倍
            let mut out = vec![vec![0.0; cy]; rx];
            for i in 0..rx {
                for k in 0..cx {
                    let a = x[i][k];
                    if a == 0.0 {
                        continue;
                    }
                    let yk = &y[k];
                    let oi = &mut out[i];
                    for j in 0..cy {
                        oi[j] += a * yk[j];
                    }
                }
            }
            Ok(Value::Mat(out))
        }
        _ => Err("矩阵不支持该运算".to_string()),
    }
}

fn is_scalar_builtin(name: &str) -> bool {
    matches!(
        name,
        "sin"
            | "cos"
            | "tan"
            | "asin"
            | "acos"
            | "atan"
            | "sinh"
            | "cosh"
            | "tanh"
            | "asinh"
            | "acosh"
            | "atanh"
            | "exp"
            | "ln"
            | "log"
            | "sqrt"
            | "abs"
            | "floor"
            | "ceil"
            | "round"
    )
}

fn apply_scalar(name: &str, x: f64) -> Result<f64, String> {
    Ok(match name {
        "sin" => x.sin(),
        "cos" => x.cos(),
        "tan" => x.tan(),
        "asin" => {
            if x.abs() > 1.0 {
                return Err("asin 的定义域为 [-1, 1]".to_string());
            }
            x.asin()
        }
        "acos" => {
            if x.abs() > 1.0 {
                return Err("acos 的定义域为 [-1, 1]".to_string());
            }
            x.acos()
        }
        "atan" => x.atan(),
        "sinh" => x.sinh(),
        "cosh" => x.cosh(),
        "tanh" => x.tanh(),
        "asinh" => x.asinh(),
        "acosh" => {
            if x < 1.0 {
                return Err("acosh 的定义域为 x ≥ 1".to_string());
            }
            x.acosh()
        }
        "atanh" => {
            if x.abs() >= 1.0 {
                return Err("atanh 的定义域为 -1 < x < 1".to_string());
            }
            x.atanh()
        }
        "exp" => x.exp(),
        "ln" => {
            if x <= 0.0 {
                return Err("ln 的定义域为 x > 0".to_string());
            }
            x.ln()
        }
        "log" => {
            if x <= 0.0 {
                return Err("log 的定义域为 x > 0".to_string());
            }
            x.log10()
        }
        "sqrt" => {
            if x < 0.0 {
                return Err("sqrt 的定义域为 x ≥ 0".to_string());
            }
            x.sqrt()
        }
        "abs" => x.abs(),
        "floor" => x.floor(),
        "ceil" => x.ceil(),
        "round" => x.round(),
        _ => x,
    })
}

fn apply_complex(name: &str, x: Complex64) -> Result<Complex64, String> {
    let value = match name {
        "sin" => x.sin(),
        "cos" => x.cos(),
        "tan" => x.tan(),
        "asin" => x.asin(),
        "acos" => x.acos(),
        "atan" => x.atan(),
        "sinh" => x.sinh(),
        "cosh" => x.cosh(),
        "tanh" => x.tanh(),
        "asinh" => x.asinh(),
        "acosh" => x.acosh(),
        "atanh" => x.atanh(),
        "exp" => x.exp(),
        "ln" => x.ln(),
        "log" => x.log10(),
        "sqrt" => x.sqrt(),
        "abs" => Complex64::new(x.norm(), 0.0),
        "floor" | "ceil" | "round" if x.im.abs() < 1e-12 => Complex64::new(
            match name {
                "floor" => x.re.floor(),
                "ceil" => x.re.ceil(),
                _ => x.re.round(),
            },
            0.0,
        ),
        "floor" | "ceil" | "round" => {
            return Err(format!("{} 只支持实数参数", name));
        }
        _ => return Err(format!("未知数学函数 '{}'", name)),
    };
    if value.re.is_finite() && value.im.is_finite() {
        Ok(value)
    } else {
        Err(format!("{} 的结果不是有限数值", name))
    }
}

fn sample_func(
    env: &mut Env,
    f: &UserFunc,
    lo: f64,
    hi: f64,
    n: usize,
) -> (Vec<f64>, Vec<f64>, Option<Vec<f64>>) {
    let mut xs = Vec::new();
    let mut real = Vec::new();
    let mut imaginary = Vec::new();
    let mut has_imaginary = false;
    let saved = env.vars.get(&f.param).cloned();
    let step = (hi - lo) / (n - 1) as f64;
    for i in 0..n {
        let x = lo + step * i as f64;
        env.vars.insert(f.param.clone(), Value::Num(x));
        let value = match env.eval(&f.body) {
            Ok(Value::Num(value)) => Some(Complex64::new(value, 0.0)),
            Ok(Value::Complex(value)) => Some(value),
            _ => None,
        };
        if let Some(value) = value.filter(|value| {
            value.re.is_finite()
                && value.im.is_finite()
                && value.re.abs() < 1e6
                && value.im.abs() < 1e6
        }) {
            xs.push(x);
            real.push(value.re);
            imaginary.push(value.im);
            has_imaginary |= value.im.abs() > 1e-12;
        }
    }
    match saved {
        Some(value) => {
            env.vars.insert(f.param.clone(), value);
        }
        None => {
            env.vars.remove(&f.param);
        }
    }
    (xs, real, has_imaginary.then_some(imaginary))
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use image::Pixel;

    fn eval(src: &str) -> Value {
        let mut env = Env::new();
        for line in src.lines() {
            let _ = env.eval_line(line).expect("eval failed");
        }
        env.vars
            .get("ans")
            .or_else(|| env.vars.get("a"))
            .cloned()
            .expect("no value produced")
    }

    #[test]
    fn scalar_arithmetic() {
        assert_eq!(eval("1+2*3"), Value::Num(7.0));
        assert_eq!(eval("2**3"), Value::Num(8.0));
        assert_eq!(eval("10/4"), Value::Num(2.5));
        assert_eq!(eval("ans=3*4"), Value::Num(12.0));
    }

    #[test]
    fn matrix_literal_and_multiply() {
        let mut env = Env::new();
        let _ = env.eval_line("a=[1,2;3,4]").unwrap();
        let _ = env.eval_line("b=[1 2;3 4]").unwrap();
        let (v, _) = eval_env(&mut env, "a*b");
        assert_eq!(v, Value::Mat(vec![vec![7.0, 10.0], vec![15.0, 22.0]]));
        let _ = env.eval_line("b=[2,0;0,2]").unwrap();
        let (v, _) = eval_env(&mut env, "a*2");
        assert_eq!(v, Value::Mat(vec![vec![2.0, 4.0], vec![6.0, 8.0]]));
    }

    #[test]
    fn quoted_windows_paths_preserve_backslashes() {
        assert_eq!(
            lex(r#"readtu("C:\new\a.png")"#).unwrap(),
            vec![
                Tok::Ident("readtu".to_string()),
                Tok::LParen,
                Tok::Text(r"C:\new\a.png".to_string()),
                Tok::RParen,
            ]
        );
    }

    #[test]
    fn readtu_loads_grayscale_pixels_from_working_directory() {
        let path = std::env::temp_dir().join(format!(
            "rzend-readtu-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let image =
            image::RgbImage::from_raw(2, 2, vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
                .unwrap();
        image.save(&path).unwrap();

        let mut env = Env::new();
        env.set_working_dir(path.parent().unwrap().to_path_buf());
        let command = format!(
            "a=readtu(\"{}\")",
            path.file_name().unwrap().to_string_lossy()
        );
        env.eval_line(&command).unwrap();

        let Some(Value::Mat(matrix)) = env.vars.get("a") else {
            panic!("expected grayscale image matrix");
        };
        let expected: Vec<f64> = [
            image::Rgb([255, 0, 0]),
            image::Rgb([0, 255, 0]),
            image::Rgb([0, 0, 255]),
            image::Rgb([255, 255, 255]),
        ]
        .map(|pixel| f64::from(pixel.to_luma().0[0]))
        .to_vec();
        assert_eq!(
            matrix,
            &vec![expected[..2].to_vec(), expected[2..].to_vec()]
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn savetu_writes_clamped_rounded_grayscale_png() {
        let directory = std::env::temp_dir().join(format!(
            "rzend-savetu-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();

        let mut env = Env::new();
        env.set_working_dir(directory.clone());
        env.eval_line("a=[-1,1.5;254.8,300]").unwrap();
        env.eval_line("savetu(a, \"output.png\")").unwrap();

        let saved = image::open(directory.join("output.png"))
            .unwrap()
            .to_luma8();
        assert_eq!(saved.dimensions(), (2, 2));
        assert_eq!(saved.into_raw(), vec![0, 2, 255, 255]);

        std::fs::remove_dir_all(directory).unwrap();
    }

    fn eval_env(env: &mut Env, line: &str) -> (Value, Option<String>) {
        let (t, _) = env.eval_line(line).unwrap();
        let ans = env.vars.get("ans").cloned().unwrap();
        (ans, t)
    }

    #[test]
    fn transpose_det_inv() {
        let mut env = Env::new();
        let _ = env.eval_line("a=[1,2;3,4]").unwrap();
        let (v, _) = eval_env(&mut env, "a'");
        assert_eq!(v, Value::Mat(vec![vec![1.0, 3.0], vec![2.0, 4.0]]));
        let (v, _) = eval_env(&mut env, "H(a)");
        assert_eq!(v, Value::Num(-2.0));
        let (v, _) = eval_env(&mut env, "N(a)");
        match v {
            Value::Mat(m) => {
                assert!((m[0][0] + 2.0).abs() < 1e-9);
                assert!((m[0][1] - 1.0).abs() < 1e-9);
                assert!((m[1][0] - 1.5).abs() < 1e-9);
                assert!((m[1][1] + 0.5).abs() < 1e-9);
            }
            _ => panic!("expected matrix"),
        }
    }

    #[test]
    fn gaussian_elimination_returns_rref() {
        let mut env = Env::new();
        env.eval_line("a=[1,2,3;2,4,7]").unwrap();
        let (value, _) = eval_env(&mut env, "GS(a)");
        match value {
            Value::Mat(matrix) => {
                assert_eq!(matrix, vec![vec![1.0, 2.0, 0.0], vec![0.0, 0.0, 1.0]])
            }
            _ => panic!("expected reduced row echelon matrix"),
        }
    }

    #[test]
    fn faer_matrix_operations_handle_rank_and_singular_inputs() {
        let mut env = Env::new();
        env.eval_line("a=[1,2,3;2,4,6]").unwrap();
        assert_eq!(eval_env(&mut env, "R(a)").0, Value::Num(1.0));
        assert_eq!(eval_env(&mut env, "H(a*a')").0, Value::Num(0.0));
        assert!(env.eval_line("N(a*a')").is_err());
    }

    #[test]
    fn real_and_complex_eigenvalues_and_eigenvectors() {
        let mut env = Env::new();
        env.eval_line("a=[2,1;1,2]").unwrap();
        let (value, _) = eval_env(&mut env, "T(a)");
        let Value::Eigen { values, vectors } = value else {
            panic!("expected eigenvalues and eigenvectors");
        };
        assert!((values[0].re - 1.0).abs() < 1e-10);
        assert!(values[0].im.abs() < 1e-10);
        assert!((values[1].re - 3.0).abs() < 1e-10);
        assert!(values[1].im.abs() < 1e-10);
        let matrix = [[2.0, 1.0], [1.0, 2.0]];
        for (col, value) in values.iter().enumerate() {
            for row in 0..2 {
                let product = (0..2)
                    .map(|k| matrix[row][k] * vectors[k][col])
                    .sum::<Complex64>();
                assert!((product - value * vectors[row][col]).norm() < 1e-8);
            }
        }
        assert!(env.eval_line("b=[0,-1;1,0]").is_ok());
        let (value, _) = eval_env(&mut env, "T(b)");
        let Value::Eigen { values, vectors } = value else {
            panic!("expected complex eigenpairs");
        };
        assert!((values[0] - Complex64::new(0.0, -1.0)).norm() < 1e-8);
        assert!((values[1] - Complex64::new(0.0, 1.0)).norm() < 1e-8);
        for (col, value) in values.iter().enumerate() {
            for row in 0..2 {
                let product = (0..2)
                    .map(|k| {
                        Complex64::new([[0.0, -1.0], [1.0, 0.0]][row][k], 0.0) * vectors[k][col]
                    })
                    .sum::<Complex64>();
                assert!((product - value * vectors[row][col]).norm() < 1e-8);
            }
        }
    }

    #[test]
    fn function_declaration_and_eval() {
        let mut env = Env::new();
        let (t, _) = env.eval_line("y->x").unwrap();
        assert!(t.unwrap().contains("已声明函数"));
        let _ = env.eval_line("y=x*2+1").unwrap();
        let (v, _) = eval_env(&mut env, "y(3)");
        assert_eq!(v, Value::Num(7.0));
    }

    #[test]
    fn inverse_trigonometric_and_hyperbolic_functions() {
        let mut env = Env::new();
        assert!(
            (env.eval_number(&parse_expression(&lex("asin(1)").unwrap()).unwrap(), "test")
                .unwrap()
                - std::f64::consts::FRAC_PI_2)
                .abs()
                < 1e-12
        );
        assert!(
            (env.eval_number(&parse_expression(&lex("acos(1)").unwrap()).unwrap(), "test")
                .unwrap())
            .abs()
                < 1e-12
        );
        assert!(
            (env.eval_number(&parse_expression(&lex("atan(1)").unwrap()).unwrap(), "test")
                .unwrap()
                - std::f64::consts::FRAC_PI_4)
                .abs()
                < 1e-12
        );
        assert!(
            (env.eval_number(
                &parse_expression(&lex("asinh(0)").unwrap()).unwrap(),
                "test"
            )
            .unwrap())
            .abs()
                < 1e-12
        );
        assert!(
            (env.eval_number(
                &parse_expression(&lex("acosh(1)").unwrap()).unwrap(),
                "test"
            )
            .unwrap())
            .abs()
                < 1e-12
        );
        assert!(
            (env.eval_number(
                &parse_expression(&lex("atanh(0)").unwrap()).unwrap(),
                "test"
            )
            .unwrap())
            .abs()
                < 1e-12
        );
        assert!(env.eval_line("asin(2)").is_err());
        assert!(env.eval_line("acosh(0)").is_err());
        assert!(env.eval_line("atanh(1)").is_err());
    }

    #[test]
    fn numerical_root_finding() {
        let mut env = Env::new();
        env.eval_line("y->x").unwrap();
        env.eval_line("y=x**2-1").unwrap();
        env.eval_line("seek(y=0)").unwrap();
        match env.vars.get("ans") {
            Some(Value::ComplexVec(roots)) => {
                assert_eq!(roots.len(), 2);
                assert!((roots[0].re + 1.0).abs() < 1e-8);
                assert!((roots[1].re - 1.0).abs() < 1e-8);
            }
            _ => panic!("expected root vector"),
        }

        env.eval_line("y=(x-0.123)**2").unwrap();
        env.eval_line("seek(y=0,-1,1)").unwrap();
        match env.vars.get("ans") {
            Some(Value::ComplexVec(roots)) => {
                assert_eq!(roots.len(), 2);
                assert!(roots.iter().all(|root| (root.re - 0.123).abs() < 1e-6));
            }
            _ => panic!("expected root vector"),
        }
        assert!(env.eval_line("seek(y=0,1,-1)").is_err());
    }

    #[test]
    fn complex_arithmetic_roots_and_user_override() {
        let mut env = Env::new();
        let (value, _) = eval_env(&mut env, "i*j");
        assert_eq!(value, Value::Num(-1.0));
        env.eval_line("i=3").unwrap();
        assert_eq!(eval_env(&mut env, "i+1").0, Value::Num(4.0));

        env.eval_line("y->x").unwrap();
        env.eval_line("y=x**2+1").unwrap();
        env.eval_line("seek(y=0)").unwrap();
        let Some(Value::ComplexVec(roots)) = env.vars.get("ans") else {
            panic!("expected two complex roots");
        };
        assert_eq!(roots.len(), 2);
        assert!(roots.iter().all(|root| (root.norm() - 1.0).abs() < 1e-8));

        env.eval_line("y=x**3-1").unwrap();
        env.eval_line("seek(y=0)").unwrap();
        let Some(Value::ComplexVec(roots)) = env.vars.get("ans") else {
            panic!("expected three cubic roots");
        };
        assert_eq!(roots.len(), 3);
        assert!(roots.iter().all(|root| (root.powu(3) - 1.0).norm() < 1e-8));
    }

    #[test]
    fn numerical_integration() {
        let mut env = Env::new();
        env.eval_line("y->x").unwrap();
        env.eval_line("y=x**2").unwrap();
        let (v, _) = eval_env(&mut env, "jf(y,0,1)");
        match v {
            Value::Num(result) => assert!((result - 1.0 / 3.0).abs() < 1e-8),
            _ => panic!("expected integral value"),
        }
        let (v, _) = eval_env(&mut env, "jf(y,1,0)");
        match v {
            Value::Num(result) => assert!((result + 1.0 / 3.0).abs() < 1e-8),
            _ => panic!("expected integral value"),
        }

        env.eval_line("y=x**0.5").unwrap();
        let (v, _) = eval_env(&mut env, "jf(y,0,1)");
        match v {
            Value::Num(result) => assert!((result - 2.0 / 3.0).abs() < 1e-6),
            _ => panic!("expected integral value"),
        }

        env.eval_line("y= i*x").unwrap();
        let (v, _) = eval_env(&mut env, "jf(y,0,1)");
        assert_eq!(v, Value::Complex(Complex64::new(0.0, 0.5)));
    }

    #[test]
    fn plot_accepts_custom_x_range() {
        let mut env = Env::new();
        env.eval_line("y->x").unwrap();
        env.eval_line("y=x").unwrap();
        let (_, plot) = env.eval_line("plot(y;0,100)").unwrap();
        let series = plot.unwrap().series;
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].xs.first(), Some(&0.0));
        assert_eq!(series[0].xs.last(), Some(&100.0));

        let (_, plot) = env.eval_line("plot(y)").unwrap();
        let series = plot.unwrap().series;
        assert_eq!(series[0].xs.first(), Some(&-10.0));
        assert_eq!(series[0].xs.last(), Some(&10.0));
        assert!(env.eval_line("plot(y;10,0)").is_err());

        env.eval_line("y=i*x").unwrap();
        let (_, plot) = env.eval_line("plot(y;0,1)").unwrap();
        let series = plot.unwrap().series;
        assert_eq!(series.len(), 2);
        assert_eq!(series[1].name, "y(x) 虚部");
        assert!(series[1].ys.iter().all(|value| *value >= 0.0));
    }

    #[test]
    fn errors() {
        let mut env = Env::new();
        assert!(env.eval_line("1/0").is_err());
        assert!(env.eval_line("e=3").is_err());
        assert!(env.eval_line("a=[1,2;3]").is_err());
        assert!(env.eval_line("plot(").is_err());
        assert!(env.eval_line("jf(unknown,0,1)").is_err());
        assert!(env.eval_line("seek(unknown=0)").is_err());
        assert_eq!(env.eval_line("   ").unwrap(), (None, None), "空行不应报错");
    }
}
