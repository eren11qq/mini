// C17 /connect 向导纯 reducer(照 kilo dialog-provider API-key 分支,单 method 跳过多选)。
// 零 I/O 零状态:落盘/热切是 effect(submit),cli 消费;Esc 任意步 cancel,零落盘。
// 键路由接线在 tui.ts(第三等待态),数据(aliases/hint/mark)由 cli 注入 —— 同 C16「调用方注入,渲染层只画」。
export type ConnectState =
  | { step: "idle" }
  | { step: "pick"; sel: number; aliases: string[] }
  | { step: "keyIn"; alias: string; buf: string };

export type ConnectEvent =
  | { type: "open"; aliases: string[] }
  | { type: "up" }
  | { type: "down" }
  | { type: "enter" }
  | { type: "esc" }
  | { type: "char"; ch: string }
  | { type: "backspace" };

export type ConnectEffect = { type: "submit"; alias: string; key: string } | { type: "cancel" };

export interface ConnectStep {
  state: ConnectState;
  effect?: ConnectEffect;
}

export function reduceConnect(state: ConnectState, event: ConnectEvent): ConnectStep {
  switch (event.type) {
    case "open":
      if (state.step !== "idle") return { state };
      return { state: { step: "pick", sel: 0, aliases: event.aliases } };
    case "up":
    case "down": {
      if (state.step !== "pick") return { state };
      const n = state.aliases.length; // 厂商表恒非空(cli 注入),环绕取模不防 0(不可达场景不加防御,同 C16)
      const d = event.type === "down" ? 1 : n - 1;
      return { state: { ...state, sel: (state.sel + d) % n } };
    }
    case "char":
      if (state.step !== "keyIn") return { state };
      return { state: { ...state, buf: state.buf + event.ch } };
    case "backspace":
      if (state.step !== "keyIn") return { state };
      return { state: { ...state, buf: state.buf.slice(0, -1) } };
    case "esc":
      // 任意步取消:两步 Esc 均直接回 idle(非回退厂商层),cancel 意图交 cli 解 null。
      if (state.step === "idle") return { state };
      return { state: { step: "idle" }, effect: { type: "cancel" } };
    case "enter":
      if (state.step === "pick")
        return { state: { step: "keyIn", alias: state.aliases[state.sel]!, buf: "" } };
      if (state.step === "keyIn") {
        const key = state.buf.trim();
        if (key === "") return { state }; // 空 → 不关继续等(kilo)
        return { state: { step: "idle" }, effect: { type: "submit", alias: state.alias, key } };
      }
      return { state };
    default:
      return { state };
  }
}
