// Image helper: downscale a picked file to a square-ish data URL.
//
// Contract
//   - `compressImage(file, maxSize)` reads `file` and returns a Promise of a
//     `data:` URL no larger than `maxSize` on its long edge. It falls back to
//     the raw data URL when the image cannot be decoded, so a caller never
//     loses the user's choice to a canvas failure.
//   - The original bytes are read once internally for that fallback.

// Exports
//   compressImage(file, maxSize) -> Promise<string>

const DEFAULT_MAX = 384;
const QUALITY = 0.85;

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
    reader.readAsDataURL(blob);
  });
}



/**
 * Scales the image so its long edge is at most `maxSize` and re-encodes it as
 * WebP, falling back to JPEG and then to the untouched data URL.
 */
export async function compressImage(file, maxSize = DEFAULT_MAX) {
  const original = await readAsDataUrl(file);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        let { width, height } = image;
        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else if (height > maxSize) {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/webp", QUALITY) || canvas.toDataURL("image/jpeg", QUALITY) || original);
      } catch (_) {
        // A tainted or zero-sized canvas: keep the original bytes.
        resolve(original);
      }
    };
    image.onerror = () => resolve(original);
    image.src = original;
  });
}
