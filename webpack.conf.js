const path = require('path')
const webpack = require('webpack')
const UglifyJsPlugin = require('uglifyjs-webpack-plugin')

function resolve (dir) {
  return path.join(__dirname, dir)
}

module.exports = {
  entry: {
    index: './index.js'
  },
  output: {
    path: resolve('lib'),
    publicPath: resolve('lib'),
    filename: '[name].js',
    chunkFilename: '[name]/index.js',
    libraryTarget: 'umd',
    umdNamedDefine: true
  },
  mode: 'production',
  resolve: {
    extensions: ['.js'],
    alias: {
      'weex-vuex-storage': resolve(''),
      '@': resolve('packages')
    }
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader'
        }
      }
    ]
  },
  optimization: {
    minimizer: [
      new UglifyJsPlugin({
        uglifyOptions: {
          warning: false,
          mangle: true,
        },
        extractComments: false,
        sourceMap: false,
        parallel: true
      })
    ],
    mangleWasmImports: true,
    splitChunks: {
      maxInitialRequests: 1
    }
  }
}