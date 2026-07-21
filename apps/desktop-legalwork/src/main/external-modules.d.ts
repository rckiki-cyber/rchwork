declare module 'mammoth' {
  export function extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }>
}

declare module 'pdf-parse' {
  function pdfParse(buffer: Buffer): Promise<{ text?: string }>
  export default pdfParse
}
