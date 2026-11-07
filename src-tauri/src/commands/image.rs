// 图片预览与编辑：读取为 base64 预览，或按操作序列就地/另存转换

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::GenericImageView;
use tauri::State;

use crate::AppState;
use crate::commands::{blocking, lock, resolve_path};

#[derive(serde::Serialize)]
pub struct ImagePreview {
    data_url: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn read_image_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImagePreview, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let full = resolve_path(&lock(&cwd), &path);
        let metadata = fs::metadata(&full)
            .map_err(|error| format!("读取图片失败 {}: {}", full.display(), error))?;
        if !metadata.is_file() {
            return Err(format!("不是文件: {}", full.display()));
        }
        if metadata.len() > 32 * 1024 * 1024 {
            return Err("图片文件超过 32 MiB，无法预览".to_string());
        }

        let mut reader = image::ImageReader::open(&full)
            .map_err(|error| format!("无法打开图片 {}: {}", full.display(), error))?
            .with_guessed_format()
            .map_err(|error| format!("无法识别图片格式 {}: {}", full.display(), error))?;
        let format = reader
            .format()
            .ok_or_else(|| format!("无法识别图片格式: {}", full.display()))?;
        let mime = match format {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Gif => "image/gif",
            image::ImageFormat::WebP => "image/webp",
            image::ImageFormat::Bmp => "image/bmp",
            image::ImageFormat::Ico => "image/x-icon",
            _ => return Err(format!("不支持预览此图片格式: {}", full.display())),
        };
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16_384);
        limits.max_image_height = Some(16_384);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|error| format!("无法解码图片 {}: {}", full.display(), error))?;
        let (width, height) = (decoded.width(), decoded.height());
        let bytes = fs::read(&full)
            .map_err(|error| format!("读取图片失败 {}: {}", full.display(), error))?;
        Ok(ImagePreview {
            data_url: format!(
                "data:{};base64,{}",
                mime,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            width,
            height,
        })
    })
    .await?
}

#[derive(Clone, serde::Deserialize)]
pub struct ImageOperation {
    kind: String,
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
}

fn transform_image_sync(
    source: &Path,
    operations: Vec<ImageOperation>,
    output: Option<PathBuf>,
) -> Result<ImagePreview, String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("读取图片失败 {}: {}", source.display(), error))?;
    if !metadata.is_file() {
        return Err(format!("不是文件: {}", source.display()));
    }
    if metadata.len() > 32 * 1024 * 1024 {
        return Err("图片文件超过 32 MiB，无法编辑".to_string());
    }
    let mut reader = image::ImageReader::open(source)
        .map_err(|error| format!("无法打开图片 {}: {}", source.display(), error))?
        .with_guessed_format()
        .map_err(|error| format!("无法识别图片格式 {}: {}", source.display(), error))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut image = reader
        .decode()
        .map_err(|error| format!("无法解码图片 {}: {}", source.display(), error))?;
    if u64::from(image.width()) * u64::from(image.height()) > 8_388_608 {
        return Err("图片像素数量过大，最多支持 8388608 个像素".to_string());
    }

    for operation in operations {
        match operation.kind.as_str() {
            "crop" => {
                let x = operation.x.ok_or_else(|| "裁剪位置无效".to_string())?;
                let y = operation.y.ok_or_else(|| "裁剪位置无效".to_string())?;
                let width = operation.width.ok_or_else(|| "裁剪宽度无效".to_string())?;
                let height = operation.height.ok_or_else(|| "裁剪高度无效".to_string())?;
                if width == 0
                    || height == 0
                    || x.checked_add(width)
                        .map_or(true, |right| right > image.width())
                    || y.checked_add(height)
                        .map_or(true, |bottom| bottom > image.height())
                {
                    return Err("裁剪区域超出图片范围".to_string());
                }
                image = image.crop_imm(x, y, width, height);
            }
            "resize" => {
                let width = operation.width.ok_or_else(|| "缩放宽度无效".to_string())?;
                let height = operation.height.ok_or_else(|| "缩放高度无效".to_string())?;
                if width == 0
                    || height == 0
                    || width > 16_384
                    || height > 16_384
                    || u64::from(width) * u64::from(height) > 8_388_608
                {
                    return Err(
                        "缩放尺寸无效：最多支持 16384×16384 且不超过 8388608 个像素".to_string(),
                    );
                }
                image = image.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
            }
            "rotate_left" => image = image.rotate270(),
            "rotate_right" => image = image.rotate90(),
            "grayscale" => image = image.grayscale(),
            "blur" => image = image.blur(2.0),
            "sharpen" => image = image.unsharpen(1.0, 1),
            "brighten" => image = image.brighten(30),
            "darken" => image = image.brighten(-30),
            "contrast" => image = image.adjust_contrast(25.0),
            "invert" => image.invert(),
            kind => return Err(format!("不支持的图片操作: {}", kind)),
        }
    }

    let saving = output.is_some();
    if let Some(output) = output {
        let source_canonical = source
            .canonicalize()
            .map_err(|error| format!("无法解析源图片路径: {}", error))?;
        let output_canonical = if output.exists() {
            output.canonicalize()
        } else {
            output
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .canonicalize()
                .map(|parent| parent.join(output.file_name().unwrap_or_default()))
        }
        .map_err(|error| format!("无法解析保存路径: {}", error))?;
        if source_canonical == output_canonical {
            return Err("另存为路径不能覆盖原图片".to_string());
        }
        let format = image::ImageFormat::from_path(&output)
            .map_err(|error| format!("无法识别保存图片格式: {}", error))?;
        image
            .save_with_format(&output, format)
            .map_err(|error| format!("保存图片失败 {}: {}", output.display(), error))?;
    }

    let (width, height) = image.dimensions();
    if saving {
        return Ok(ImagePreview {
            data_url: String::new(),
            width,
            height,
        });
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| format!("生成图片预览失败: {}", error))?;
    Ok(ImagePreview {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        ),
        width,
        height,
    })
}

#[tauri::command]
pub async fn transform_image(
    state: State<'_, AppState>,
    path: String,
    operations: Vec<ImageOperation>,
    output_path: Option<String>,
) -> Result<ImagePreview, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let current_dir = lock(&cwd);
        let source = resolve_path(&current_dir, &path);
        let output = output_path.map(|path| resolve_path(&current_dir, &path));
        drop(current_dir);
        transform_image_sync(&source, operations, output)
    })
    .await?
}

#[cfg(test)]
mod image_edit_tests {
    use super::{transform_image_sync, ImageOperation};
    use image::GenericImageView;
    use image::Rgba;
    use std::sync::atomic::{AtomicU64, Ordering};

    // 临时文件序号，避免并发运行时互相覆盖
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn image_operations_preview_and_save_transformed_png() {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let base =
            std::env::temp_dir().join(format!("rzend_image_edit_{}_{}", std::process::id(), seq));
        let source = base.with_extension("source.png");
        let output = base.with_extension("edited.png");
        let image = image::RgbaImage::from_fn(4, 2, |x, y| {
            if (x + y) % 2 == 0 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 0, 255, 255])
            }
        });
        image.save(&source).unwrap();

        let operations = vec![
            ImageOperation {
                kind: "crop".into(),
                x: Some(1),
                y: Some(0),
                width: Some(2),
                height: Some(1),
            },
            ImageOperation {
                kind: "rotate_right".into(),
                x: None,
                y: None,
                width: None,
                height: None,
            },
            ImageOperation {
                kind: "resize".into(),
                x: None,
                y: None,
                width: Some(2),
                height: Some(4),
            },
            ImageOperation {
                kind: "grayscale".into(),
                x: None,
                y: None,
                width: None,
                height: None,
            },
        ];
        let preview = transform_image_sync(&source, operations.clone(), None).unwrap();
        let saved_preview =
            transform_image_sync(&source, operations, Some(output.clone())).unwrap();

        assert_eq!((preview.width, preview.height), (2, 4));
        assert!(preview.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((saved_preview.width, saved_preview.height), (2, 4));
        assert!(saved_preview.data_url.is_empty());
        let saved = image::ImageReader::open(&output).unwrap().decode().unwrap();
        assert_eq!(saved.dimensions(), (2, 4));
        let pixel = saved.to_rgba8().get_pixel(0, 0).0;
        assert_eq!(pixel[0], pixel[1]);
        assert_eq!(pixel[1], pixel[2]);

        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(output);
    }
}
