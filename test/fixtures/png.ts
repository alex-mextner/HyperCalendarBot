// PNG header fixtures for transport limits; Chromium proof supplies fully encoded image bytes.
export function png(width = 1080, height = 800, bytes = 33): Buffer {
  const buffer = Buffer.alloc(bytes);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
