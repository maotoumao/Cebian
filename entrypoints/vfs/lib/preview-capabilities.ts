/**
 * 预览能力开关——按构建目标在编译期定死，供视图与页头共同引用。
 */

/** HTML 预览能否运行脚本。Chromium 有 manifest `sandbox.pages`，走沙箱代理页可跑脚本；
 *  Firefox 不支持 sandbox 页，只能做无脚本的静态渲染。 */
const supportsHtmlPreviewScripts: boolean = !import.meta.env.FIREFOX;

export { supportsHtmlPreviewScripts };
