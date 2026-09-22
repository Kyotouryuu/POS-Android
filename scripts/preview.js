const { spawn, exec } = require('child_process');
const path = require('path');

const isAndroid = process.argv[2] === 'android';
const page = isAndroid ? 'mobile.html' : 'index.html';
const port = isAndroid ? 4174 : 4173;
const url = `http://127.0.0.1:${port}/${page}`;
const root = path.join(__dirname, '..');

const child = spawn('npx', ['serve', 'offline-pos', '-l', String(port)], {
  stdio: 'inherit',
  shell: true,
  cwd: root,
});

const openBrowser = () => {
  const cmd = process.platform === 'win32'
    ? `cmd /c start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
};

console.log(`Preview (${isAndroid ? 'Android / mobile.html' : 'Windows / index.html'}): ${url}`);
setTimeout(openBrowser, 1200);
child.on('exit', (code) => process.exit(code ?? 0));
