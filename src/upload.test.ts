// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJxl } from './jxl';
import { jobFolder, keptAlongsideName, safeFileName, stamp, stampTime } from './layout';
import { applyPlacement, initialPlacement } from './placement';
import { addItems, footprint, jobName, referencedMedia, summarize } from './upload';

const sample = readFileSync(resolve(__dirname, '../public/sample.jxl'), 'utf8');
const local = readFileSync(resolve(__dirname, '../public/sample-local.jxl'), 'utf8');

describe('bucket layout', () => {
  it('stamps uploads in UTC, readable and sortable', () => {
    expect(stamp(new Date('2026-10-28T21:36:27.912Z'))).toBe('2026-10-28T213627Z');
    expect(stampTime('2026-10-28T213627Z')).toBe('2026-10-28T21:36:27Z');
  });

  it('keeps job names readable as folder names', () => {
    expect(jobFolder('25-050_GuardrailTopoNH4')).toBe('25-050_GuardrailTopoNH4');
    expect(jobFolder('Walnut Creek Topo (sample)')).toBe('Walnut Creek Topo (sample)');
    expect(jobFolder('A/B\\C: "x"?')).toBe('A_B_C_ _x_');
    expect(jobFolder('../..')).toBe('_..');
    expect(jobFolder('   ')).toBe('job');
  });

  it('names a changed photo by when it came in', () => {
    expect(keptAlongsideName('IMG_0001.jpg', '2026-10-28T213627Z')).toBe('IMG_0001 (2026-10-28T213627Z).jpg');
    expect(safeFileName('C:\\Trimble\\Job Files\\IMG 1.JPG')).toBe('IMG 1.JPG');
  });
});

describe('getting an upload ready', () => {
  it('summarises a job for the Jobs list', () => {
    const doc = parseJxl(sample);
    expect(jobName(doc, 'x.jxl')).toBe('Walnut Creek Topo (sample)');
    expect(jobName(undefined, 'Guardrail.job')).toBe('Guardrail');
    const s = summarize(doc);
    expect(s.pointCount).toBe(29);
    expect(s.format).toBe('jxl');
    const [w, so, e, n] = s.bbox!;
    expect(s.center![0]).toBeGreaterThan(w);
    expect(s.center![0]).toBeLessThan(e);
    expect(s.center![1]).toBeGreaterThan(so);
    expect(s.center![1]).toBeLessThan(n);
  });

  it("doesn't put a job shown in its own coordinates at 0°, 0°", () => {
    const doc = parseJxl(local);
    applyPlacement(doc.points, initialPlacement(doc.points, 0, 0)!, 'Local');
    expect(footprint(doc)).toBeUndefined();
    doc.placement = initialPlacement(doc.points, 37.9, -122.06);
    const fp = footprint(doc)!;
    expect(fp.center[0]).toBeCloseTo(-122.06, 3);
    expect(fp.center[1]).toBeCloseTo(37.9, 3);
  });

  it('finds the photos a job mentions', () => {
    expect(referencedMedia('<Value>IMG_0001.JPG</Value><Value>C:\\Jobs\\DSC 2.jpg</Value><x>IMG_0001.jpg</x><v>notes.pdf</v>')).toEqual(['IMG_0001.JPG', '2.jpg', 'notes.pdf']);
    expect(referencedMedia(sample)).toEqual([]);
  });

  it('sorts files into job files and media, a later pick replacing an earlier one', () => {
    let items = addItems([], [new File(['a'], 'IMG_1.jpg'), new File(['j'], 'Topo.job')]);
    items = addItems(items, [new File(['b'], 'img_1.JPG')]);
    expect(items.map((i) => [i.name, i.kind])).toEqual([
      ['img_1.JPG', 'media'],
      ['Topo.job', 'job'],
    ]);
  });
});
