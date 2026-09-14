// T2 AC-T2-4:args JSON Schema 校验(loop 侧,run 之前;D1 ajv = 首个运行时依赖)。
// 照 pi validation.ts:341-349 —— 失败信息含逐条路径 + 原始 args 回显,模型自纠用。
// 无 try/catch:ajv.validate 本身不 throw;compile throw 仅限无效 schema(程序员错,该崩)。
// ajv 是 CJS 包:default import 在 nodenext 解析成 namespace(TS2351),走具名 exports.Ajv。
import { Ajv, type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap<object, ValidateFunction>();

// 返回 null = 通过;返回 string = 给模型看的错误文本。
export function validateArgs(schema: object, args: unknown): string | null {
  let v = cache.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    cache.set(schema, v);
  }
  if (v(args)) return null;
  const errs = (v.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
  return `invalid arguments: ${errs} — args=${JSON.stringify(args)}`;
}
