import { config } from '../client/config.js';
import { database } from '../lib/database.js';
import { emptyFolder, readFile, listFiles, writeFile } from '../lib/file.js';
import { prepareHtmlPartial } from '../lib/render.js';
import { renderPage } from '../app/index.js';
import { tearDown } from '../app/index.js';

const OUTPUT_DIR = 'dist';

const start = Date.now();
const db = database();

emptyFolder(OUTPUT_DIR);

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

for (const filePath of listFiles('client/pages/**/*.html')) {
  //
}

for (const [output, input] of Object.entries(pages)) {
  const path = `${OUTPUT_DIR}/${output}`;
  const page = readFile(`client/pages/${input}`);

  console.log(`Writing page: ${path}`);

  writeFile(path, renderPage(shell, page, config, partials));
}

await tearDown(start, db);