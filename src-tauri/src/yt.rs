// .yt 语言解释器：变量、矩阵、内置函数、函数声明、plot
use serde::Serialize;
use std::collections::HashMap;

use crate::WorkspaceVar;

// ---------------- 值与表达式 ----------------

#[derive(Debug, Clone)]
pub enum Value {
    Num(f64),
    Mat(Vec<Vec<f64>>),
    Func(UserFunc),
}

#[derive(Debug, Clone)]
pub struct UserFunc {
    pub param: String,
    pub body: Expr,
    pub src: String,
}

#[derive(Debug, Clone)]
pub enum Expr {
    Num(f64),
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

#[derive(Debug, Clone, Serialize)]
pub struct Series {
    pub name: String,
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
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

// ---------------- 词法 ----------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Pow,
    Transpose,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Semicolon,
    Assign,
    Arrow,
}

fn strip_comment(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

fn lex(line: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = line.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' => i += 1,
            '0'..='9' | '.' => {
                let start = i;
                let mut dots = 0;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    if chars[i] == '.' {
                        dots += 1;
                    }
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                if dots > 1 || s == "." {
                    return Err(format!("无法解析数字 '{}'", s));
                }
                let v: f64 = s.parse().map_err(|_| format!("无法解析数字 '{}'", s))?;
                toks.push(Tok::Num(v));
            }
            'a'..='z' | 'A'..='Z' | '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                toks.push(Tok::Ident(chars[start..i].iter().collect()));
            }
            '+' => {
                toks.push(Tok::Plus);
                i += 1;
            }
            '-' => {
                // 支持 "y->x" 与 "y- >x"（中间允许空格）
                let mut j = i + 1;
                while j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '>' {
                    toks.push(Tok::Arrow);
                    i = j + 1;
                } else {
                    toks.push(Tok::Minus);
                    i += 1;
                }
            }
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    toks.push(Tok::Pow);
                    i += 2;
                } else {
                    toks.push(Tok::Star);
                    i += 1;
                }
            }
            '/' => {
                toks.push(Tok::Slash);
                i += 1;
            }
            '^' => {
                toks.push(Tok::Pow);
                i += 1;
            }
            '\'' => {
                toks.push(Tok::Transpose);
                i += 1;
            }
            '(' => {
                toks.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                toks.push(Tok::RParen);
                i += 1;
            }
            '[' => {
                toks.push(Tok::LBracket);
                i += 1;
            }
            ']' => {
                toks.push(Tok::RBracket);
                i += 1;
            }
            ',' => {
                toks.push(Tok::Comma);
                i += 1;
            }
            ';' => {
                toks.push(Tok::Semicolon);
                i += 1;
            }
            '=' => {
                toks.push(Tok::Assign);
                i += 1;
            }
            _ => return Err(format!("无法识别的字符 '{}'", c)),
        }
    }
    Ok(toks)
}

// 递归深度上限：防止括号嵌套或函数自递归导致栈溢出
const MAX_DEPTH: usize = 256;

// ---------------- 语法 ----------------

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    depth: usize,
}

impl Parser {
    fn new(toks: Vec<Tok>) -> Self {
        Parser {
            toks,
            pos: 0,
            depth: 0,
        }
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn expect(&mut self, t: Tok) -> Result<(), String> {
        match self.next() {
            Some(x) if x == t => Ok(()),
            other => Err(format!("语法错误：期望 {:?}，得到 {:?}", t, other)),
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            return Err("表达式嵌套过深".to_string());
        }
        let r = self.parse_add();
        self.depth -= 1;
        r
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_mul()?;
        loop {
            match self.peek() {
                Some(Tok::Plus) => {
                    self.next();
                    let right = self.parse_mul()?;
                    left = Expr::Bin(BinOp::Add, Box::new(left), Box::new(right));
                }
                Some(Tok::Minus) => {
                    self.next();
                    let right = self.parse_mul()?;
                    left = Expr::Bin(BinOp::Sub, Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        loop {
            match self.peek() {
                Some(Tok::Star) => {
                    self.next();
                    let right = self.parse_unary()?;
                    left = Expr::Bin(BinOp::Mul, Box::new(left), Box::new(right));
                }
                Some(Tok::Slash) => {
                    self.next();
                    let right = self.parse_unary()?;
                    left = Expr::Bin(BinOp::Div, Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            return Err("表达式嵌套过深".to_string());
        }
        let r = self.parse_unary_inner();
        self.depth -= 1;
        r
    }

    fn parse_unary_inner(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Some(Tok::Minus) => {
                self.next();
                Ok(Expr::Neg(Box::new(self.parse_unary()?)))
            }
            Some(Tok::Plus) => {
                self.next();
                self.parse_unary()
            }
            _ => self.parse_pow(),
        }
    }

    fn parse_pow(&mut self) -> Result<Expr, String> {
        let base = self.parse_postfix()?;
        if matches!(self.peek(), Some(Tok::Pow)) {
            self.next();
            let exp = self.parse_unary()?;
            Ok(Expr::Bin(BinOp::Pow, Box::new(base), Box::new(exp)))
        } else {
            Ok(base)
        }
    }

    fn parse_postfix(&mut self) -> Result<Expr, String> {
        let mut e = self.parse_primary()?;
        while matches!(self.peek(), Some(Tok::Transpose)) {
            self.next();
            e = Expr::Transpose(Box::new(e));
        }
        Ok(e)
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Some(Tok::Num(v)) => Ok(Expr::Num(v)),
            Some(Tok::Ident(name)) => {
                if matches!(self.peek(), Some(Tok::LParen)) {
                    self.next();
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Some(Tok::RParen)) {
                        loop {
                            args.push(self.parse_expr()?);
                            match self.peek() {
                                Some(Tok::Comma) => {
                                    self.next();
                                }
                                _ => break,
                            }
                        }
                    }
                    self.expect(Tok::RParen)?;
                    Ok(Expr::Call(name, args))
                } else {
                    Ok(Expr::Var(name))
                }
            }
            Some(Tok::LParen) => {
                let e = self.parse_expr()?;
                self.expect(Tok::RParen)?;
                Ok(e)
            }
            Some(Tok::LBracket) => self.parse_matrix(),
            other => Err(format!("语法错误：意外的 {:?}", other)),
        }
    }

    // [1,2;3,4] 或 [1 2;3 4]
    fn parse_matrix(&mut self) -> Result<Expr, String> {
        let mut rows: Vec<Vec<Expr>> = Vec::new();
        if matches!(self.peek(), Some(Tok::RBracket)) {
            self.next();
            return Ok(Expr::MatLit(vec![]));
        }
        loop {
            let mut row = Vec::new();
            loop {
                row.push(self.parse_expr()?);
                match self.peek() {
                    Some(Tok::Comma) => {
                        self.next();
                    }
                    Some(Tok::Semicolon) | Some(Tok::RBracket) => break,
                    Some(_) => continue, // 空格分隔
                    None => return Err("语法错误：矩阵未闭合".to_string()),
                }
            }
            rows.push(row);
            match self.peek() {
                Some(Tok::Semicolon) => {
                    self.next();
                }
                Some(Tok::RBracket) => {
                    self.next();
                    break;
                }
                other => return Err(format!("语法错误：矩阵中意外的 {:?}", other)),
            }
        }
        let cols = rows[0].len();
        if rows.iter().any(|r| r.len() != cols) {
            return Err("矩阵每行的列数必须一致".to_string());
        }
        Ok(Expr::MatLit(rows))
    }
}

// ---------------- 求值 ----------------

pub struct Env {
    vars: HashMap<String, Value>,
    declared: HashMap<String, String>, // 函数名 -> 形参
    depth: usize,                      // 求值递归深度
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
        }
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
                return Ok((Some(format!("已声明函数 {}({})，请定义映射关系", name, param)), None));
            }
        }

        // 赋值: name = expr
        if toks.len() >= 2 {
            if let (Tok::Ident(name), Tok::Assign) = (&toks[0], &toks[1]) {
                let name = name.clone();
                if Self::is_const(&name) {
                    return Err(format!("'{}' 是内置常量，不可修改", name));
                }
                let rest = toks[2..].to_vec();
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
            }
        }

        // 裸表达式 -> ans
        let val = self.eval_tokens(toks)?;
        self.vars.insert("ans".to_string(), val.clone());
        Ok((Some(format!("ans =\n\n{}", fmt_value(&val))), None))
    }

    fn eval_tokens(&mut self, toks: Vec<Tok>) -> Result<Value, String> {
        let mut p = Parser::new(toks);
        let expr = p.parse_expr()?;
        if p.pos != p.toks.len() {
            return Err("表达式末尾有多余内容".to_string());
        }
        self.eval(&expr)
    }

    fn eval(&mut self, expr: &Expr) -> Result<Value, String> {
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
            Expr::Var(name) => self
                .vars
                .get(name)
                .cloned()
                .ok_or_else(|| format!("未定义函数或变量 '{}'", name)),
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
                Value::Mat(m) => Ok(Value::Mat(
                    m.iter().map(|r| r.iter().map(|v| -v).collect()).collect(),
                )),
                _ => Err("无法对函数取负".to_string()),
            },
            Expr::Transpose(e) => match self.eval(e)? {
                Value::Num(v) => Ok(Value::Num(v)),
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
            "H" => {
                let m = self.arg_matrix(args, "H")?;
                return Ok(Value::Num(det(&m)?));
            }
            "N" => {
                let m = self.arg_matrix(args, "N")?;
                return Ok(Value::Mat(inv(&m)?));
            }
            "R" => {
                let m = self.arg_matrix(args, "R")?;
                return Ok(Value::Num(rank(&m) as f64));
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
                Value::Num(x) => Value::Num(apply_scalar(name, x)?),
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

    fn arg_matrix(&mut self, args: &[Expr], name: &str) -> Result<Vec<Vec<f64>>, String> {
        if args.len() != 1 {
            return Err(format!("函数 '{}' 需要 1 个参数", name));
        }
        match self.eval(&args[0])? {
            Value::Mat(m) => Ok(m),
            _ => Err(format!("函数 '{}' 的参数必须是矩阵", name)),
        }
    }

    // plot(y) / plot(y, f)
    fn eval_plot(&mut self, toks: &[Tok]) -> Result<(Option<String>, Option<PlotData>), String> {
        // 先校验括号闭合再切片，否则 "plot(" 这类输入会让切片范围倒置而 panic
        if toks.len() < 3 || !matches!(toks.last(), Some(Tok::RParen)) {
            return Err("plot 语句缺少 ')'".to_string());
        }
        let inner = &toks[2..toks.len() - 1];
        let mut names = Vec::new();
        for t in inner {
            match t {
                Tok::Ident(n) => names.push(n.clone()),
                Tok::Comma => {}
                _ => return Err("plot 的参数应为函数名，如 plot(y) 或 plot(y,f)".to_string()),
            }
        }
        if names.is_empty() {
            return Err("plot 至少需要一个函数，如 plot(y)".to_string());
        }

        let mut series = Vec::new();
        for name in &names {
            match self.vars.get(name).cloned() {
                Some(Value::Func(f)) => {
                    let (xs, ys) = sample_func(self, &f, -10.0, 10.0, 400);
                    series.push(Series {
                        name: format!("{}({})", name, f.param),
                        xs,
                        ys,
                    });
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

// ---------------- 运算 ----------------

fn bin_op(op: BinOp, a: &Value, b: &Value) -> Result<Value, String> {
    use BinOp::*;
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => Ok(Value::Num(num_op(op, *x, *y)?)),
        (Value::Mat(m), Value::Num(s)) | (Value::Num(s), Value::Mat(m))
            if matches!(op, Mul | Add | Sub) || (matches!(op, Div) && matches!(b, Value::Num(_))) =>
        {
            let mat = m;
            let scalar = *s;
            if matches!(op, Div) && scalar == 0.0 {
                return Err("除数为零".to_string());
            }
            let mut out = Vec::new();
            for row in mat {
                let mut r = Vec::new();
                for &v in row {
                    let val = match op {
                        Add => v + scalar,
                        Sub => {
                            if matches!(a, Value::Num(_)) {
                                scalar - v
                            } else {
                                v - scalar
                            }
                        }
                        Mul => v * scalar,
                        Div => v / scalar,
                        _ => unreachable!(),
                    };
                    r.push(val);
                }
                out.push(r);
            }
            Ok(Value::Mat(out))
        }
        (Value::Mat(x), Value::Mat(y)) => mat_op(op, x, y),
        _ => Err("运算对象类型不匹配".to_string()),
    }
}

fn num_op(op: BinOp, x: f64, y: f64) -> Result<f64, String> {
    match op {
        BinOp::Add => Ok(x + y),
        BinOp::Sub => Ok(x - y),
        BinOp::Mul => Ok(x * y),
        BinOp::Div => {
            if y == 0.0 {
                Err("除数为零".to_string())
            } else {
                Ok(x / y)
            }
        }
        BinOp::Pow => Ok(x.powf(y)),
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
            let mut out = vec![vec![0.0; cy]; rx];
            for i in 0..rx {
                for j in 0..cy {
                    let mut s = 0.0;
                    for k in 0..cx {
                        s += x[i][k] * y[k][j];
                    }
                    out[i][j] = s;
                }
            }
            Ok(Value::Mat(out))
        }
        _ => Err("矩阵不支持该运算".to_string()),
    }
}

fn det(m: &[Vec<f64>]) -> Result<f64, String> {
    let n = m.len();
    if n == 0 || m.iter().any(|r| r.len() != n) {
        return Err("H() 要求方阵".to_string());
    }
    let mut a: Vec<Vec<f64>> = m.to_vec();
    let mut sign = 1.0;
    let mut result = 1.0;
    for col in 0..n {
        let mut piv = col;
        for r in col + 1..n {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return Ok(0.0);
        }
        if piv != col {
            a.swap(piv, col);
            sign = -sign;
        }
        let pv = a[col][col];
        result *= pv;
        for r in col + 1..n {
            let factor = a[r][col] / pv;
            for c in col..n {
                a[r][c] -= factor * a[col][c];
            }
        }
    }
    Ok(sign * result)
}

fn inv(m: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, String> {
    let n = m.len();
    if n == 0 || m.iter().any(|r| r.len() != n) {
        return Err("N() 要求方阵".to_string());
    }
    let mut a = m.to_vec();
    let mut inv_m = vec![vec![0.0; n]; n];
    for (i, row) in inv_m.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for col in 0..n {
        let mut piv = col;
        for r in col + 1..n {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return Err("矩阵奇异，不可逆".to_string());
        }
        a.swap(piv, col);
        inv_m.swap(piv, col);
        let pv = a[col][col];
        for c in 0..n {
            a[col][c] /= pv;
            inv_m[col][c] /= pv;
        }
        for r in 0..n {
            if r != col {
                let factor = a[r][col];
                for c in 0..n {
                    a[r][c] -= factor * a[col][c];
                    inv_m[r][c] -= factor * inv_m[col][c];
                }
            }
        }
    }
    Ok(inv_m)
}

fn rank(m: &[Vec<f64>]) -> usize {
    let mut a = m.to_vec();
    let (rows, cols) = (a.len(), a[0].len());
    let mut rank = 0;
    let mut row = 0;
    for col in 0..cols {
        if row >= rows {
            break;
        }
        let mut piv = row;
        for r in row + 1..rows {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if a[piv][col].abs() < 1e-10 {
            continue;
        }
        a.swap(piv, row);
        let pv = a[row][col];
        for r in row + 1..rows {
            let factor = a[r][col] / pv;
            for c in col..cols {
                a[r][c] -= factor * a[row][c];
            }
        }
        rank += 1;
        row += 1;
    }
    rank
}

fn is_scalar_builtin(name: &str) -> bool {
    matches!(
        name,
        "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "sinh" | "cosh" | "tanh" | "exp"
            | "ln" | "log" | "sqrt" | "abs" | "floor" | "ceil" | "round"
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

fn sample_func(env: &mut Env, f: &UserFunc, lo: f64, hi: f64, n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    let step = (hi - lo) / (n - 1) as f64;
    for i in 0..n {
        let x = lo + step * i as f64;
        env.vars.insert(f.param.clone(), Value::Num(x));
        if let Ok(Value::Num(y)) = env.eval(&f.body) {
            if y.is_finite() && y.abs() < 1e6 {
                xs.push(x);
                ys.push(y);
            }
        }
    }
    env.vars.remove(&f.param);
    (xs, ys)
}

// ---------------- 显示格式化 ----------------

pub fn fmt_num(v: f64) -> String {
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

fn fmt_value(v: &Value) -> String {
    match v {
        Value::Num(x) => format!("   {}", fmt_num(*x)),
        Value::Mat(m) => fmt_mat(m),
        Value::Func(f) => format!("   函数({})", f.param),
    }
}

fn fmt_mat(m: &[Vec<f64>]) -> String {
    if m.is_empty() {
        return "   []".to_string();
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

fn fmt_mat_compact(m: &[Vec<f64>]) -> String {
    let rows: Vec<String> = m
        .iter()
        .map(|r| {
            r.iter()
                .map(|v| fmt_num(*v))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect();
    format!("[{}]", rows.join(";"))
}
