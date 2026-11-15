import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../../src/infra/json.js';

describe('BigInt 序列化（单元）', () => {
  it('TC-011 分区表自增 id 按字符串输出且不抛错', () => {
    // 超过 2^53 的 BIGINT 主键，转 Number 会丢精度
    const payload = { id: 9007199254740993n, nested: { ids: [1n, 2n] } };

    expect(() => stringifyJson(payload)).not.toThrow();
    expect(JSON.parse(stringifyJson(payload))).toEqual({
      id: '9007199254740993',
      nested: { ids: ['1', '2'] },
    });
  });

  it('TC-011 非 BigInt 字段保持原样', () => {
    const payload = { id: 'run_1', seq: 3, ok: true, data: { level: 'info' } };

    expect(JSON.parse(stringifyJson(payload))).toEqual(payload);
  });
});
