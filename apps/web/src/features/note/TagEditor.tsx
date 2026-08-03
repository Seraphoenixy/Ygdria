import { useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { TAG_MAX_COUNT, TAG_MAX_LENGTH } from "@ygdria/shared";
import { t, type Locale } from "../../lib/i18n";

export function TagEditor({
  tags,
  locale,
  onChange,
}: {
  tags: string[];
  locale: Locale;
  onChange: (tags: string[]) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setInputValue("");
      setError(null);
      return;
    }
    if (trimmed.length > TAG_MAX_LENGTH) {
      setError(t(locale, "tagTooLong"));
      return;
    }
    if (tags.includes(trimmed)) {
      setError(t(locale, "tagDuplicate"));
      setInputValue("");
      return;
    }
    if (tags.length >= TAG_MAX_COUNT) {
      setError(t(locale, "tagTooMany"));
      return;
    }
    setError(null);
    onChange([...tags, trimmed]);
    setInputValue("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
    setError(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag(inputValue);
    } else if (event.key === "Backspace" && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div className="tag-editor">
      <div className="tag-editor-tags">
        {tags.map((tag) => (
          <span key={tag} className="tag-badge">
            {tag}
            <button
              type="button"
              className="tag-badge-remove"
              onClick={() => removeTag(tag)}
              aria-label={`${t(locale, "removeTag")}: ${tag}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <input
        className="tag-editor-input"
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(event) => {
          setInputValue(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          // On phone WebViews the keyboard can cover a footer positioned at
          // the end of a long note. Let the browser bring it into view.
          requestAnimationFrame(() => inputRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
        }}
        onBlur={() => {
          addTag(inputValue);
        }}
        placeholder={tags.length >= TAG_MAX_COUNT ? t(locale, "tagMaxReached") : t(locale, "tagInputPlaceholder")}
        disabled={tags.length >= TAG_MAX_COUNT}
        aria-label={t(locale, "tagInputLabel")}
      />
      {error && <p className="tag-editor-error">{error}</p>}
    </div>
  );
}
