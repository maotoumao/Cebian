import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

// 使用已审核的真实扩展截图，按比例缩放；不改截图文字、不伪造对话。
const screenshot = await sharp(new URL('../src/assets/docs/file-attachment.png', import.meta.url).pathname)
  .resize({ width: 472, height: 534, fit: 'inside' }).png().toBuffer();
const metadata = await sharp(screenshot).metadata();
const frame = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#f8f6f1"/>
  <rect x="0" y="0" width="12" height="630" fill="#ea5a18"/>
  <path d="M58 142H596" stroke="#d9d6cd"/>
  <text x="58" y="89" font-family="sans-serif" font-size="18" letter-spacing="3" fill="#8a5240">OPEN SOURCE / BROWSER AI</text>
  <text x="54" y="249" font-family="sans-serif" font-weight="bold" font-size="100" letter-spacing="-5" fill="#252622">Cebian</text>
  <text x="60" y="309" font-family="sans-serif" font-size="30" fill="#474b43">Your browser. Your models.</text>
  <text x="60" y="381" font-family="sans-serif" font-size="21" fill="#474b43">Read pages. Use tools. Get work done.</text>
  <rect x="58" y="423" width="184" height="42" rx="21" fill="#252622"/>
  <text x="80" y="451" font-family="sans-serif" font-size="18" fill="#ffffff">MCP + Skills</text>
  <text x="264" y="451" font-family="sans-serif" font-size="18" fill="#555a51">Bring your own API</text>
  <text x="60" y="555" font-family="sans-serif" font-size="20" fill="#6b6e63">cebian.catcat.work</text>
  <rect x="652" y="34" width="504" height="566" rx="20" fill="#e7e3da"/>
  <rect x="644" y="26" width="504" height="566" rx="20" fill="#fff" stroke="#d9d6cd"/>
</svg>`);
const dest = new URL('../src/assets/og/', import.meta.url);
await mkdir(dest, { recursive: true });
await sharp(frame).composite([{ input: screenshot,
  left: Math.round(644 + (504 - metadata.width) / 2),
  top: Math.round(26 + (566 - metadata.height) / 2),
}]).png().toFile(new URL('cebian.png', dest).pathname);
console.log('Generated 1200x630 share card from approved extension screenshot.');
