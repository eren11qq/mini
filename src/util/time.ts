// 日期字符串单源(卡 3 / ADR-004):原本 cli.ts 的 localDate 与 session-manager.ts 的 stamp 各写一份
// pad + 本地取时,同坑同注释。两处格式本就不同(prompt 要日期、文件名要日期+时间且不能用冒号),
// 同源的是「本地墙上时间 + 补零」,故合并成本文件、保留两个出口。
// 关键:一律用 getFullYear/getMonth/getDate(本地时区),不用 toISOString —— 那是 UTC,
// 东八区晚上跨天后第二天会少一天。入参可注入(缺省 = 现在),测试钉字面量。
const p = (n: number): string => String(n).padStart(2, "0");

/** 本地日期 `YYYY-MM-DD`(system prompt 的 `<env>` date 段)。 */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时间戳 `YYYY-MM-DDTHH-mm-ss`(会话文件名;无冒号 = 文件名安全)。 */
export function filenameStamp(d = new Date()): string {
  return `${localDate(d)}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
