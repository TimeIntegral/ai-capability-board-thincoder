// 生成图标（icon.ico：多尺寸，供桌面快捷方式使用）
// 用法：node tools/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(import.meta.dirname);
const SVG = path.join(ROOT, 'icon.svg');
const ICO = path.join(ROOT, 'icon.ico');
if (!fs.existsSync(SVG)) { console.error('未找到 icon.svg'); process.exit(1); }

const svg = fs.readFileSync(SVG, 'utf8');
const tmp = path.join(ROOT, 'data', '__icon_tmp__');
fs.mkdirSync(tmp, { recursive: true });

const sizes = [256, 32];

// 找一个 Chromium 系浏览器来把 SVG 渲染成 PNG。
// 不写死路径：不同人装的位置不一样（Edge 可能没装、Chrome 可能在别处），
// 写死会让脚本在别人机器上直接失败。先查 PATH，再试常见安装位置，都没有就跳过
// （仓库里已带 icon.ico，正常情况下根本不需要重新生成）。
function findBrowser() {
  const names = ['msedge.exe', 'chrome.exe'];
  for (const n of names) {
    try {
      const r = execFileSync('where.exe', [n], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      const first = r.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    } catch { /* 不在 PATH 里，继续试常见位置 */ }
  }
  // 这些环境变量在 Windows 上总是存在，不写字面量兜底（也就不必把系统盘路径写进源码）
  const pf = process.env['ProgramFiles'];
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env['LOCALAPPDATA'];
  const candidates = [
    pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf86 && path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

const browser = findBrowser();
const pngs = [];
if (!browser) {
  console.log('⚠ 没找到 Edge/Chrome，跳过图标生成（使用仓库里已有的 icon.ico）');
  console.log('  如需重新生成：安装 Edge 或 Chrome，或设 CHROME_PATH 指向浏览器可执行文件');
  process.exit(0);
}
for (const size of sizes) {
  const page = path.join(tmp, `${size}.html`);
  fs.writeFileSync(page, `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg.replace('width="32" height="32"', `width="${size}" height="${size}"`)}</body></html>`);
  const out = path.join(tmp, `${size}.png`);
  const url = 'file:///' + page.replace(/\\/g, '/');
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--default-background-color=00000000',
    `--window-size=${size},${size}`, '--virtual-time-budget=3000', `--screenshot=${out}`, url],
    { stdio: 'ignore', timeout: 60000 });
  pngs.push({ size, png: fs.readFileSync(out) });
}

// 组装 ICO（Vista+ 支持内嵌 PNG）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
let offset = 6 + pngs.length * 16;
const entries = [];
for (const { size, png } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
}
fs.writeFileSync(ICO, Buffer.concat([header, ...entries, ...pngs.map(p => p.png)]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✅ 已生成 icon.ico（${sizes.join('/')}px，${(fs.statSync(ICO).size / 1024).toFixed(1)}KB）`);
