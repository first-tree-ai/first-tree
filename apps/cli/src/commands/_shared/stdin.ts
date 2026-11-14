/** Shared cap for anything the CLI buffers from stdin or a message file. */
export const MAX_STDIN_BYTES = 5 * 1024 * 1024;

/** Buffer stdin (text only). Returns null when stdin is a TTY (no pipe). */
export function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}
