import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// After the build, inline the bundled JS and CSS into dist/index.html so the game
// runs by double-clicking the file (browsers refuse to load module scripts from file://).
function singleFile() {
  let outDir;
  return {
    name: 'single-file',
    apply: 'build',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      const htmlPath = path.join(outDir, 'index.html');
      let html = fs.readFileSync(htmlPath, 'utf8');
      const inlined = [];
      const local = (url) => !/^(https?:)?\/\//.test(url);
      html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
        if (!local(src)) return tag;
        const file = path.join(outDir, src);
        inlined.push(file);
        const code = fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script');
        return `<script type="module">${code}</script>`;
      });
      html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (tag) => {
        const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
        if (!href || !local(href)) return tag;
        const file = path.join(outDir, href);
        inlined.push(file);
        return `<style>${fs.readFileSync(file, 'utf8')}</style>`;
      });
      fs.writeFileSync(htmlPath, html);
      for (const f of inlined) fs.rmSync(f);
      const assets = path.join(outDir, 'assets');
      if (fs.existsSync(assets) && fs.readdirSync(assets).length === 0) fs.rmdirSync(assets);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [singleFile()],
  build: {
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2000,
  },
});
