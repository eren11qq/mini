// C9 纯缝:斜杠命令注册表。加命令 = 往表里登记一条,cli 分发与 TUI 补全都只读这张表。
// 分发语义 = 首 token 精确命中 "/"+name,余下 trim 作 args(多余参数交 handler 自取或忽略)。
// 本模块零 I/O 零状态:handler 闭包在 cli 组装层造,键盘接线在 tui.ts,均不在单测缝内(W2)。
export interface SlashCommand {
  name: string; // 不含前导 "/"
  description: string; // 一行说明,补全弹层直接印
  usage?: string; // 可收参数才写(如 "<alias>");TUI 补全据此在名字后跟一个空格
  run: (args: string) => void | Promise<void>;
}

export interface CommandHit {
  command: SlashCommand;
  args: string;
}

// 补全弹层候选:输入串(含前导 "/")按名字前缀过滤,保持登记序 = 展示序。
export function filterCommands(commands: readonly SlashCommand[], typed: string): SlashCommand[] {
  if (!typed.startsWith("/")) return [];
  return commands.filter((c) => `/${c.name}`.startsWith(typed));
}

export function matchCommand(commands: SlashCommand[], line: string): CommandHit | null {
  if (!line.startsWith("/")) return null;
  const sp = line.search(/\s/);
  const head = sp < 0 ? line : line.slice(0, sp);
  const command = commands.find((c) => `/${c.name}` === head);
  if (!command) return null;
  return { command, args: sp < 0 ? "" : line.slice(sp + 1).trim() };
}
