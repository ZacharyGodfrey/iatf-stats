import sharp from 'sharp';

export function logError(error, info) {
  const data = {
    message: error.message,
    stack: error.stack.split('\n').slice(1).map(x => x.trim()),
    info
  };

  console.error(`ERROR: ${JSON.stringify(data, null, '\t')}`);
}

export function pipe(initial, transforms) {
  return transforms.reduce((result, transform) => transform(result), initial);
}

export async function imageToWebp(originalBuffer, width = 200, height = 200, quality = 100) {
  return await sharp(originalBuffer)
    .resize(width, height)
    .webp({ lossless: true, quality })
    .toBuffer();
}

export function round(places, value) {
  const factor = 10 ** places;

  return Math.round(value * factor) / factor;
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}