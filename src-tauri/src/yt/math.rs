use faer::linalg::solvers::Eigen;
use faer::Mat;
use num_complex::Complex64;

use super::{BinOp, Env, Expr};

pub(super) fn value_as_complex(value: super::Value) -> Option<Complex64> {
    match value {
        super::Value::Num(value) => Some(Complex64::new(value, 0.0)),
        super::Value::Complex(value) => Some(value),
        _ => None,
    }
}

pub(super) fn expression_polynomial(
    env: &mut Env,
    expr: &Expr,
    variable: &str,
) -> Result<Option<Vec<Complex64>>, String> {
    let constant = |value: Complex64| Some(vec![value]);
    match expr {
        Expr::Num(value) => Ok(constant(Complex64::new(*value, 0.0))),
        Expr::Var(name) if name == variable => Ok(Some(vec![
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
        ])),
        Expr::Var(_) => match value_as_complex(env.eval(expr)?) {
            Some(value) => Ok(constant(value)),
            None => Ok(None),
        },
        Expr::Neg(inner) => Ok(expression_polynomial(env, inner, variable)?.map(|mut p| {
            p.iter_mut().for_each(|c| *c = -*c);
            p
        })),
        Expr::Bin(op, lhs, rhs) => {
            let Some(left) = expression_polynomial(env, lhs, variable)? else {
                return Ok(None);
            };
            let Some(right) = expression_polynomial(env, rhs, variable)? else {
                return Ok(None);
            };
            match op {
                BinOp::Add => Ok(Some(poly_add(&left, &right))),
                BinOp::Sub => Ok(Some(poly_sub(&left, &right))),
                BinOp::Mul => Ok(Some(poly_mul(&left, &right))),
                BinOp::Div if right.len() == 1 && right[0].norm() > 0.0 => {
                    Ok(Some(left.iter().map(|c| *c / right[0]).collect()))
                }
                BinOp::Pow
                    if right.len() == 1
                        && right[0].im.abs() < 1e-12
                        && (0.0..=10.0).contains(&right[0].re)
                        && right[0].re.fract() == 0.0 =>
                {
                    let mut out = vec![Complex64::new(1.0, 0.0)];
                    for _ in 0..right[0].re as usize {
                        out = poly_mul(&out, &left);
                    }
                    Ok(Some(out))
                }
                _ => Ok(None),
            }
        }
        Expr::Call(_, _) | Expr::MatLit(_) | Expr::Transpose(_) => Ok(None),
    }
}

fn poly_add(a: &[Complex64], b: &[Complex64]) -> Vec<Complex64> {
    let mut out = vec![Complex64::new(0.0, 0.0); a.len().max(b.len())];
    for (i, value) in a.iter().enumerate() {
        out[i] += value;
    }
    for (i, value) in b.iter().enumerate() {
        out[i] += value;
    }
    trim_polynomial(&mut out);
    out
}

fn poly_sub(a: &[Complex64], b: &[Complex64]) -> Vec<Complex64> {
    let neg_b: Vec<_> = b.iter().map(|value| -*value).collect();
    poly_add(a, &neg_b)
}

fn poly_mul(a: &[Complex64], b: &[Complex64]) -> Vec<Complex64> {
    let mut out = vec![Complex64::new(0.0, 0.0); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            out[i + j] += x * y;
        }
    }
    trim_polynomial(&mut out);
    out
}

pub(super) fn trim_polynomial(poly: &mut Vec<Complex64>) {
    while poly.len() > 1 && poly.last().is_some_and(|c| c.norm() < 1e-14) {
        poly.pop();
    }
}

fn polynomial_value(coefficients: &[Complex64], x: Complex64) -> Complex64 {
    coefficients
        .iter()
        .rev()
        .fold(Complex64::new(0.0, 0.0), |value, coefficient| {
            value * x + coefficient
        })
}

pub(super) fn polynomial_roots(coefficients: &[Complex64]) -> Result<Vec<Complex64>, String> {
    let degree = coefficients.len().saturating_sub(1);
    if degree == 0 {
        return Err("方程没有有限根".to_string());
    }
    if degree > 10 {
        return Err("seek 当前最多支持 10 次多项式".to_string());
    }
    let leading = coefficients[degree];
    if leading.norm() < 1e-14 {
        return Err("多项式最高次项系数不能为零".to_string());
    }
    let normalized: Vec<_> = coefficients.iter().map(|c| *c / leading).collect();
    let roots = match degree {
        1 => vec![-normalized[0]],
        2 => {
            let (c, b) = (normalized[0], normalized[1]);
            let sqrt = (b * b - 4.0 * c).sqrt();
            vec![(-b + sqrt) / 2.0, (-b - sqrt) / 2.0]
        }
        3 => cubic_roots(&normalized),
        _ => durand_kerner_roots(&normalized)?,
    };
    if roots.iter().any(|root| {
        let residual = polynomial_value(&normalized, *root).norm();
        residual > 1e-7 * (1.0 + root.norm()).powi(degree as i32)
    }) {
        return Err("多项式复根迭代未达到所需精度".to_string());
    }
    Ok(roots)
}

fn cubic_roots(coefficients: &[Complex64]) -> Vec<Complex64> {
    let (a, b, c) = (coefficients[2], coefficients[1], coefficients[0]);
    let p = b - a * a / 3.0;
    let q = 2.0 * a * a * a / 27.0 - a * b / 3.0 + c;
    let discriminant = q * q / 4.0 + p * p * p / 27.0;
    let sqrt_discriminant = discriminant.sqrt();
    let mut u = (-q / 2.0 + sqrt_discriminant).powf(1.0 / 3.0);
    if u.norm() < 1e-14 {
        u = (-q / 2.0 - sqrt_discriminant).powf(1.0 / 3.0);
    }
    let shift = a / 3.0;
    if u.norm() < 1e-14 {
        return vec![-shift; 3];
    }
    let v = -p / (3.0 * u);
    let omega = Complex64::new(-0.5, 3.0_f64.sqrt() / 2.0);
    vec![
        u + v - shift,
        omega * u + omega.conj() * v - shift,
        omega.conj() * u + omega * v - shift,
    ]
}

fn durand_kerner_roots(coefficients: &[Complex64]) -> Result<Vec<Complex64>, String> {
    let degree = coefficients.len() - 1;
    let radius = 1.0
        + coefficients[..degree]
            .iter()
            .map(|c| c.norm())
            .fold(0.0_f64, f64::max);
    let offset = 0.2718281828459045;
    let mut roots: Vec<_> = (0..degree)
        .map(|i| {
            let angle = std::f64::consts::TAU * (i as f64 + offset) / degree as f64;
            Complex64::from_polar(radius, angle)
        })
        .collect();
    let mut converged = false;
    for _ in 0..20_000 {
        let old = roots.clone();
        let mut max_delta = 0.0_f64;
        for i in 0..degree {
            let denominator = (0..degree)
                .filter(|&j| j != i)
                .fold(Complex64::new(1.0, 0.0), |product, j| {
                    product * (old[i] - old[j])
                });
            if denominator.norm() < 1e-28 {
                continue;
            }
            let delta = polynomial_value(coefficients, old[i]) / denominator;
            roots[i] = old[i] - delta;
            max_delta = max_delta.max(delta.norm());
        }
        if max_delta < 1e-12 {
            converged = true;
            break;
        }
    }
    if !converged {
        return Err("多项式复根迭代未收敛（可能存在高重根或数值病态）".to_string());
    }
    Ok(roots)
}

/// 特征分解（faer 实现）：返回 (特征值, 特征向量按行存储)。
/// faer 的特征值顺序未指定，这里统一按 (re, im) 稳定排序，保持输出可预期。
pub(super) fn matrix_eigen(
    matrix: &[Vec<f64>],
) -> Result<(Vec<Complex64>, Vec<Vec<Complex64>>), String> {
    let n = matrix.len();
    if n == 0 || matrix.iter().any(|row| row.len() != n) {
        return Err("T() 要求非空方阵".to_string());
    }

    let a = Mat::from_fn(n, n, |i, j| matrix[i][j]);
    let evd = Eigen::new_from_real(a.as_ref())
        .map_err(|_| "T() 无法完成特征分解（矩阵可能非常病态或不可对角化）".to_string())?;
    let u = evd.U();
    let diagonal: Vec<Complex64> = evd.S().column_vector().iter().copied().collect();

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        diagonal[a]
            .re
            .total_cmp(&diagonal[b].re)
            .then_with(|| diagonal[a].im.total_cmp(&diagonal[b].im))
    });

    let values: Vec<Complex64> = order.iter().map(|&i| diagonal[i]).collect();

    // U 的列是特征向量；按排序后的列顺序收集并归一化
    let columns: Vec<Vec<Complex64>> = order
        .iter()
        .map(|&i| {
            let column: Vec<Complex64> = (0..n).map(|row| u[(row, i)]).collect();
            normalize_vector(column)
        })
        .collect();

    let vectors = (0..n)
        .map(|row| columns.iter().map(|column| column[row]).collect())
        .collect();
    Ok((values, vectors))
}

fn normalize_vector(vector: Vec<Complex64>) -> Vec<Complex64> {
    let norm = vector.iter().map(|v| v.norm_sqr()).sum::<f64>().sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return vector;
    }
    vector.into_iter().map(|v| v / norm).collect()
}
