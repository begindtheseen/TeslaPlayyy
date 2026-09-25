import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeInput } from '../lib/youtubeUrl.js';

test('parses common YouTube link forms', () => {
  for (const s of ['aqz-KE-bpKQ', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=10', 'youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtu.be/aqz-KE-bpKQ?si=x',
    'https://m.youtube.com/watch?v=aqz-KE-bpKQ', 'https://www.youtube.com/shorts/aqz-KE-bpKQ', 'https://www.youtube.com/embed/aqz-KE-bpKQ', 'https://www.youtube.com/live/aqz-KE-bpKQ'])
    assert.equal(parseYouTubeInput(s), 'aqz-KE-bpKQ', s);
  for (const s of ['cats', 'big buck bunny', 'https://evil.com/watch?v=aqz-KE-bpKQ', 'https://youtube.com/watch?v=short', ''])
    assert.equal(parseYouTubeInput(s), null, s);
});
