import { describe, expect, it } from "vitest";
import { filenameStamp, localDate } from "./time.ts";

// 卡 3(ADR-004):两份日期孪生的共用 pad 收成一处(cli.ts localDate 给 system prompt,
// session-manager stamp 给会话文件名)。期望值 = 本地墙上时间字面量:实现若退回 toISOString(UTC),
// 补零/分隔符与跨天例子必红。Date 用本地分量构造 → 断言与机器时区无关。

describe("util/time", () => {
  it("localDate:本地日期 YYYY-MM-DD,月/日补零", () => {
    expect(localDate(new Date(2026, 8, 5, 20, 30, 0))).toBe("2026-09-05");
    expect(localDate(new Date(2026, 0, 1))).toBe("2026-01-01");
  });

  it("filenameStamp:会话文件名戳 YYYY-MM-DDTHH-mm-ss(时分秒补零,无冒号)", () => {
    expect(filenameStamp(new Date(2026, 8, 5, 8, 7, 6))).toBe("2026-09-05T08-07-06");
  });
});
