import { parse, resolve } from 'path'
import { mkdir, writeFile } from 'fs/promises'

export async function createFile(path: string, size: number) {
  const fullpath = resolve(path)
  const { dir } = parse(fullpath)

  await mkdir(dir, { recursive: true })
  await writeFile(fullpath, Buffer.alloc(size))
}
