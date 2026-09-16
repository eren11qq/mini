// P2 SGR 常量叶子:ANSI 码唯一出处,零 import 回指(单向契约 ansi.test 钉死)。
// 值码点级钉死;ITALIC 尚无消费者,C12 markdown 斜体用(卡列收编)。
export const B = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const RED = "\x1b[31m"; // C19 diff − 行
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const BG = "\x1b[48;5;238m"; // C23 user 灰底带(256 色深灰;RESET 关)
export const RESET = "\x1b[0m";
