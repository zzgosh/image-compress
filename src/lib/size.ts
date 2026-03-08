export const MEGABYTE = 1024 * 1024

const stripTrailingZeros = (value: string): string => value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')

export const formatMegabyteSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0MB'
  }

  const megabytes = bytes / MEGABYTE
  if (megabytes >= 100) {
    return `${stripTrailingZeros(megabytes.toFixed(0))}MB`
  }

  if (megabytes >= 10) {
    return `${stripTrailingZeros(megabytes.toFixed(1))}MB`
  }

  return `${stripTrailingZeros(Math.max(megabytes, 0.01).toFixed(2))}MB`
}
