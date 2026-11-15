/**
 * BigInt 安全的 JSON 序列化。
 *
 * run_events.id / audit_logs.id 是 BIGINT 主键，Prisma 运行时返回 JS bigint，
 * 直接 JSON.stringify 会抛 `TypeError: Do not know how to serialize a BigInt`，
 * 把它塞进 HTTP 响应或 SSE 帧时必然踩到。
 *
 * 统一按十进制字符串输出：这两个 id 只作为游标与不透明标识使用，
 * 转 Number 会在超过 2^53 后丢精度。所有对外序列化的出口（REST 响应、SSE 帧）
 * 都必须走 stringifyJson / jsonReplacer。
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}
