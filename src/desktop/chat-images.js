const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_FILES = 4;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const CHAT_BODY_LIMIT = 4 * Math.ceil(MAX_TOTAL_BYTES / 3) + 1024 * 1024;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

function detectExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "jpg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw new Error("图片必须是 PNG、JPEG 或 WebP");
}

function imagePath(dir, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(id)) throw new Error("图片编号无效");
  return path.join(dir, "chat-images", id);
}

function saveChatImages(dir, images) {
  if (!Array.isArray(images) || images.length > MAX_FILES) throw new Error("每条消息最多附带 4 张图片");
  let totalBytes = 0;
  const decoded = images.map(image => {
    const data = image?.data;
    if (typeof data !== "string" || !data.length || data.length % 4 !== 0 ||
        data.length > 4 * Math.ceil(MAX_FILE_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error("图片编码无效或超过单张 8 MB 限制");
    }
    const bytes = Buffer.from(data, "base64");
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error("单张图片最多 8 MB，合计最多 20 MB");
    const ext = detectExtension(bytes);
    const id = `${crypto.randomUUID()}.${ext}`;
    const name = String(image.name || `图片.${ext}`).slice(0, 180);
    return { bytes, metadata: { id, name } };
  });

  if (!decoded.length) return [];
  fs.mkdirSync(path.join(dir, "chat-images"), { recursive: true });
  const created = [];
  try {
    for (const { bytes, metadata } of decoded) {
      fs.writeFileSync(imagePath(dir, metadata.id), bytes, { mode: 0o600, flag: "wx" });
      created.push(metadata);
    }
    return created;
  } catch (error) {
    removeChatImages(dir, created);
    throw error;
  }
}

function removeChatImages(dir, images) {
  for (const { id } of images) {
    try { fs.unlinkSync(imagePath(dir, id)); } catch {}
  }
}

async function readChatImage(dir, id) {
  const file = imagePath(dir, id);
  const bytes = await fs.promises.readFile(file);
  return { bytes, type: IMAGE_TYPES[path.extname(file).slice(1)] };
}

function resolveChatAttachments(dir, images) {
  return images.map(({ id }) => {
    const absolutePath = imagePath(dir, id);
    if (!fs.existsSync(absolutePath)) throw new Error("本机找不到这条消息的图片，请重新附上图片发送");
    return { absolutePath };
  });
}

module.exports = { CHAT_BODY_LIMIT, saveChatImages, removeChatImages, readChatImage, resolveChatAttachments };
