import fs from 'node:fs';
import path from 'node:path';

export function writeFixture(file, bytes, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, options);
}

export function copyFixture(source, destination, options) {
  fs.cpSync(source, destination, options);
  if (!fs.existsSync(path.join(destination, 'manifest.json'))) return;
  let parent = path.dirname(destination);
  while (parent !== path.dirname(parent) && path.basename(parent) !== 'extensions') parent = path.dirname(parent);
  if (path.basename(parent) === 'extensions') bindFixtureExamples(destination, path.dirname(parent));
}

// Keep historical rule implementations intact while installing their test
// data with the current physical layout and explicit path bindings.
export function bindFixtureExamples(directory, root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const file = path.join(directory, manifest.examples);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reference = { path: path.relative(root, directory).replaceAll('\\', '/') };
  raw.extension = reference;
  for (const question of raw.questions ?? []) if (question.extension) question.extension = { ...reference };
  fs.writeFileSync(file, JSON.stringify(raw));
  return raw;
}
