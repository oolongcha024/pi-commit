// Offline presentation only: no app, agent, Git, configuration or editor calls.
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createTerminal } from "../src/terminal.js";
import { TerminalRenderer } from "../src/ui.js";
import { promptContent } from "../src/ui-content.js";
import { type Scenario, scenarios } from "./ui-scenarios.js";

async function main() {
  const { values } = parseArgs({
    options: {
      scene: { type: "string" },
      all: { type: "boolean" },
      static: { type: "boolean" },
      list: { type: "boolean" },
      width: { type: "string" },
      "no-color": { type: "boolean" },
      ascii: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: pnpm ui [options]

离线 UI 调试，不调用 LLM、Git 或外部编辑器。
默认在终端中交互切换场景；重定向输出时展示全部静态场景。

  --list           列出场景名称
  --scene <name>   直接打开指定场景
  --all            输出全部静态场景
  --static         输出静态场景后退出
  --width <n>      模拟终端列宽（至少 20）
  --no-color       关闭 ANSI 颜色
  --ascii          使用 ASCII 装饰（消息内容保持不变）
  --help, -h       显示帮助

交互模式：输入场景名称或编号跳转，n/p 切换，回车重播，q 退出。
场景中的 y/e/r 等操作仅用于展示，不执行实际业务操作。`);
    return;
  }
  const list = () =>
    scenarios.forEach((s, i) => {
      console.log(`${i + 1}. ${s.id} — ${s.label}`);
    });
  if (values.list) {
    list();
    return;
  }
  const columns = values.width === undefined ? undefined : Number(values.width);
  if (
    columns !== undefined &&
    (!Number.isInteger(columns) || columns < 20 || columns > 1000)
  ) {
    throw new Error("--width 必须为 20 到 1000 之间的整数。");
  }
  const selected = values.scene
    ? scenarios.findIndex((s) => s.id === values.scene)
    : 3;
  const selectedScene = scenarios[selected];
  if (!selectedScene)
    throw new Error(`未知场景：${values.scene}。使用 --list 查看可用场景。`);
  const options = {
    columns,
    color: values["no-color"] ? false : undefined,
    unicode: values.ascii ? false : undefined,
  };
  const interactive =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !values.all &&
    !values.static;
  if (!interactive) {
    const view = new TerminalRenderer({
      columns: columns ?? (process.stdout.columns || 80),
      color:
        !values["no-color"] &&
        Boolean(process.stdout.isTTY) &&
        process.env.NO_COLOR === undefined &&
        process.env.FORCE_COLOR !== "0" &&
        process.env.TERM !== "dumb",
      unicode: !values.ascii && process.env.TERM !== "dumb",
    });
    const write = (text: string) => process.stdout.write(text);
    const render = (scene: Scenario) => {
      write(`\n=== ${scene.id} · ${scene.label} ===\n`);
      scene.show({
        show: (text, tone) => {
          write(`${view.notice(text, tone)}\n`);
        },
        header: (info) => {
          write(`${view.header(info)}\n`);
        },
        draft: (message) => {
          write(view.draft(message));
        },
        status: (message) => {
          write(`${view.status(message, 2300)}\n`);
          return () => {};
        },
      });
      if (scene.prompt) {
        const { hint, actions } = promptContent(scene.prompt);
        if (actions) write(`${view.actions(actions)}\n`);
        write(`${view.prompt()}${view.placeholder(hint)}\n`);
      }
    };
    for (const scene of values.scene && !values.all
      ? [selectedScene]
      : scenarios)
      render(scene);
    return;
  }

  const controller = new AbortController();
  const terminal = createTerminal(controller, options);
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let index = selected;
  try {
    while (!controller.signal.aborted) {
      const scene = scenarios[index];
      if (!scene) throw new Error("场景不存在。");
      if (process.env.TERM !== "dumb")
        process.stdout.write("\u001b[2J\u001b[H");
      console.log(
        `UI 预览（模拟数据） · ${index + 1}/${scenarios.length} · ${scene.id} · ${scene.label}`,
      );
      console.log(
        "输入名称/编号跳转，n/p 切换，回车重播，l 列表，q 退出；业务操作键仅展示。\n",
      );
      const stop = scene.show(terminal);
      if (stop) {
        try {
          await setTimeout(1800, undefined, { signal: controller.signal });
        } finally {
          stop();
        }
      }
      const prompt = scene.prompt
        ? promptContent(scene.prompt)
        : { hint: "n 下一场景 · p 上一场景 · q 退出" };
      const input = (await terminal.ask(prompt.hint, prompt.actions)).trim();
      if (input === "q") break;
      if (input === "n") index = (index + 1) % scenarios.length;
      else if (input === "p")
        index = (index + scenarios.length - 1) % scenarios.length;
      else if (input === "l") {
        list();
        await terminal.ask("回车返回预览");
      } else if (input) {
        const next = /^\d+$/u.test(input)
          ? Number(input) - 1
          : scenarios.findIndex((s) => s.id === input);
        if (next >= 0 && next < scenarios.length) index = next;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    terminal.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
