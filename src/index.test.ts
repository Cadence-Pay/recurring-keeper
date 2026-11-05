import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('skeleton', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('recurring-keeper');
  });
});
