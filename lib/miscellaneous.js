export const logError = (error) => {
  const data = {
    message: error.message,
    stack: error.stack.split('\n').slice(1).map(x => x.trim())
  };

  console.error(`ERROR: ${JSON.stringify(data, null, '\t')}`);
};