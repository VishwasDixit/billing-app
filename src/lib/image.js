// Image helpers: everything is resized on the device before upload, so
// pictures stay small for MongoDB and slow mobile connections.

// Phones' camera photos can be 5–20 MB; anything bigger is refused before decoding.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function checkFile(file) {
  if (!file || !/^image\//.test(file.type || "image/")) throw new Error("Please choose a photo (JPEG or PNG).");
  if (file.size > MAX_FILE_BYTES) throw new Error("This photo is too big. Please choose another.");
}

// Decodes big camera photos at a smaller size where the browser supports it (saves memory on cheap phones).
async function decodeSmall(file, longSide) {
  checkFile(file);
  if (typeof createImageBitmap === "function") {
    try {
      const probe = await createImageBitmap(file);
      const scale = Math.min(1, (longSide * 2) / Math.max(probe.width, probe.height));
      if (scale >= 1) return probe;
      const opts = { resizeWidth: Math.round(probe.width * scale), resizeHeight: Math.round(probe.height * scale), resizeQuality: "high" };
      probe.close?.();
      return await createImageBitmap(file, opts);
    } catch {
      /* fall back to <img> */
    }
  }
  return loadImage(file);
}

export function loadImage(file) {
  checkFile(file);
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that image. Try a JPEG or PNG photo."));
    img.src = url;
  }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 1000));
}

export const sizeOf = (dataUrl) => Math.ceil(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);

// Shop logo: max 256 px, PNG keeps transparency, JPEG if PNG is too big.
export async function resizeLogo(file) {
  const img = await decodeSmall(file, 256);
  const scale = Math.min(1, 256 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  let data = c.toDataURL("image/png");
  if (data.length > 75000) {
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    data = c.toDataURL("image/jpeg", 0.85);
    if (sizeOf(data) > 55 * 1024) data = c.toDataURL("image/jpeg", 0.6);
  }
  return data;
}

// Payment QR picture (e.g. from PhonePe / Paytm business): up to 600 px, kept sharp.
export async function resizeQr(file) {
  const img = await decodeSmall(file, 600);
  const scale = Math.min(1, 600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  // Grayscale: printers only print black and white, and it's smaller.
  const px = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const g = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
    px.data[i] = px.data[i + 1] = px.data[i + 2] = g;
  }
  ctx.putImageData(px, 0, 0);
  let data = c.toDataURL("image/png");
  if (data.length > 150000) data = c.toDataURL("image/jpeg", 0.9);
  if (data.length > 150000) data = c.toDataURL("image/jpeg", 0.7);
  return data;
}

// Menu photo: centre-cropped square, 400 px, WebP (JPEG where unsupported), under ~60 KB.
export const MENU_PHOTO_PX = 360;
export const MENU_PHOTO_MAX = 35 * 1024;

// Menu photo: centre-cropped square, 360 px, WebP (JPEG where unsupported), at most ~35 KB.
export async function menuPhoto(file) {
  const img = await decodeSmall(file, MENU_PHOTO_PX);
  const w = img.width;
  const h = img.height;
  const side = Math.min(w, h);
  const draw = (px) => {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, px, px);
    return c;
  };
  let c = draw(MENU_PHOTO_PX);
  const type = c.toDataURL("image/webp", 0.8).startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
  for (const px of [MENU_PHOTO_PX, 300, 240]) {
    if (px !== MENU_PHOTO_PX) c = draw(px);
    for (const q of [0.75, 0.65, 0.55, 0.45]) {
      const data = c.toDataURL(type, q);
      if (sizeOf(data) <= MENU_PHOTO_MAX) return data;
    }
  }
  img.close?.();
  return c.toDataURL(type, 0.4);
}

// Help screenshot: keeps the whole picture (no crop), long side up to 900 px, ~80 KB JPEG.
export async function screenshotPhoto(file) {
  const img = await decodeSmall(file, 900);
  const scale = Math.min(1, 900 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  for (const q of [0.75, 0.6, 0.45, 0.35]) {
    const data = c.toDataURL("image/jpeg", q);
    if (sizeOf(data) <= 80 * 1024) return data;
  }
  throw new Error("This screenshot is too detailed to send. Please crop it and try again.");
}
