const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 1600;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取这张图片"));
    image.src = url;
  });
}

/** 压缩用户选择的封面，避免把超大原图长期写入 IndexedDB。 */
export async function prepareCoverImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("封面图片不能超过 12 MB");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const scale = Math.min(
      1,
      MAX_WIDTH / image.width,
      MAX_HEIGHT / image.height
    );
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理封面图片");
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/webp", 0.9);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
