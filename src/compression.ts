import { createReadStream, createWriteStream, existsSync, rm, ReadStream } from 'fs'
import { stat } from 'fs/promises'
import { resolve, parse } from 'path'
import { pipeline, Readable } from 'node:stream'
import { promisify } from 'util'
import zlib from 'zlib'

const pipe = promisify(pipeline)

import { multipartThreshold } from './config'


export type CompressedSource = {
  filepath: string
  stream: import('fs').ReadStream
  size: number
  encoding?: 'gzip'
}


/**
 * GZipping certain files that are already compressed will likely not yield further size reductions.
 * Creating large temporary gzip files then will just waste a lot of time before ultimately being
 * discarded (especially for very large files). If any of these types of files are encountered
 * then on-disk gzip creation will be skipped and the original file will be uploaded as-is
 */
const gzipExemptFileExtensions = [
  '.gzip',
  '.zip',
  '.tar.lz',
  '.tar.gz',
  '.tar.bz2',
  '.7z'
]


/**
 * Compress the input file with GZIP compression.
 *
 * If the compressed output is not smaller than the original input size, then
 * the original file will be returned.
 *
 * @param filepath - Input filepath.
 * @param size - The input file size in bytes.
 * @param tempFilepath - Temporary filepath.
 * @param autoDelete - Whether to automatically cleanup the tempfile on stream close.
 */
export async function compressIfPossible(
  filepath: string,
  size: number,
  tempFilepath: string,
  autoDelete = true,
): Promise<CompressedSource> {
  const absoluteFilepath = resolve(filepath)
  const absoluteTempFilepath = resolve(tempFilepath)

  const { ext } = parse(absoluteFilepath)

  // File is already compressed
  if (gzipExemptFileExtensions.includes(ext)) {
    return {
      filepath: absoluteFilepath,
      stream: createReadStream(absoluteFilepath),
      size,
    }
  }

  // If small enough, compress in-memory
  const result = size <= multipartThreshold
    ? await compressInMemory(absoluteFilepath, size)
    : await compressOnDisk(absoluteFilepath, tempFilepath, size)

  if (autoDelete) {
    result.stream.on('close', async () => {
      if (existsSync(tempFilepath)) {
        rm(absoluteTempFilepath, (err) => {
          if (err) {
            console.error(err)
            console.error(`Failed to delete tempfile: ${absoluteTempFilepath}`)
          }
        })
      }
    })
  }

  return result
}


async function compressInMemory(filepath: string, size: number): Promise<CompressedSource> {
  return new Promise<CompressedSource>((resolve, reject) => {
    const chunks: Buffer[] = []

    const source = createReadStream(filepath)
    const gzip = zlib.createGzip()
    const stream = source.pipe(gzip)

    stream.on('data', (data) => { chunks.push(data) })

    stream.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const compressedSize = buffer.length

      let result: CompressedSource

      if (compressedSize < size) {
        const stream = Readable.from(buffer) as ReadStream
        stream.close = () => {
          // Noop
        }

        result = {
          filepath,
          stream,
          size: compressedSize,
          encoding: 'gzip'
        }
      } else {
        result = {
          filepath,
          stream: createReadStream(filepath),
          size,
        }
      }

      resolve(result)
    })

    stream.on('error', reject)
  })
}


async function compressOnDisk(filepath: string, tempFilepath: string, size: number): Promise<CompressedSource> {
  const source = createReadStream(filepath)
  const gzip = zlib.createGzip()
  const destination = createWriteStream(tempFilepath)

  await pipe(source, gzip, destination)

  const { size: compressedSize } = await stat(tempFilepath)

  let result: CompressedSource

  if (compressedSize < size) {
    result = {
      filepath,
      stream: createReadStream(tempFilepath),
      size: compressedSize,
      encoding: 'gzip'
    }
  } else {
    result = {
      filepath,
      stream: createReadStream(filepath),
      size,
    }
  }

  return result
}
