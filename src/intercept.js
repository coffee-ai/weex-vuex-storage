const interceptors = {};
const START_TYPE = 'start';
export const registerInterceptor = (fn, type = START_TYPE) => {
  const interceptor = interceptors[type] || (interceptors[type] = []);
  interceptor.push(fn);
}
export const runInterceptor = async (type = START_TYPE) => {
  const task = interceptors[type] || [];
  return Promise.all(task);
}