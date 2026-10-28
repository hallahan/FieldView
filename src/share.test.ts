import { describe, expect, it, vi } from 'vitest';

vi.mock('./config', () => ({ AUTH_URL: 'https://auth.example.workers.dev' }));
const { describeAccess, shareFromLocation } = await import('./share');

describe('share links', () => {
  const secret = 'gD1RcUwPdAeUcGrL6nypzr_Lf_I3woEDwqCsMxiRVCX';
  it('finds the secret after the #', () => {
    expect(shareFromLocation(`#share=${secret}`)).toBe(secret);
    expect(shareFromLocation(`#x=1&share=${secret}`)).toBe(secret);
    expect(shareFromLocation('#share=short')).toBeUndefined();
    expect(shareFromLocation('')).toBeUndefined();
  });
  it('describes what a link allows', () => {
    expect(describeAccess({ upload: true })).toBe('view, download and upload');
    expect(describeAccess({ upload: false, job: 'jobs/a/a.jxl' })).toBe('view and download');
  });
});
