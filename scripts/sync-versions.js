// Regenerate npm/<platform>/package.json and the root optionalDependencies
// so every package carries the root package's version. Run before publishing.
const fs = require('node:fs');
const path = require('node:path');
const platforms = require('./platforms');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

pkg.optionalDependencies = {};
for (const p of platforms) {
  const name = `${pkg.name}-${p.name}`;
  const dir = path.join(root, 'npm', p.name);
  fs.mkdirSync(dir, { recursive: true });
  const sub = {
    name,
    version: pkg.version,
    description: `${pkg.name} prebuilt binary for ${p.target}`,
    main: 'ringwire.node',
    files: ['ringwire.node'],
    os: ['linux'],
    cpu: [p.cpu],
    libc: [p.libc],
    license: pkg.license,
    repository: pkg.repository,
    engines: pkg.engines,
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(sub, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nPrebuilt \`${p.target}\` binary for [${pkg.name}](https://www.npmjs.com/package/${pkg.name}). Install \`${pkg.name}\` instead.\n`);
  pkg.optionalDependencies[name] = pkg.version;
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`synced ${platforms.length} platform packages to ${pkg.version}`);
