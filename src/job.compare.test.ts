// @vitest-environment jsdom
//
// Checks the JOB reader against JobXML exported from the same job. Real jobs
// are client data and stay out of the repository, so this only runs when
// JOB_PAIRS names a folder of matching NAME.job + NAME.jxl files:
//
//   JOB_PAIRS=~/jobs npx vitest run src/job.compare.test.ts
//
// A JXL exported earlier than its JOB is fine: points the JXL doesn't have yet
// are skipped.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJob } from './job';
import { parseJxl, type JxlPoint } from './jxl';

const dir = process.env.JOB_PAIRS;
const pairs = dir ? readdirSync(dir).filter((f) => /\.job$/i.test(f)).map((f) => f.replace(/\.job$/i, '')) : [];

/** Metres on the ground for a lat/lon difference in degrees. */
function horizontal(a: JxlPoint, b: JxlPoint): number {
  const dn = (a.coords.lat! - b.coords.lat!) * 111_130;
  const de = (a.coords.lon! - b.coords.lon!) * 111_130 * Math.cos((a.coords.lat! * Math.PI) / 180);
  return Math.hypot(dn, de);
}

describe.skipIf(!pairs.length)('JOB against JXL', () => {
  for (const name of pairs) {
    it(name, () => {
      const job = parseJob(new Uint8Array(readFileSync(join(dir!, `${name}.job`))));
      const jxl = parseJxl(readFileSync(join(dir!, `${name}.jxl`), 'utf8'));
      const byId = new Map(job.points.map((p) => [p.id, p]));
      const problems: string[] = [];
      let compared = 0;
      let worst = 0;
      let worstGrid = 0;
      for (const want of jxl.points) {
        const got = byId.get(want.id);
        if (!got) {
          problems.push(`${want.name}: missing`);
          continue;
        }
        compared++;
        const diff = (what: string, a: unknown, b: unknown) => {
          if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${want.name} ${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
        };
        diff('name', got.name, want.name);
        diff('code', got.code, want.code);
        diff('deleted', got.deleted, want.deleted);
        diff('method', got.method, want.method);
        diff('survey method', got.surveyMethod, want.surveyMethod);
        diff('classification', got.classification, want.classification);
        diff('type', got.type, want.type);
        // Older Access versions also list codes without attributes (BL, EL...)
        // as features; newer ones don't, and neither does the JOB reader.
        // Photo paths use a backslash or a slash depending on the version.
        const withAttributes = (p: JxlPoint) =>
          JSON.parse(JSON.stringify(p.features.filter((f) => Object.keys(f.attributes).length)).replace(/\\\\/g, '/'));
        diff('features', withAttributes(got), withAttributes(want));
        diff('stored', got.stored, want.stored);
        if (want.coords.lat !== undefined) {
          if (got.coords.lat === undefined) problems.push(`${want.name}: no position`);
          else {
            const h = horizontal(got, want);
            const v = Math.abs((got.coords.height ?? NaN) - (want.coords.height ?? NaN));
            worst = Math.max(worst, h, v);
            if (!(h < 0.001 && v < 0.001)) problems.push(`${want.name}: off by ${h.toFixed(4)} m horizontally, ${v.toFixed(4)} m vertically`);
          }
        }
        if (want.coords.north !== undefined && got.coords.north !== undefined) {
          const g = Math.hypot(got.coords.north - want.coords.north, got.coords.east! - want.coords.east!);
          worstGrid = Math.max(worstGrid, g);
          if (!(g < 0.001)) problems.push(`${want.name}: grid off by ${g.toFixed(4)} m`);
        }
      }
      console.log(`${name}: ${compared} of ${jxl.points.length} JXL points compared, ${job.points.length} in the JOB; worst position ${(worst * 1000).toFixed(2)} mm, grid ${(worstGrid * 1000).toFixed(2)} mm`);
      expect(problems.slice(0, 40)).toEqual([]);
    });
  }
});
