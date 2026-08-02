import React, { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import cmake from "highlight.js/lib/languages/cmake";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

type HighlightNode = {
  type: string;
  value?: string;
  properties?: { className?: string | string[] };
  children?: HighlightNode[];
};

export const MAX_HIGHLIGHTED_CODE_BYTES = 100 * 1024;

const CODE_LANGUAGE_OPTIONS = [
  { value: "plaintext", label: "Plain text" },
  { value: "javascript", label: "JavaScript / JSX" },
  { value: "typescript", label: "TypeScript / TSX" },
  { value: "json", label: "JSON" },
  { value: "html", label: "HTML / XML" },
  { value: "css", label: "CSS" },
  { value: "bash", label: "Shell / Bash" },
  { value: "powershell", label: "PowerShell" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "ini", label: "INI / Config" },
  { value: "nginx", label: "Nginx" },
  { value: "toml", label: "TOML" },
  { value: "makefile", label: "Makefile" },
  { value: "cmake", label: "CMake" },
  { value: "http", label: "HTTP" },
  { value: "sql", label: "SQL" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "dart", label: "Dart" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "scala", label: "Scala" },
  { value: "lua", label: "Lua" },
  { value: "r", label: "R" },
  { value: "protobuf", label: "Protocol Buffers" },
  { value: "yaml", label: "YAML" },
  { value: "markdown", label: "Markdown" },
] as const;

/** Display order is alphabetical by the English language label. */
export const CODE_LANGUAGES = [...CODE_LANGUAGE_OPTIONS].sort((left, right) =>
  left.label.localeCompare(right.label, "en", { sensitivity: "base" }),
);

const registeredGrammars = {
  bash,
  cmake,
  c,
  cpp,
  csharp,
  css,
  dart,
  dockerfile,
  go,
  http,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nginx,
  php,
  plaintext,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

const baseLowlight = createLowlight(registeredGrammars);
baseLowlight.registerAlias({
  bash: ["sh", "shell"],
  cmake: ["cmakelists"],
  csharp: ["cs", "dotnet"],
  dockerfile: ["docker"],
  ini: ["conf", "config", "properties", "sshd", "sshd_config", "toml", "tml"],
  javascript: ["js", "mjs", "cjs", "jsx"],
  plaintext: ["text", "txt", "plain"],
  powershell: ["ps", "ps1", "psm1", "pwsh"],
  protobuf: ["proto"],
  ruby: ["rb"],
  scala: ["sc"],
  typescript: ["ts", "tsx"],
  xml: ["html", "htm", "svg"],
  yaml: ["yml"],
});

function codeByteLength(code: string) {
  return typeof TextEncoder === "undefined" ? code.length : new TextEncoder().encode(code).byteLength;
}

export function isCodeTooLarge(code: string) {
  return codeByteLength(code) > MAX_HIGHLIGHTED_CODE_BYTES;
}

function plainTree(code: string): HighlightNode {
  return { type: "root", children: code ? [{ type: "text", value: code }] : [] };
}

export function normalizeCodeLanguage(language?: string | null) {
  const normalized = language?.trim().toLowerCase() || "plaintext";
  const aliases: Record<string, string> = {
    cjs: "javascript", cmakelists: "cmake", conf: "ini", config: "ini", cs: "csharp",
    docker: "dockerfile", dotnet: "csharp", htm: "html", js: "javascript",
    jsx: "javascript", mjs: "javascript", plain: "plaintext", properties: "ini", proto: "protobuf", ps: "powershell",
    ps1: "powershell", psm1: "powershell", pwsh: "powershell", rb: "ruby", sc: "scala",
    sh: "bash", shell: "bash", sshd: "ini", sshd_config: "ini", text: "plaintext", tml: "toml",
    ts: "typescript", tsx: "typescript", txt: "plaintext", yml: "yaml",
  };
  return aliases[normalized] || normalized;
}

export function codeLanguageLabel(language?: string | null) {
  const normalized = normalizeCodeLanguage(language);
  return CODE_LANGUAGES.find((item) => item.value === normalized)?.label || language || "Plain text";
}

export function highlightCode(code: string, language?: string | null) {
  const normalized = normalizeCodeLanguage(language);
  const tooLarge = isCodeTooLarge(code);
  if (tooLarge || normalized === "plaintext" || !baseLowlight.registered(normalized)) {
    return { language: normalized, tooLarge, highlighted: false, tree: plainTree(code) };
  }
  try {
    return { language: normalized, tooLarge: false, highlighted: true, tree: baseLowlight.highlight(normalized, code) as HighlightNode };
  } catch {
    return { language: normalized, tooLarge: false, highlighted: false, tree: plainTree(code) };
  }
}

// Tiptap expects the Lowlight API. Wrapping it here gives editing and static
// rendering the same 100 KiB safety limit and unknown-language fallback.
export const editorLowlight = {
  ...baseLowlight,
  highlight(language: string, code: string) {
    return highlightCode(code, language).tree;
  },
  highlightAuto(code: string) {
    return highlightCode(code, "plaintext").tree;
  },
};

export function renderHighlightNodes(nodes: HighlightNode[] | undefined, keyPrefix = "code"): React.ReactNode {
  return (nodes ?? []).map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === "text") return node.value || "";
    const className = Array.isArray(node.properties?.className)
      ? node.properties.className.join(" ")
      : node.properties?.className;
    return <span className={className} key={key}>{renderHighlightNodes(node.children, key)}</span>;
  });
}

export function StaticCodeBlock({ code, language }: { code: string; language?: string | null }) {
  const result = useMemo(() => highlightCode(code, language), [code, language]);
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be unavailable in insecure browser contexts.
    }
  };
  return <div className={`ygdria-code-block${result.tooLarge ? " is-large-plain" : ""}`} data-language={result.language}>
    <div className="ygdria-code-block-toolbar">
      <span>{codeLanguageLabel(result.language)}{result.tooLarge ? " · plain" : ""}</span>
      <button type="button" onClick={copy} title={copied ? "已复制 / Copied" : "复制代码 / Copy code"} aria-label={copied ? "已复制 / Copied" : "复制代码 / Copy code"}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
    <div className="ygdria-code-block-body">
      <div className="ygdria-code-block-gutter" aria-hidden="true">
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <pre><code>{renderHighlightNodes(result.tree.children)}</code></pre>
    </div>
  </div>;
}
