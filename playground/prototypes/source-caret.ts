export function columnCaret(line: string, column: number | undefined): string | undefined {
  if (column === undefined || !Number.isInteger(column) || column < 1 || column > line.length + 1)
    return undefined
  const firstToken = line.search(/\S/)
  if (column <= (firstToken === -1 ? line.length : firstToken))
    return undefined
  return `${line.slice(0, column - 1).replace(/[^\t]/g, ' ')}^`
}
