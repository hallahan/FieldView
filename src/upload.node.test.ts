// Blob and File as the browser has them (jsdom's lack arrayBuffer).
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { expandZips, sha256 } from './upload';

describe('upload files', () => {
  it('opens a zip of the job folder and skips the clutter', async () => {
    const zip = zipSync({
      'Job Files/IMG_1.jpg': new Uint8Array([1, 2, 3]),
      'Job Files/': new Uint8Array(),
      '__MACOSX/Job Files/._IMG_1.jpg': new Uint8Array([9]),
      'Job Files/.DS_Store': new Uint8Array([9]),
    });
    const files = await expandZips([new File([zip as Uint8Array<ArrayBuffer>], 'job.zip'), new File(['x'], 'a.jxl')]);
    expect(files.map((f) => f.name)).toEqual(['IMG_1.jpg', 'a.jxl']);
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('hashes like sha256sum', async () => {
    expect(await sha256(new Blob(['hello\n']))).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');
  });
});
