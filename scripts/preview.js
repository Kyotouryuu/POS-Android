/**
 * Serves offline-pos for browser preview.
 * preview:android → http://127.0.0.1:4174/mobile.html
 * preview:win     → http://127.0.0.1:4173/index.html
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..', 'offline-pos');
const args = process.argv.slice(2);

function arg(name, fallback) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const port = Number(arg('--port', '4174'));
const openPath = arg('--open', '/mobile.html');
const host = '127.0.0.1';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
};

function resolveFile(urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/') rel = openPath;
    const filePath = path.resolve(root, '.' + rel);
    const inside = filePath === root || filePath.startsWith(root + path.sep);
    return inside ? filePath : null;
}

const server = http.createServer((req, res) => {
    const filePath = resolveFile(req.url || '/');
    if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            const missing = err.code === 'ENOENT' || err.code === 'EISDIR';
            res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(missing ? 'Not found' : 'Error');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    });
});

server.listen(port, host, () => {
    const url = `http://${host}:${port}${openPath.startsWith('/') ? openPath : '/' + openPath}`;
    console.log(`Serving ${root}`);
    console.log(url);
    if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
});
