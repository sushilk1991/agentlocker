import { describe, expect, it } from 'vitest';
import { equalToken, matches, path } from '../src/security';

describe('canonical paths before grant matching', () => {
 it.each(['/a/file.txt', '/café/notes', '/日本語/🙂', '/file'])('accepts %s without changing it', value => {
  expect(path(value)).toBe(value);
 });
 it.each(['/', '/a/', '/café/'])('accepts folder %s', value => { expect(path(value, true)).toBe(value); });
 it.each([
  'a/file', '/a/../file', '/a/./file', '/a//file', '/a\\file', '/a\0file', '/a\nfile',
  '/a?file', '/a#file', '/a%2ffile', '/%252e%252e/file', '/cafe\u0301/file', '/a/\ud800', '/', '/a/',
 ])('rejects invalid file path %j', value => { expect(() => path(value)).toThrow('invalid path'); });
 it('rejects traversal after a single transport decode', () => {
  for (const query of ['%2F..%2Ffile', '%2F%252e%252e%2Ffile']) {
   const logical = new URLSearchParams('path=' + query).get('path')!;
   expect(() => path(logical)).toThrow();
  }
 });
 it('enforces UTF-8 byte limits for segments and whole paths', () => {
  expect(path('/' + 'a'.repeat(255))).toHaveLength(256);
  expect(() => path('/' + 'a'.repeat(256))).toThrow();
  expect(path('/' + 'é'.repeat(127))).toBe('/' + 'é'.repeat(127));
  expect(() => path('/' + 'é'.repeat(128))).toThrow();
  const limit = '/' + ['a'.repeat(255), 'b'.repeat(255), 'c'.repeat(255), 'd'.repeat(255)].join('/');
  expect(new TextEncoder().encode(limit)).toHaveLength(1024);
  expect(path(limit)).toBe(limit);
  expect(() => path(limit + 'd')).toThrow();
 });
 it('matches segment boundaries and refuses malformed stored prefixes', () => {
  expect(matches('/a/', '/a/file')).toBe(true);
  expect(matches('/a/', '/ab/file')).toBe(false);
  expect(matches('/a', '/ab/file')).toBe(false);
  expect(matches('/', 'relative')).toBe(false);
 });
 it('compares owner credentials without changing the values', async () => {
  expect(await equalToken('owner-secret', 'owner-secret')).toBe(true);
  expect(await equalToken('owner-secret', 'owner-secreu')).toBe(false);
  expect(await equalToken('owner-secret', 'owner-secret-extra')).toBe(false);
 });
});
