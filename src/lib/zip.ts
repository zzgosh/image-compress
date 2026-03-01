import archiver from 'archiver'
import { PassThrough } from 'node:stream'
import type { CompressedImageResult } from '../types/api.js'

const splitFileName = (fileName: string): { baseName: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { baseName: fileName, extension: '' }
  }

  return {
    baseName: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex + 1)
  }
}

const withUniqueNames = (files: CompressedImageResult[]): CompressedImageResult[] => {
  const counter = new Map<string, number>()

  return files.map((file) => {
    const existing = counter.get(file.fileName) ?? 0
    counter.set(file.fileName, existing + 1)

    if (existing === 0) {
      return file
    }

    const { baseName, extension } = splitFileName(file.fileName)
    const deduplicatedName = extension ? `${baseName}_${existing}.${extension}` : `${baseName}_${existing}`
    return {
      ...file,
      fileName: deduplicatedName
    }
  })
}

export const createZipStream = (files: CompressedImageResult[]): NodeJS.ReadableStream => {
  const archive = archiver('zip', {
    zlib: { level: 9 }
  })
  const passthrough = new PassThrough()

  archive.on('error', (error: Error) => {
    passthrough.destroy(error)
  })

  archive.pipe(passthrough)
  for (const file of withUniqueNames(files)) {
    archive.append(file.buffer, { name: file.fileName })
  }

  void archive.finalize()
  return passthrough
}
