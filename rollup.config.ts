import fs from 'fs'
import path from 'path'
import commonjs from '@rollup/plugin-commonjs'
import resolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'
import { createRollupLicensePlugin } from 'rollup-license-plugin';


/**
 * Loads and parses a JSON file.
 */
export function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, { encoding: 'utf8' }))
}


function main() {
  const sourcemap = true

  const pkg = loadJSON('./package.json')
  const { main, types } = pkg

  const main_output = path.resolve(main)
  const types_output = path.resolve(types)

  // Make sure this path points to the index.ts file
  const input = path.resolve('src/index.ts')

  const plugins = [
    resolve({
        browser: true,
        preferBuiltins: false,
    }),
    commonjs(),
    typescript({ sourceMap: false }),
    createRollupLicensePlugin({ outputFilename: 'third_party_licenses.txt' }),
  ]

  const configs = []

  const {
    dependencies,
    peerDependencies,
  } = pkg

  const external = Object.keys(dependencies || [])
      .concat(Object.keys(peerDependencies || []))

  configs.push({
    input,
    output: {
      file: main_output,
      format: 'es',
      sourcemap,
    },
    external,
    plugins,
  })

  configs.push({
    input,
    output: {
      file: types_output,
      format: 'es',
    },
    external,
    plugins: [
      dts()
    ],
  })

  return configs
}

export default main()