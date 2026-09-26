import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the route's real function without importing Next.js or its runtime.
const source = readFileSync(new URL('../src/app/api/upload-request/route.ts', import.meta.url), 'utf8');
const match = source.match(/function safeSlug\(value: string, fallback: string\) \{[\s\S]*?\n\}/);
assert.ok(match, 'Upload request route must expose safeSlug');
const safeSlug = vm.runInNewContext(`(${match[0].replaceAll(': string', '')})`);
const fallback = 'youtube-upload-request';
for (const title of [
  '구독자 1만 명, 감사합니다. 그리고 앞으로의 이야기',
  'A'.repeat(47) + '. truncated title',
  '...',
  '한국어 제목',
]) {
  const slug = safeSlug(title, fallback);
  assert.ok(slug.length > 0 && slug.length <= 48);
  assert.doesNotMatch(slug, /[. ]$/u, 'Windows strips trailing dots/spaces from path components');
  assert.doesNotMatch(slug, /[\\/:*?"<>|]/u);
}
assert.equal(safeSlug('release-1.2-preview', fallback), 'release-1.2-preview');
assert.equal(safeSlug('...', fallback), fallback);
console.log('WINDOWS_REQUEST_SLUG_SMOKE_OK');
