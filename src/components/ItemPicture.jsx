import { useState } from "react";
import { defaultImageFor } from "../../shared/menuImages.js";
// Menu item picture, or a coloured letter tile when it has none.
const TILE_COLORS = ["#fde4cf", "#e2f1dc", "#e6f0fa", "#f1e8f6", "#fff0c9", "#fde2d2", "#e5f4ea"];

export function ItemPicture({ item, size, className = "" }) {
  const style = size ? { width: size, height: size } : undefined;
  // A library photo whose link stopped working falls back to the drawn picture.
  const [brokenSrc, setBrokenSrc] = useState("");
  if (item.image && brokenSrc !== item.image) {
    return <img className={"item-pic " + className} style={style} src={item.image} alt="" loading="lazy" decoding="async" onError={() => setBrokenSrc(item.image)} />;
  }
  if (item.image) {
    return <img className={"item-pic " + className} style={style} src={defaultImageFor(item.name, item.category)} alt="" loading="lazy" decoding="async" />;
  }
  const n = [...(item.name || "?")].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  return (
    <span className={"item-pic letter " + className} style={{ ...style, background: TILE_COLORS[n % TILE_COLORS.length] }} aria-hidden="true">
      {(item.name || "?").trim()[0]?.toUpperCase()}
    </span>
  );
}
