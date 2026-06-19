const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

// Pre-compress text assets for fast local serving
const cache = new Map();

function compress(raw) {
  const br = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    }
  });
  const gz = zlib.gzipSync(raw, { level: 6 });
  return br.length < gz.length ? { data: br, encoding: 'br' } : { data: gz, encoding: 'gzip' };
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'sw.js') continue;
    if (entry.name === 'lib') continue;       // MediaPipe loaded from CDN
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    const ext = path.extname(entry.name).toLowerCase();
    if (['.html', '.css', '.js', '.json'].includes(ext)) {
      const rel = '/' + path.relative(ROOT, full).replace(/\\/g, '/');
      try {
        const raw = fs.readFileSync(full);
        const { data, encoding } = compress(raw);
        const mime = MIME[ext] || 'application/javascript';
        cache.set(rel, { data, raw, mime, encoding });
        const ratio = Math.round(data.length / raw.length * 100);
        console.log(`  ${rel}  ${raw.length} → ${data.length} bytes (${encoding} ${ratio}%)`);
      } catch (e) {}
    }
  }
}

console.log('Compressing local assets...');
walk(ROOT);
console.log(`${cache.size} assets cached\n`);

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';

  const filePath = path.join(ROOT, url);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  const relPath = '/' + path.relative(ROOT, filePath).replace(/\\/g, '/');
  const ext = path.extname(filePath).toLowerCase();

  // Compressed cache hit
  if (cache.has(relPath)) {
    const { data, raw, mime, encoding } = cache.get(relPath);
    const stat = fs.statSync(filePath);
    const etag = `"${stat.mtime.getTime().toString(16)}-${stat.size.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Encoding': encoding,
      'Content-Length': data.length,
      'ETag': etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(data);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }

    const mime = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const etag = `"${stat.mtime.getTime().toString(16)}-${stat.size.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.length,
      'ETag': etag,
      'Cache-Control': 'public, max-age=600, must-revalidate',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Air Draw → http://localhost:${PORT}`);
  console.log(`   Local assets: brotli/gzip | MediaPipe: CDN\n`);
});
