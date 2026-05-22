import { resolve } from 'path';
import fs from 'fs-extra';

export function writeFile(path, content, encoding = 'utf-8') {
	return fs.outputFileSync(resolve(path), content, { encoding });
}

export function createFolder(path) {
	return fs.ensureDirSync(resolve(path));
}