// .yt 脚本求值相关命令：求值、重置、导出工作区、运行脚本文件

use std::fs;
use std::panic;

use tauri::State;

use crate::AppState;
use crate::WorkspaceVar;
use crate::commands::{blocking, lock, resolve_path};
use crate::yt::{Env, EvalOutput, EvalResult, PlotData};

/// 捕获解释器 panic（索引越界等），统一转为错误输出而不是让进程崩溃
fn eval_block_guarded(
    env: &mut Env,
    code: &str,
) -> (Vec<EvalOutput>, Option<PlotData>) {
    match panic::catch_unwind(panic::AssertUnwindSafe(|| env.eval_block(code))) {
        Ok(r) => r,
        Err(_) => (
            vec![EvalOutput {
                text: "解释器内部错误，本次求值已终止".to_string(),
                is_error: true,
            }],
            None,
        ),
    }
}

#[tauri::command]
pub async fn yt_eval(state: State<'_, AppState>, code: String) -> Result<EvalResult, String> {
    let yt = state.inner().yt.clone();
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let working_dir = lock(&cwd).clone();
        let mut env = lock(&yt);
        env.set_working_dir(working_dir);
        let (outputs, plot) = eval_block_guarded(&mut env, &code);
        EvalResult {
            outputs,
            plot,
            vars: env.workspace_vars(),
        }
    })
    .await
}

#[tauri::command]
pub fn yt_reset(state: State<'_, AppState>) -> Vec<WorkspaceVar> {
    let cwd = lock(&state.inner().cwd).clone();
    let mut env = lock(&state.inner().yt);
    env.reset();
    env.set_working_dir(cwd);
    env.workspace_vars()
}

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>) -> Vec<WorkspaceVar> {
    lock(&state.inner().yt).workspace_vars()
}

#[tauri::command]
pub async fn run_yt_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<EvalResult, String> {
    let cwd = state.inner().cwd.clone();
    let yt = state.inner().yt.clone();
    blocking(move || {
        let working_dir = lock(&cwd).clone();
        let full = resolve_path(&working_dir, &path);
        let mut env = lock(&yt);
        env.set_working_dir(working_dir);
        match fs::read_to_string(&full) {
            Ok(code) => {
                let (outputs, plot) = eval_block_guarded(&mut env, &code);
                EvalResult {
                    outputs,
                    plot,
                    vars: env.workspace_vars(),
                }
            }
            Err(e) => EvalResult {
                outputs: vec![EvalOutput {
                    text: format!("无法读取文件 {}: {}", full.display(), e),
                    is_error: true,
                }],
                plot: None,
                vars: env.workspace_vars(),
            },
        }
    })
    .await
}

/// 将工作区变量导出为 JSON 文件
#[tauri::command]
pub async fn save_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let yt = state.inner().yt.clone();
    blocking(move || {
        let vars = lock(&yt).workspace_vars();
        let json = serde_json::to_string_pretty(&vars)
            .map_err(|e| format!("序列化工作区失败: {}", e))?;
        fs::write(&path, json).map_err(|e| format!("写入文件失败: {}", e))?;
        Ok(format!("工作区已保存到: {}", path))
    })
    .await?
}
