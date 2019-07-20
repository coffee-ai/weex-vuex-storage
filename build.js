const path = require('path');
const babel = require('rollup-plugin-babel');
const {terser} = require('rollup-plugin-terser');
const {dependencies} = require('./package.json');

const resolve = p => {
  return path.resolve(__dirname, './', p)
};

module.exports = {
  input: './index.js',
  output: {
    file: resolve('lib/index.js'),
    format: 'cjs',
  },
  external: Object.keys(dependencies),
  plugins: [
    babel({
      exclude: 'node_modules/**',
      externalHelpers: true,
      runtimeHelpers: true,
    }),
  ].concat(process.env.NODE_ENV === 'production'
    ? terser({})
    : []
  )
}