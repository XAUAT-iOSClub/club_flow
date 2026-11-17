-- Prisma 的 @updatedAt 只在客户端填充，裸 SQL / 脚本 / 数据修复写入时
-- updated_at 会撞 NOT NULL。给三张带 updated_at 的表补数据库默认值，
-- 让不经过 Prisma 的写入也能成立（Prisma 写入时仍会覆盖为当前时间）。
ALTER TABLE workflows ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE secrets ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE triggers ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
