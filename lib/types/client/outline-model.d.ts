export type OutlineLanguage = 'java' | 'c' | 'cpp' | 'go' | 'rust' | 'python' | 'javascript' | 'typescript' | 'unknown';
export type OutlineKind = 'class' | 'interface' | 'struct' | 'enum' | 'trait' | 'impl' | 'namespace' | 'module' | 'function' | 'method' | 'constructor' | 'field' | 'variable' | 'type' | 'macro';
export interface OutlineEntry {
    name: string;
    kind: OutlineKind;
    /** 1-based 行号（与 `revealRange` 同一套语义）。 */
    line: number;
    /** 嵌套层数，0 = 顶层。用缩进表达嵌套，不暴露大括号深度。 */
    depth: number;
    /** 直接外层类型/命名空间的名字（没有就是顶层）。 */
    container?: string;
}
export interface OutlineResult {
    language: OutlineLanguage;
    entries: OutlineEntry[];
    /** 扫描到的符号总数；可能大于 `entries.length`（被上限截断）。 */
    total: number;
    truncated: boolean;
    /** 语言未识别：条目是按缩进 + 关键字猜的，UI 必须标注。 */
    guessed: boolean;
}
/**
 * 单个文件最多列出的条目数。
 *
 * 20k 行的 Java 文件大约几百个符号，5000 已经远超真实代码；设上限是为了让病态
 * 输入（生成代码、压缩成一行的 JSON 式脚本）不会把 DOM 拖垮，同时 `total` 仍然
 * 报出真实数量，截断不撒谎。
 */
export declare const OUTLINE_MAX_ENTRIES = 5000;
/** 面板一次渲染的候选上限（过滤后）。 */
export declare const OUTLINE_RESULT_LIMIT = 300;
/** 由远端路径判断语言；不认识就返回 `unknown`（走降级大纲）。 */
export declare function outlineLanguageOf(path: string): OutlineLanguage;
/**
 * 把注释与字符串逐字符替换成空格（换行保留），返回按行切好的副本。
 *
 * 「长度不变」很重要：任何后续的行内偏移都还对得上原文件，行号也直接来自下标。
 * 状态机是近似的（C++ 原始字符串、Java 文本块、JS 正则字面量不特殊处理），目标
 * 是让「注释/字符串里的伪符号」不出现，不是做词法分析。
 */
export declare function maskSource(text: string, language: OutlineLanguage): string[];
/**
 * 从源文本生成大纲。
 *
 * `text` 必须是**实时缓冲区**（dirty 时不是 `tab.text`）；行号 1-based 直接对应
 * `CodeEditorHandle.revealRange`。
 */
export declare function buildOutline(text: string, path: string): OutlineResult;
/**
 * 按查询过滤并排序符号。
 *
 * 空查询 = 源码顺序（大纲的默认视图）；有查询时复用 quick open 的 `fuzzyScore`
 * 打分，同分按行号升序 —— 排序必须确定，否则两次相同的输入会闪出两种顺序。
 * 名字不匹配但 `容器.名字` 匹配（用户常敲 `Foo.bar`）时也算命中。
 */
export declare function rankOutline(query: string, entries: readonly OutlineEntry[], limit: number): {
    hits: OutlineEntry[];
    truncated: boolean;
};
