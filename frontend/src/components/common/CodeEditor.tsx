'use client';

import { useEffect, useMemo, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useTheme } from 'antd-style';

export type CodeLanguage = 'json' | 'text';

/**
 * CodeMirror 6, wrapped thin.
 *
 * No third-party React binding — the whole surface we need is "keep the doc in
 * step with a controlled value and re-theme on light/dark", which is 40 lines.
 * Colours come from antd tokens; nothing here hardcodes a hex.
 */
export function CodeEditor({
  value,
  onChange,
  language = 'json',
  readOnly = false,
  minHeight = 200,
  maxHeight = 480,
  placeholder,
  showLineNumbers = true,
}: {
  value: string;
  onChange?: (next: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  minHeight?: number;
  maxHeight?: number;
  placeholder?: string;
  showLineNumbers?: boolean;
}) {
  const token = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const themeCompartment = useMemo(() => new Compartment(), []);

  const themeExtension = useMemo<Extension>(() => {
    const dark = token.appearance === 'dark';
    const highlight = HighlightStyle.define([
      { tag: [t.propertyName, t.attributeName], color: token.colorPrimary },
      { tag: [t.string], color: token.colorSuccessTextActive },
      { tag: [t.number, t.bool, t.null], color: token.colorWarningTextActive },
      { tag: [t.keyword], color: token.colorInfoTextActive },
      { tag: [t.comment], color: token.colorTextQuaternary, fontStyle: 'italic' },
      { tag: [t.punctuation, t.brace, t.bracket], color: token.colorTextTertiary },
    ]);

    return [
      syntaxHighlighting(highlight),
      EditorView.theme(
        {
          '&': {
            fontSize: '12.5px',
            backgroundColor: token.colorFillQuaternary,
            color: token.colorText,
            borderRadius: `${token.borderRadius}px`,
            border: `1px solid ${token.colorBorderSecondary}`,
          },
          '&.cm-focused': { outline: 'none', borderColor: token.colorPrimaryBorderHover },
          '.cm-scroller': {
            fontFamily: token.fontFamilyCode,
            lineHeight: '1.65',
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
            overflow: 'auto',
          },
          '.cm-content': { padding: '8px 0', caretColor: token.colorText },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            border: 'none',
            color: token.colorTextQuaternary,
            paddingRight: '4px',
          },
          '.cm-activeLine': { backgroundColor: readOnly ? 'transparent' : token.colorFillTertiary },
          '.cm-activeLineGutter': { backgroundColor: 'transparent', color: token.colorTextTertiary },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
            backgroundColor: token.colorPrimaryBg,
          },
          '.cm-cursor': { borderLeftColor: token.colorText },
          '.cm-placeholder': { color: token.colorTextQuaternary },
          '.cm-tooltip': {
            backgroundColor: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: `${token.borderRadius}px`,
          },
        },
        { dark },
      ),
    ];
  }, [token, minHeight, maxHeight, readOnly]);

  // --- mount ---------------------------------------------------------------
  useEffect(() => {
    if (!host.current || view.current) return;

    const extensions: Extension[] = [
      history(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      indentUnit.of('  '),
      autocompletion(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      themeCompartment.of(themeExtension),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      }),
    ];
    if (showLineNumbers) extensions.push(lineNumbers(), foldGutter());
    if (language === 'json') extensions.push(json());
    if (placeholder) extensions.push(cmPlaceholder(placeholder));

    view.current = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });

    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // Mount-only: subsequent value/theme changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- controlled value ----------------------------------------------------
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  // --- re-theme in place ---------------------------------------------------
  useEffect(() => {
    view.current?.dispatch({ effects: themeCompartment.reconfigure(themeExtension) });
  }, [themeExtension, themeCompartment]);

  return <div ref={host} />;
}

/** `null` when the text parses, otherwise the first error message. */
export function jsonError(text: string): string | null {
  if (text.trim() === '') return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export { jsonParseLinter };
