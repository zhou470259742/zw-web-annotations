/**
 * Vue 3 适配器（默认组件形态）。
 *
 * 核心标注器 client/annotator.mjs 是框架无关的，挂到 document 即可运行，
 * 因此 Vue 适配器只负责生命周期与依赖注入：
 * 1. 开发环境挂载标注器，根组件卸载时清理；
 * 2. 通过 provide 暴露 controller，业务代码可手动开关。
 *
 * 用法（main.js）：
 *   import { createApp } from 'vue';
 *   import App from './App.vue';
 *   import { createAnnotations } from './.zwa/runtime/adapters/vue3.mjs';
 *
 *   const app = createApp(App);
 *   app.use(createAnnotations());
 *   app.mount('#app');
 */
import { inject } from 'vue';
import { mountAnnotator } from '../client/annotator.mjs';
import { storeBridge } from './bridge.mjs';

export const ANNOTATIONS_KEY = 'zcode-annotations';

/** controller 封装挂载/卸载，保证热更新时不会叠加多个实例。 */
export function createController(options = {}) {
  let instance = null;
  return {
    mount() {
      if (instance) return instance;
      instance = mountAnnotator({ ...storeBridge(options), ...options });
      return instance;
    },
    unmount() {
      if (!instance) return false;
      instance.destroy?.();
      instance = null;
      return true;
    },
    get instance() {
      return instance;
    },
    /** 转发常用 API，业务代码可 controller.start() 等 */
    start() { return this.mount().start(); },
    stop() { return this.instance?.stop(); },
    count() { return this.instance ? this.instance.count() : 0; },
  };
}

/**
 * Vue 3 插件。默认自动挂载；传 autoMount:false 可只注册、不自动挂载。
 */
export function createAnnotations(options = {}) {
  return {
    install(app) {
      const controller = createController(options);
      app.provide(ANNOTATIONS_KEY, controller);
      app.config.globalProperties.$annotations = controller;

      if (typeof window === 'undefined' || typeof document === 'undefined') return;

      if (options.autoMount !== false) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => controller.mount(), { once: true });
        } else {
          controller.mount();
        }
      }

      // 根组件卸载时清理。用 mixin 而非 onUnmounted，
      // 因为插件安装时拿不到具体组件实例。
      app.mixin({
        unmounted() {
          if (this.$root === this) controller.unmount();
        },
      });
    },
  };
}

/**
 * 组合式 API：在 setup 中取得 controller。
 *   const annotations = useAnnotations();
 *   onMounted(() => annotations.mount());
 */
export function useAnnotations() {
  const controller = inject(ANNOTATIONS_KEY, null);
  if (!controller) {
    throw new Error('useAnnotations() 需要先 app.use(createAnnotations())');
  }
  return controller;
}

export default createAnnotations;
