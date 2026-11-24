/**
 * 符号大纲浮层：可筛选的符号列表 + ↑↓/Enter/点击跳转。
 *
 * 只在打开时挂载（父组件用 `undefined` 表示关闭），所以「关闭」就是卸载 —— 不会
 * 留下第二个 `isOpen` 状态要同步，也不会在关闭后留一个偷键盘的监听器。条目由
 * `outline-model.ts` 的纯函数产出；这里只负责像素、焦点和按键。
 *
 * PORTAL 到 `<body>`：编辑器有三种座位（侧栏 / 中间 / 浮窗），浮层若留在原 DOM
 * 里会被祖先的 `overflow: hidden` 裁掉。`.rvs-portal` 负责声明 `--rvs-*` token
 * 子集 —— portal 之后已经不在 `.rvs-root` 作用域内，缺了它颜色/边框全是空值。
 */
import { type ReactNode } from 'react';
import { type OutlineEntry } from './outline-model.ts';
export declare function OutlinePanel(props: {
    t: (key: string) => string;
    /** 远端绝对路径（判断语言 + 标题）。 */
    path: string;
    /** 实时缓冲区全文：dirty 时必须来自编辑器，不是 `tab.text`。 */
    text: string;
    onPick: (entry: OutlineEntry) => void;
    onClose: () => void;
}): ReactNode;
