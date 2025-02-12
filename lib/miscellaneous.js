import sharp from 'sharp';

export const logError = (error) => {
  const data = {
    message: error.message,
    stack: error.stack.split('\n').slice(1).map(x => x.trim())
  };

  console.error(`ERROR: ${JSON.stringify(data, null, '\t')}`);
};

export const pipe = (initial, transforms) => {
  return transforms.reduce((result, transform) => transform(result), initial);
};

export const imageToWebp = async (originalBuffer, width = 200, height = 200, quality = 100) => {
  return await sharp(originalBuffer)
    .resize(width, height)
    .webp({ lossless: true, quality })
    .toBuffer();
};