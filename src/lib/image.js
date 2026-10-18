// Image helpers: everything is resized on the device before upload, so
// pictures stay small for MongoDB and slow mobile connections.

export function loadImage(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that image. Try a JPEG or PNG photo."));
    img.src = url;
  }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 1000));
}

const sizeOf = (dataUrl) => Math.ceil(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);

// Shop logo: max 256 px, PNG keeps transparency, JPEG if PNG is too big.
export async function resizeLogo(file) {
  const img = await loadImage(file);
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
  }
  return data;
}

// Menu photo: centre-cropped square, 400 px, WebP (JPEG where unsupported), under ~60 KB.
export async function menuPhoto(file) {
  const img = await loadImage(file);
  const side = Math.min(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = c.height = 400;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 400, 400);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 400, 400);

  const webp = c.toDataURL("image/webp", 0.8).startsWith("data:image/webp");
  const type = webp ? "image/webp" : "image/jpeg";
  let data;
  for (const q of [0.8, 0.7, 0.6, 0.5, 0.4]) {
    data = c.toDataURL(type, q);
    if (sizeOf(data) <= 60 * 1024) return data;
  }
  // Still too big (very detailed photo): shrink further.
  const small = document.createElement("canvas");
  small.width = small.height = 280;
  small.getContext("2d").drawImage(c, 0, 0, 280, 280);
  return small.toDataURL(type, 0.6);
}
