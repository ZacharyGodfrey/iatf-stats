import { resolve } from 'path';
import fs from 'fs-extra';
import { globSync } from 'glob';

export function listFiles(pattern) {
	return globSync(pattern, { cwd: resolve() });
}

export function readFile(path, encoding = 'utf-8') {
	return fs.readFileSync(resolve(path), { encoding });
}

export function writeFile(path, content, encoding = 'utf-8') {
	return fs.outputFileSync(resolve(path), content, { encoding });
}

export function createFolder(path) {
	return fs.ensureDirSync(resolve(path));
}

export function emptyFolder(path) {
	return fs.emptyDirSync(resolve(path));
}

export function copyFolder(src, dest) {
	return fs.copySync(resolve(src), resolve(dest));
}