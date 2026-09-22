import { createApp } from "./app.mjs";

export function createServer(options = {}) {
  return createApp(options).server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const dataDir = process.env.DESK_DATA_DIR ?? "./data";
  const app = createApp({ dataDir });
  const port = Number(process.env.PORT ?? 8000);
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`非洲驻华记者台服务已启动: http://127.0.0.1:${port} (数据目录: ${dataDir})`);
  });
}
