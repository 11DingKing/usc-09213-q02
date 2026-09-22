/**
 * 安全单调时钟：进程重启后，当前时间只增不减。
 * 时间戳来自可信服务器时钟，绝不采用客户端提供的时间作为当前时间，
 * 因此离线设备即使调整本地时钟也不能缩短确认期限或授权有效期。
 * 高水位通过账本提交持久化，系统恢复后继续安全计时。
 */
export class Clock {
  constructor(getWallNow, highWaterMark = 0) {
    this.getWallNow = getWallNow;
    this.highWaterMark = highWaterMark;
  }

  now() {
    const wall = this.getWallNow();
    if (wall > this.highWaterMark) this.highWaterMark = wall;
    return this.highWaterMark;
  }

  /** 重放历史时推进水位，但不影响后续真实时间。 */
  observe(timestamp) {
    if (timestamp > this.highWaterMark) this.highWaterMark = timestamp;
  }
}
