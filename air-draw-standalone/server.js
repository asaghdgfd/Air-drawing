const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 8080;
const ROOT = __dirname;
const MIME = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.ico':'image/x-icon'};
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const filePath = path.join(ROOT, url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
});
server.listen(PORT, () => console.log(`✅ Air Draw Standalone → http://localhost:${PORT}`));
