import frontMatter from 'front-matter';
import Mustache from 'mustache';
import { marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';

Mustache.templateCache = undefined;

marked.use(gfmHeadingId({ prefix: '' }));

export const renderMustache = (template, data, partials) => {
  return Mustache.render(template, data, partials);
};

export const renderMarkdown = (fileContent) => {
  return marked.parse(fileContent, { gfm: true });
};

export const parseMetadata = (fileContent) => {
  const { attributes: meta, body: content } = frontMatter(fileContent);

  return { meta, content };
};

export const prepareHtmlPartial = (text) => {
  return `\n${text.split('\n').filter(x => x.length).join('\n')}\n`;
};