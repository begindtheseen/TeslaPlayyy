import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePlatform, classifyGpu } from '../lib/player/platform.js';

const TESLA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Tesla/2025.20.6';

test('delivery choice: Tesla Intel MCU -> muxed @30fps, AMD MCU -> dual, desktop -> dual, URL overrides win', () => {
  const intel = decidePlatform({ ua: TESLA, gpu: 'Mesa Intel(R) HD Graphics 505 (APL 3)', cores: 4 });
  assert.deepEqual([intel.mcu, intel.delivery, intel.maxFps, intel.maxHeight], ['intel', 'muxed', 30, 1080]);
  const amd = decidePlatform({ ua: TESLA, gpu: 'AMD Radeon Vega 8 Graphics (raven, LLVM 15.0.7, DRM 3.49)', cores: 8 });
  assert.deepEqual([amd.mcu, amd.delivery, amd.maxFps], ['amd', 'dual', 60]);
  assert.equal(decidePlatform({ ua: TESLA, gpu: '', cores: 4 }).delivery, 'muxed', 'unknown GPU with 4 cores is treated as MCU2');
  assert.equal(decidePlatform({ ua: 'Mozilla/5.0 Chrome/140', gpu: 'ANGLE (NVIDIA GeForce RTX 4070)', cores: 16 }).delivery, 'dual');
  assert.equal(decidePlatform({ ua: TESLA, gpu: 'AMD Radeon', search: '?intel=1' }).delivery, 'muxed');
  assert.equal(decidePlatform({ ua: TESLA, gpu: 'Intel HD 505', search: '?intel=0' }).delivery, 'dual');
  assert.equal(decidePlatform({ search: '?delivery=muxed&maxHeight=720&maxFps=30' }).maxHeight, 720);
  assert.equal(classifyGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))'), 'software');
});
