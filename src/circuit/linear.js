export function zeros(size, vector = false) {
  if (vector) return new Array(size).fill(0);
  return Array.from({ length: size }, () => new Array(size).fill(0));
}

// Partial-pivot elimination mutates A and z; callers rebuild their matrices before reuse.
export function solve(A, z) {
  const n = z.length;
  if (n === 0) return [];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-14) return null;
    if (pivot !== col) {
      const tmpRow = A[pivot]; A[pivot] = A[col]; A[col] = tmpRow;
      const tmpZ = z[pivot]; z[pivot] = z[col]; z[col] = tmpZ;
    }
    const value = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / value;
      if (factor === 0) continue;
      for (let column = col; column < n; column++) A[row][column] -= factor * A[col][column];
      z[row] -= factor * z[col];
    }
  }
  const result = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = z[row];
    for (let column = row + 1; column < n; column++) sum -= A[row][column] * result[column];
    result[row] = sum / A[row][row];
    if (!Number.isFinite(result[row])) return null;
  }
  return result;
}
