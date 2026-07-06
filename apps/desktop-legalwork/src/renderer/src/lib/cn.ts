export type ClassValue = string | number | boolean | undefined | null | ClassValue[]

function flatten(values: ClassValue[]): string[] {
  const result: string[] = []
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      result.push(value.trim())
    } else if (typeof value === 'number') {
      result.push(String(value))
    } else if (Array.isArray(value)) {
      result.push(...flatten(value))
    }
  }
  return result
}

export function cn(...inputs: ClassValue[]): string {
  return flatten(inputs).join(' ')
}
