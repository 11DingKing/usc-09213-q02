// 可注入时钟：业务时间一律来自时钟，便于测试与恢复后按持久化时间戳继续计时。

export class SystemClock {
  now() {
    return Date.now();
  }
}

export class ManualClock {
  constructor(startMs = Date.now()) {
    this.t = startMs;
  }
  now() {
    return this.t;
  }
  advance(ms) {
    this.t += ms;
    return this.t;
  }
  set(ms) {
    this.t = ms;
  }
}

export const iso = (ms) => new Date(ms).toISOString();
export const parseTime = (value) => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`无效时间: ${value}`);
  return ms;
};
