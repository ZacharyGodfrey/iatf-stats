import frontMatter from 'front-matter';
import Mustache from 'mustache';

Mustache.templateCache = undefined;

export const parseMetadata = (fileContent) => {
  const { attributes: meta, body: content } = frontMatter(fileContent);

  return { meta, content };
};

export const renderMustache = (template, data, partials) => {
  return Mustache.render(template, data, partials);
};