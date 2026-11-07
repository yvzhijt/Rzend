// .yt 语言词法分析：Token 定义、注释剥除与分词

// 递归深度上限：防止括号嵌套或函数自递归导致栈溢出
pub const MAX_DEPTH: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Num(f64),
    Ident(String),
    Text(String),
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

pub fn strip_comment(line: &str) -> &str {
    let mut in_string = false;
    let mut escaped = false;
    let mut chars = line.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
        } else if ch == '/' && chars.peek().is_some_and(|(_, next)| *next == '/') {
            return &line[..index];
        }
    }
    line
}

pub fn lex(line: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = line.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' => i += 1,
            '"' => {
                i += 1;
                let mut value = String::new();
                let mut closed = false;
                while i < chars.len() {
                    match chars[i] {
                        '"' => {
                            i += 1;
                            closed = true;
                            break;
                        }
                        '\\' if i + 1 < chars.len() => {
                            i += 1;
                            match chars[i] {
                                '"' => value.push('"'),
                                '\\' => value.push('\\'),
                                escaped => {
                                    value.push('\\');
                                    value.push(escaped);
                                }
                            }
                            i += 1;
                        }
                        ch => {
                            value.push(ch);
                            i += 1;
                        }
                    }
                }
                if !closed {
                    return Err("字符串缺少结束引号".to_string());
                }
                toks.push(Tok::Text(value));
            }
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
