/**
 * Vue 2 适配器。
 *
 * Vue 2 没有 provide/inject 的插件级写法（2.7 之前也没有组合式 API），
 * 因此这里采用 Vue 2 惯用的 install + 原型挂载方式，不 import 'vue'，
 * 由调用方传入 Vue 构造器，从而在任何环境都能安全加载本文件。
 *
 * 用法（main.js）：
 *   import Vue from 'vue';
 *   import App from './App.vue';
 *   import { createAnnotations } from './.zw-web-annotations/runtime/adapters/vue2.mjs';
 *
 *   Vue.use(createAnnotations());
 *   new Vue({ render: h => h(App) }).$mount('#app');
 */
import { mountAnnotator } from '../client/annotator.mjs';
import { storeBridge } from './bridge.mjs';

/** 与 Vue3 适配器同构的 controller，保证两版 API 一致。 */
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
    start() { return this.mount().start(); },
    stop() { return this.instance?.stop(); },
    count() { return this.instance ? this.instance.count() : 0; },
  };
}

/**
 * Vue 2 插件。Vue.use(createAnnotations()) 即可。
 * 通过 Vue.prototype.$annotations 暴露，同时在 root 实例销毁时清理。
 */
export function createAnnotations(options = {}) {
  const controller = createController(options);

  const install = Vue => {
    if (typeof Vue === 'undefined' || !Vue) {
      throw new Error('createAnnotations() 需要 Vue 2 构造器：Vue.use(createAnnotations())');
    }
    if (Vue.prototype.$annotations) return; // 幂等：重复 use 不重复安装

    Vue.prototype.$annotations = controller;

    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    if (options.autoMount !== false) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => controller.mount(), { once: true });
      } else {
        controller.mount();
      }
    }

    Vue.mixin({
      destroyed() {
        if (this.$root === this) controller.unmount();
      },
    });
  };

  // 同时兼容 Vue.use(plugin) 与直接调用 createAnnotations(Vue)
  install.install = install;
  install.controller = controller;
  return install;
}

/** 选项式 API：在组件内 this.$annotations 直接可用。 */
export function useAnnotations(vm) {
  const controller = vm?.$annotations || vm?.$root?.$annotations;
  if (!controller) {
    throw new Error('useAnnotations() 需要先 Vue.use(createAnnotations())');
  }
  return controller;
}

export default createAnnotations;
