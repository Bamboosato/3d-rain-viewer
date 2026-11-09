import { vi } from 'vitest';

// happy-dom での HTMLCanvasElement getContext('2d') モック
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type === '2d') {
      return {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(1024 * 1280 * 4),
          width: 1024,
          height: 1280,
        })),
        putImageData: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
      } as any;
    }
    return null;
  };

  HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,fakePngDataUrl';
  };
}
