import { config } from '../client/config.js';
import { database } from '../lib/database.js';
import { emptyFolder, readFile, writeFile } from '../lib/file.js';
import { prepareHtmlPartial } from '../lib/render.js';
import { renderPage } from '../app/index.js';
import { tearDown } from '../app/index.js';

console.log('Building web pages...');

const start = Date.now();
const db = database();
const DIST = 'docs';

emptyFolder(DIST);

const shell = readFile('client/shell.html')
  .replace('/* icon */', readFile('client/icon.png', 'base64'))
  .replace('/* style */', readFile('client/style.css'));

const partials = {
  profileHeader: prepareHtmlPartial(readFile('client/partials/profile-header.html')),
};

const pages = {
  'index.html': 'index.md',
  'about.html': 'about.md',
  '404.html':   '404.md',
};

for (const [output, input] of Object.entries(pages)) {
  const path = `${DIST}/${output}`;
  const page = readFile(`client/pages/${input}`);

  console.log(`Writing page: ${path}`);

  writeFile(path, renderPage(shell, page, config, partials));
}

await tearDown(start, db);