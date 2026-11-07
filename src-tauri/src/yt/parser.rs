// .yt 语言语法分析：递归下降解析器与表达式 AST 构建

use crate::yt::lexer::{Tok, MAX_DEPTH};
use crate::yt::value::{BinOp, Expr};

pub struct Parser<'a> {
    pub(crate) toks: &'a [Tok],
    pub(crate) pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    pub fn new(toks: &'a [Tok]) -> Self {
        Parser {
            toks,
            pos: 0,
            depth: 0,
        }
    }

    fn peek(&self) -> Option<&'a Tok> {
        self.toks.get(self.pos)
    }

    fn next(&mut self) -> Option<&'a Tok> {
        let t = self.toks.get(self.pos);
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn expect(&mut self, t: &Tok) -> Result<(), String> {
        match self.next() {
            Some(x) if x == t => Ok(()),
            other => Err(format!("语法错误：期望 {:?}，得到 {:?}", t, other)),
        }
    }

    pub(crate) fn parse_expr(&mut self) -> Result<Expr, String> {
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
            Some(Tok::Num(v)) => Ok(Expr::Num(*v)),
            Some(Tok::Text(value)) => Ok(Expr::Text(value.clone())),
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
                    self.expect(&Tok::RParen)?;
                    Ok(Expr::Call(name.clone(), args))
                } else {
                    Ok(Expr::Var(name.clone()))
                }
            }
            Some(Tok::LParen) => {
                let e = self.parse_expr()?;
                self.expect(&Tok::RParen)?;
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

// 从 Token 切片解析一条表达式（供 seek / plot 等复用）
pub fn parse_expression(toks: &[Tok]) -> Result<Expr, String> {
    if toks.is_empty() {
        return Err("表达式不能为空".to_string());
    }
    let mut parser = Parser::new(toks);
    let expr = parser.parse_expr()?;
    if parser.pos != parser.toks.len() {
        return Err("表达式末尾有多余内容".to_string());
    }
    Ok(expr)
}
