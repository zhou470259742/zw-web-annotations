/**
 * 适配器共用的桥接配置。
 *
 * 标注组件默认走同源接口 /__zcode/annotations。不同框架/构建器的注入方式不同，
 * 这里统一把“接口前缀”和“是否走外部桥接服务”翻译成组件配置，
 * 避免每个框架适配器各写一份。
 */

/** 默认接口前缀，与 Vite 插件、http 适配器保持一致。 */
export const DEFAULT_ENDPOINT = '/__zcode/annotations';

/**
 * 生成传给 mountAnnotator 的桥接配置。
 * - 传 endpoint：直接使用；
 * - 传 bridgeUrl：使用外部桥接服务（内置浏览器注入方案）；
 * - 都不传：用默认同源前缀。
 */
export function storeBridge(options = {}) {
  const endpoint = options.bridgeUrl
    ? `${String(options.bridgeUrl).replace(/\/$/, '')}/api`
    : options.endpoint || DEFAULT_ENDPOINT;
  return { endpoint };
}
