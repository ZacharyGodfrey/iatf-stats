import { config } from '../client/config.js';
import { database } from '../lib/database.js';
import { emptyFolder, readFile, listFiles, writeFile } from '../lib/file.js';
import { parseMetadata, renderMustache } from '../lib/render.js';
import { getAllData, tearDown } from '../app/index.js';

const OUTPUT_DIR = 'dist';

const start = Date.now();
const db = database();

emptyFolder(OUTPUT_DIR);

const shell = readFile('client/shell.html')
  .replace('/* icon */', readFile('client/icon.png', 'base64'))
  .replace('/* style */', readFile('client/style.css'));

const partials = listFiles('client/partials/*.html').reduce((result, fileName) => {
  const name = fileName.match(/\/(?<name>[a-z\-]+)\.html/i).groups.name;

  result[name] = readFile(fileName);

  return result;
}, {});

console.log('Partials: ', Object.keys(partials));

const allData = getAllData(db);

for (const filePath of listFiles('client/pages/**/*.html')) {
  const { meta, content } = parseMetadata(readFile(filePath));
  const path = `${OUTPUT_DIR}/${meta.url}`;
  const data = { ...config, page: meta, data: allData };
  const output = renderMustache(shell, data, { ...partials, content });

  console.log(`Writing page: ${path}`);

  writeFile(path, output);
}

await tearDown(start, db);