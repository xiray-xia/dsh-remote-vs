/**
 * The editor token palette (VS Code Dark+ / Light+).
 *
 * Token colors are expressed as FIXED CLASS NAMES (`rvs-ck-*`) and the actual
 * colors live in `vsc.css`:
 *
 *  - CodeMirror's `HighlightStyle` normally emits generated class names
 *    (`ͼq`, `ͼ12`, …) together with an injected stylesheet. That pipeline can
 *    fail silently — every token renders in one color — and such a failure is
 *    invisible to a type checker.
 *  - With `class:` in the specs the emitted names are stable, so the colors
 *    come from the same stylesheet that demonstrably paints the rest of the UI,
 *    the light/dark switch is plain CSS, and the self-check harness can assert
 *    both halves of the contract (class emitted ↔ rule defined).
 *
 * This module intentionally imports no DOM-bearing package, so the harness can
 * run it in Node.
 */
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** Every class `vscodeHighlightStyle()` can emit (all must exist in vsc.css). */
export const TOKEN_CLASSES = [
  'rvs-ck-comment',
  'rvs-ck-keyword',
  'rvs-ck-control',
  'rvs-ck-string',
  'rvs-ck-regexp',
  'rvs-ck-number',
  'rvs-ck-constant',
  'rvs-ck-func',
  'rvs-ck-type',
  'rvs-ck-variable',
  'rvs-ck-attr',
  'rvs-ck-meta',
  'rvs-ck-punct',
  'rvs-ck-op',
  'rvs-ck-heading',
  'rvs-ck-em',
  'rvs-ck-link',
  'rvs-ck-strike',
  'rvs-ck-invalid',
] as const

export type TokenClass = typeof TOKEN_CLASSES[number]

/** Tag → fixed class mapping. Colors live in vsc.css, not here. */
export function vscodeHighlightStyle(): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'rvs-ck-comment' },
    { tag: [t.keyword, t.operatorKeyword, t.definitionKeyword], class: 'rvs-ck-keyword' },
    { tag: [t.modifier, t.controlKeyword, t.moduleKeyword], class: 'rvs-ck-control' },
    { tag: [t.string, t.special(t.string), t.docString], class: 'rvs-ck-string' },
    { tag: [t.regexp], class: 'rvs-ck-regexp' },
    { tag: [t.number, t.bool, t.null, t.atom], class: 'rvs-ck-number' },
    { tag: [t.constant(t.name), t.standard(t.name), t.self], class: 'rvs-ck-constant' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], class: 'rvs-ck-func' },
    { tag: [t.definition(t.function(t.variableName)), t.definition(t.function(t.propertyName))], class: 'rvs-ck-func' },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.tagName], class: 'rvs-ck-type' },
    { tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.definition(t.propertyName)], class: 'rvs-ck-variable' },
    { tag: [t.attributeName, t.attributeValue], class: 'rvs-ck-attr' },
    { tag: [t.meta, t.annotation, t.processingInstruction], class: 'rvs-ck-meta' },
    { tag: [t.punctuation, t.bracket, t.separator, t.paren, t.brace, t.squareBracket], class: 'rvs-ck-punct' },
    { tag: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator, t.logicOperator], class: 'rvs-ck-op' },
    { tag: [t.heading, t.strong], class: 'rvs-ck-heading' },
    { tag: [t.emphasis], class: 'rvs-ck-em' },
    { tag: [t.link, t.url], class: 'rvs-ck-link' },
    { tag: [t.strikethrough], class: 'rvs-ck-strike' },
    { tag: [t.invalid], class: 'rvs-ck-invalid' },
  ])
}

/** Chrome palette (background, gutters, selection) — the part CodeMirror themes. */
export interface Palette {
  bg: string
  fg: string
  gutterBg: string
  gutterFg: string
  activeLine: string
  activeGutter: string
  selection: string
  cursor: string
  lineHighlight: string
}

export const DARK: Palette = {
  bg: '#1e1e1e',
  fg: '#d4d4d4',
  gutterBg: '#1e1e1e',
  gutterFg: '#858585',
  activeLine: 'rgba(255, 255, 255, .045)',
  activeGutter: 'rgba(255, 255, 255, .08)',
  selection: '#264f78',
  cursor: '#aeafad',
  lineHighlight: '#2a2d2e',
}

export const LIGHT: Palette = {
  bg: '#ffffff',
  fg: '#000000',
  gutterBg: '#ffffff',
  gutterFg: '#237893',
  activeLine: 'rgba(0, 0, 0, .04)',
  activeGutter: 'rgba(0, 0, 0, .06)',
  selection: '#add6ff',
  cursor: '#000000',
  lineHighlight: '#f5f5f5',
}

export function paletteFor(dark: boolean): Palette {
  return dark ? DARK : LIGHT
}
