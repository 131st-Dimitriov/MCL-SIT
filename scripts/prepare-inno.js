// =============================================================================
// scripts/prepare-inno.js
// =============================================================================
// Run after `electron-builder --win dir` to:
//   1) Verify the Electron portable build is present in dist/win-unpacked/
//   2) Print the version so Inno can pick it up
//   3) Copy/refresh build resources used by Inno (the .ico and lua hook)
//
// The Inno script reads from these standard locations.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const unpackedDir = path.join(root, 'dist', 'win-unpacked');
if (!fs.existsSync(unpackedDir)) {
    console.error('FATAL: ' + unpackedDir + ' does not exist.');
    console.error('Did you run `npm run build:portable` first?');
    process.exit(1);
}

// Sanity: the main exe should be there
const exeName = pkg.build.productName + '.exe';
const exePath = path.join(unpackedDir, exeName);
if (!fs.existsSync(exePath)) {
    console.error('FATAL: ' + exePath + ' not found.');
    process.exit(1);
}

console.log('====================================================================');
console.log('Electron portable build OK');
console.log('  Version : ' + version);
console.log('  Source  : ' + unpackedDir);
console.log('  Main exe: ' + exePath);
console.log('====================================================================');
console.log('');
console.log('Next step:');
console.log('  1) Open  installer/mcl-sit-installer.iss  in Inno Setup Compiler');
console.log('  2) Press F9 to build');
console.log('  3) The resulting MCL-SIT-Project-Setup-' + version + '.exe will be in installer/output/');
console.log('');
console.log('To change the version: edit "version" in package.json, then rerun.');
