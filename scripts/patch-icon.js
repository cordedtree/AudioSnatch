const { rcedit } = require('rcedit');
const path = require('path');

const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', 'AudioSnatch.exe');
const ico = path.join(__dirname, '..', 'icon.ico');

rcedit(exe, { icon: ico }).then(() => {
  console.log('Icon patched into AudioSnatch.exe');
}).catch(err => {
  console.error('Failed to patch icon:', err.message);
  process.exit(1);
});
