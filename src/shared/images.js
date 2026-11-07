import { normalizeBoxes } from './text.js';

export async function imageCanvas(source) {
  const blob =
    source instanceof Blob
      ? source
      : await fetch(source).then((response) => {
          if (!response.ok) throw new Error('图片读取失败');
          return response.blob();
        });
  const image = await createImageBitmap(blob);
  if (
    !image.width ||
    !image.height ||
    image.width * image.height > 36000000 ||
    Math.max(image.width, image.height) > 32760
  ) {
    image.close();
    throw new Error('图片尺寸过大，请拆分为多张图片后翻译');
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d').drawImage(image, 0, 0);
  image.close();
  return canvas;
}
export function imageTiles(canvas, settings) {
  const scale = Math.min(1, settings.imageMaxEdge / canvas.width);
  const height = Math.max(400, Math.round(settings.imageTileHeight / scale));
  const overlap = Math.min(100, Math.round(height * 0.06));
  const tiles = [];
  for (let top = 0; top < canvas.height; top += height - overlap) {
    const h = Math.min(height, canvas.height - top);
    if (top && h <= overlap) break;
    const tile = document.createElement('canvas');
    tile.width = Math.max(1, Math.round(canvas.width * scale));
    tile.height = Math.max(1, Math.round(h * scale));
    tile.getContext('2d').drawImage(canvas, 0, top, canvas.width, h, 0, 0, tile.width, tile.height);
    tiles.push({ top, width: canvas.width, height: h, image: tile.toDataURL('image/jpeg', 0.94) });
    tile.width = tile.height = 1;
  }
  return tiles;
}
function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (width * height) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}
export async function translateImage(canvas, settings, requestVision, progress = () => {}) {
  const tiles = imageTiles(canvas, settings);
  const boxes = [];
  for (const [index, tile] of tiles.entries()) {
    progress({ completed: index, total: tiles.length, stage: 'recognizing' });
    const blocks = await requestVision(tile.image);
    for (const block of normalizeBoxes(blocks, tile.width, tile.height)) {
      block.y += tile.top;
      if (
        !boxes.some(
          (other) =>
            overlapArea(other, block) > 0.6 &&
            (other.text === block.text || other.translation === block.translation),
        )
      )
        boxes.push(block);
    }
  }
  if (!boxes.length)
    throw new Error('视觉模型未识别到可翻译文字，请检查视觉能力或换用更清晰的图片');
  const translated = document.createElement('canvas');
  translated.width = canvas.width;
  translated.height = canvas.height;
  const context = translated.getContext('2d');
  context.drawImage(canvas, 0, 0);
  for (const box of boxes.sort((a, b) => a.y - b.y || a.x - b.x))
    drawRegion(context, box, settings);
  progress({ completed: tiles.length, total: tiles.length, stage: 'done' });
  return { canvas: translated, boxes };
}
function regionColors(context, box) {
  const x = Math.max(0, box.x - 3),
    y = Math.max(0, box.y - 3);
  const width = Math.min(context.canvas.width - x, box.w + 6),
    height = Math.min(context.canvas.height - y, box.h + 6);
  const pixels = context.getImageData(x, y, width, height).data;
  const channels = [[], [], []];
  for (let row = 0; row < height; row += Math.max(1, height - 1))
    for (let col = 0; col < width; col += Math.max(1, Math.floor(width / 20))) {
      const offset = (row * width + col) * 4;
      for (let channel = 0; channel < 3; channel++)
        channels[channel].push(pixels[offset + channel]);
    }
  const background = channels.map(
    (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0,
  );
  const luminance = background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114;
  return {
    background: `rgb(${background.join(',')})`,
    foreground: luminance > 140 ? '#14212E' : '#FFFFFF',
  };
}
export function wrapText(context, text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    const words = paragraph.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+\s*|\s+/gu,
    ) || [''];
    for (const word of words) {
      if (context.measureText(line + word).width <= width) {
        line += word;
        continue;
      }
      if (line) {
        lines.push(line.trimEnd());
        line = '';
      }
      if (context.measureText(word).width > width) {
        for (const character of word) {
          if (line && context.measureText(line + character).width > width) {
            lines.push(line);
            line = '';
          }
          line += character;
        }
      } else line = word;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
export function drawRegion(context, box, settings = {}) {
  const colors = regionColors(context, box);
  const padding = Math.max(1, Math.min(5, box.h * 0.04));
  context.save();
  context.beginPath();
  context.rect(box.x - padding, box.y - padding, box.w + padding * 2, box.h + padding * 2);
  context.clip();
  context.fillStyle = colors.background;
  if (settings.imageRender === 'overlay') context.globalAlpha = 0.88;
  context.fillRect(box.x - padding, box.y - padding, box.w + padding * 2, box.h + padding * 2);
  context.globalAlpha = 1;
  context.fillStyle = colors.foreground;
  context.textBaseline = 'top';
  let size = Math.max(7, Math.min(48, box.h * 0.7));
  let lines = [];
  do {
    context.font = `${size}px "${String(settings.imageFont || 'Microsoft YaHei').replace(/["\\]/g, '')}", sans-serif`;
    lines = wrapText(context, box.translation, Math.max(1, box.w - padding * 2));
    if (lines.length * size * 1.25 <= box.h - padding) break;
    size -= 1;
  } while (size > 6);
  if (box.direction === 'vertical' && box.w < box.h * 0.7) {
    const characters = [...box.translation.replaceAll('\n', '')];
    size = Math.max(
      6,
      Math.min(32, Math.sqrt((box.w * box.h) / Math.max(1, characters.length)) * 0.85),
    );
    context.font = `${size}px "${settings.imageFont || 'Microsoft YaHei'}", sans-serif`;
    const perColumn = Math.max(1, Math.floor((box.h - padding * 2) / (size * 1.15)));
    characters.forEach((character, index) =>
      context.fillText(
        character,
        box.x + box.w - padding - size * (1 + Math.floor(index / perColumn) * 1.2),
        box.y + padding + (index % perColumn) * size * 1.15,
      ),
    );
  } else
    lines.forEach((line, index) =>
      context.fillText(line, box.x + padding, box.y + padding + index * size * 1.25),
    );
  context.restore();
}
export function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片导出失败'))), type),
  );
}
