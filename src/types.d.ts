declare type UploadSource = {
  filepath: string
  stream: import('fs').ReadStream
  size: number
  encoding?: 'gzip'
}
